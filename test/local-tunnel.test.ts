import {
  buildSecretProviders,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server as HttpServer } from "node:http";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseConfig } from "../src/config/load.ts";
import type { StradConfig } from "../src/config/schema.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";
import {
  HttpServerAdapter,
  LocalHostRefusedError,
  LocalHostUnavailableError,
  LocalMachineOfflineError,
  UpstreamError,
} from "../src/gateway/adapters/http.ts";
import { buildGatewayServer, listToolsFor } from "../src/gateway/mcpServer.ts";
import { probeToolSurfaces } from "../src/gateway/reachability.ts";
import { Registry } from "../src/gateway/registry.ts";
import { compileToolPolicies } from "../src/gateway/toolPolicy.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";

/**
 * `kind: local-tunnel` — an MCP server on a machine a human owns.
 *
 * The defining property is INTERMITTENCY: the machine is off much of the time,
 * by design, and that must not read as an outage anywhere. Every test here is
 * about the offline half, because the online half is `remote-http` and is
 * already covered — the same adapter, the same transport, the same code.
 */

const BASE = `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
`;

const servers: HttpServer[] = [];
const adapters: HttpServerAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.close()));
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

/** A port nothing is listening on — the shape of a laptop that is powered off. */
async function deadPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A host that ACCEPTS a connection and then never answers.
 *
 * This is the failure that actually hurts, and the one a request timeout alone
 * does not cover: undici will hold an accepted socket for its 300s headers
 * timeout, so without an abort on the handshake the gateway waits far past any
 * deadline it thinks it set. A closed laptop on a tunnel presents exactly this
 * way — the tunnel's edge accepts, the origin is gone.
 */
async function blackHole(): Promise<string> {
  const app = express();
  app.all(/.*/, () => {
    /* accept, and never respond */
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
}

/**
 * A host that ANSWERS, with the status you ask for.
 *
 * The machine is up: it accepted, routed and replied. Whatever went wrong is a
 * config error or a crash, and calling it "your machine is off" both misnames
 * it and — because an offline verdict is what `listToolsFor` may silently drop
 * — makes it vanish from a listing that ought to have failed.
 */
async function answersWith(status: number): Promise<string> {
  const app = express();
  app.all(/.*/, (_req, res) => {
    res.status(status).send(status === 404 ? "Cannot POST /wrong" : "boom");
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
}

function tunnelAdapter(url: string, connectTimeoutMs = 750): HttpServerAdapter {
  const adapter = new HttpServerAdapter({
    slug: "anki",
    kind: "local-tunnel",
    endpoint: async () => ({ url, headers: {} }),
    timeoutMs: 120_000,
    connectTimeoutMs,
  });
  adapters.push(adapter);
  return adapter;
}

describe("local-tunnel config", () => {
  it("accepts a tunnel URL and nothing else — no bundle, no image", () => {
    const cfg = parseConfig(`${BASE}
servers:
  - slug: anki
    kind: local-tunnel
    url: https://sleepy-cat.trycloudflare.com/mcp
    entitlements: [admin]
`);
    const server = cfg.servers[0];
    expect(server?.kind).toBe("local-tunnel");
    // The whole point of the type: adding the second and third one (computer
    // use, browser automation) is a config entry, not a code change.
    expect(server).toMatchObject({
      slug: "anki",
      url: "https://sleepy-cat.trycloudflare.com/mcp",
    });
  });

  it("defaults connectTimeoutMs to 5s — bounded without anyone having to say so", () => {
    const cfg = parseConfig(`${BASE}
servers:
  - { slug: anki, kind: local-tunnel, url: "https://x.example/mcp", entitlements: [admin] }
`);
    const server = cfg.servers[0];
    expect(server?.kind === "local-tunnel" && server.connectTimeoutMs).toBe(
      5_000,
    );
    // The RUN budget is untouched: driving a browser on someone's laptop is
    // legitimately slow, and only the handshake is held to a short leash.
    expect(server?.timeoutMs).toBe(120_000);
  });

  it("occupies no bundle, so it needs none declared", () => {
    // `remote-http` is skipped from the bundle-occupancy rules because it has no
    // `bundle` field; a new kind that also has none would otherwise key that map
    // on `undefined` and invent a component out of nothing.
    expect(() =>
      parseConfig(`${BASE}
servers:
  - { slug: anki, kind: local-tunnel, url: "https://x.example/mcp", entitlements: [admin] }
`),
    ).not.toThrow();
  });

  it("renders no App Platform component — strad deploys nothing for it", () => {
    const cfg = parseConfig(`${BASE}
servers:
  - { slug: anki, kind: local-tunnel, url: "https://x.example/mcp", entitlements: [admin] }
`);
    const spec = renderAppSpec({
      config: cfg,
      appName: "strad-test",
      region: "nyc",
      image: {
        registry_type: "GHCR",
        registry: "tadasant",
        repository: "strad",
        tag: "sha-abc",
      },
      env: [],
      secrets: {},
    });
    expect(spec.services.map((s) => s.name)).toEqual(["core"]);
  });

  it("rejects an unknown role like any other kind", () => {
    expect(() =>
      parseConfig(`${BASE}
servers:
  - { slug: anki, kind: local-tunnel, url: "https://x.example/mcp", entitlements: [ghost] }
`),
    ).toThrow(/unknown role "ghost"/);
  });
});

describe("an offline machine", () => {
  it("fails as a LocalMachineOfflineError, naming the slug", async () => {
    const adapter = tunnelAdapter(`http://127.0.0.1:${await deadPort()}/mcp`);

    await expect(adapter.listTools()).rejects.toThrow(LocalMachineOfflineError);
    await expect(adapter.listTools()).rejects.toThrow(
      /the machine hosting "anki" is not reachable/,
    );
    // Still an UpstreamError, so every existing catch, retire and telemetry
    // path keeps treating it the way it always has. Only the words differ.
    await expect(adapter.listTools()).rejects.toThrow(UpstreamError);
  });

  it("gives up on a black hole in about connectTimeoutMs, not 60s", async () => {
    const adapter = tunnelAdapter(await blackHole(), 750);

    const startedAt = Date.now();
    await expect(adapter.listTools()).rejects.toThrow(LocalMachineOfflineError);
    const elapsed = Date.now() - startedAt;

    // The bound that matters. Without an abort on the handshake this sits on an
    // accepted socket until the SDK's 60s request timeout — the "not a hang"
    // requirement, asserted rather than asserted-about.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("says nothing about the upstream, because there is no upstream to quote", async () => {
    const adapter = tunnelAdapter(`http://127.0.0.1:${await deadPort()}/mcp`);

    const err = await adapter.listTools().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalMachineOfflineError);
    // strad's own words, start to finish. That is what makes it safe to relay
    // to a client verbatim — see the note in gateway/mcpServer.ts.
    expect((err as Error).message).toMatch(/local-tunnel server/);
    expect((err as Error).message).toMatch(/Nothing is wrong with strad/);
  });
});

describe("blast radius", () => {
  const CONFIG = (tunnelUrl: string) =>
    parseConfig(`${BASE}
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
  - slug: anki
    kind: local-tunnel
    url: "${tunnelUrl}"
    connectTimeoutMs: 750
    entitlements: [admin]
`);

  async function registryWithDeadTunnel(): Promise<Registry> {
    const config = CONFIG(`http://127.0.0.1:${await deadPort()}/mcp`);
    return Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: {},
    });
  }

  it("does not take a healthy server down with it", async () => {
    const registry = await registryWithDeadTunnel();
    const policies = compileToolPolicies(parseConfig(`${BASE}\nservers: []\n`));

    // The case the whole exemption exists for: one ?servers= naming a laptop
    // that is asleep AND a server that is up. Before this, the named-server rule
    // failed the entire listing and the healthy server became unusable.
    const tools = await listToolsFor(
      ["anki", "echo"],
      registry,
      policies,
      () => {},
      { onUnlistable: () => {} },
    );

    expect(tools.map((t) => t.name)).toContain("echo__echo");
    // The laptop contributes its troubleshooting tool and NONE of its own.
    expect(tools.filter((t) => t.name.startsWith("anki__")).map((t) => t.name)) //
      .toEqual(["anki__troubleshoot_host"]);
    await registry.close();
  });

  it("answers with the troubleshooting tool when the offline machine is the ONLY thing selected", async () => {
    const registry = await registryWithDeadTunnel();
    const policies = compileToolPolicies(parseConfig(`${BASE}\nservers: []\n`));

    // The case a human actually hits — the console hands out one
    // ?servers=<slug> per server, so this is the playground with the laptop
    // asleep. An empty toolset would read as "Anki offers no tools" and an
    // error gives a client nothing to do; one tool that says what to run is
    // both honest and actionable.
    const tools = await listToolsFor(["anki"], registry, policies, () => {}, {
      onUnlistable: () => {},
    });

    expect(tools.map((t) => t.name)).toEqual(["anki__troubleshoot_host"]);
    expect(tools[0]?.description).toMatch(
      /THIS SERVER'S OWN TOOLS ARE NOT AVAILABLE/,
    );
    await registry.close();
  });

  it("leaves an unnamed listing alone: contributes nothing, breaks nothing", async () => {
    const registry = await registryWithDeadTunnel();
    const policies = compileToolPolicies(parseConfig(`${BASE}\nservers: []\n`));

    // No `explicit` — the "everything I'm entitled to" listing. One sick server
    // has never broken this one; what is new is that it now says so instead of
    // leaving a gap.
    const tools = await listToolsFor(
      ["anki", "echo"],
      registry,
      policies,
      () => {},
    );
    expect(tools.map((t) => t.name)).toContain("echo__echo");
    expect(tools.map((t) => t.name)).toContain("anki__troubleshoot_host");
    await registry.close();
  });

  it("does NOT relax the rule for a broken server of any other kind", async () => {
    // The regression guard. The exemption is scoped to an offline local-tunnel
    // and nothing else: a `supplementary-image` that cannot be listed is still
    // a failure that fails the request, which is what stopped a dead `secrets`
    // slug from hiding behind `200 {"tools":[]}`.
    const config = parseConfig(`${BASE}
bundles:
  - name: bundle
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
  - slug: broken
    kind: supplementary-image
    image: "ghcr.io/o/x:1"
    bundle: bundle
    path: /nope
    entitlements: [admin]
`);
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: { STRAD_BUNDLE_URL_BUNDLE: `http://127.0.0.1:${await deadPort()}` },
    });
    const policies = compileToolPolicies(config);

    await expect(
      listToolsFor(["broken", "echo"], registry, policies, () => {}, {
        onUnlistable: () => {},
      }),
    ).rejects.toThrow(/requested by name but its upstream could not be listed/);
    await registry.close();
  });
});

describe("a machine that is UP but wrong", () => {
  // The distinction this whole predicate exists for. An offline verdict is not
  // just a nicer error message — it is a licence for `listToolsFor` to drop the
  // slug from an explicit listing without failing it. Handing that licence to
  // every failure would reinstate exactly the bug the named-server rule fixed.

  it("does not call a 404 an offline machine — that is a wrong path", async () => {
    const adapter = tunnelAdapter(await answersWith(404));
    const err = await adapter.listTools().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).not.toBeInstanceOf(LocalMachineOfflineError);
  });

  it("does not call a 500 an offline machine — the server ran and threw", async () => {
    const adapter = tunnelAdapter(await answersWith(500));
    const err = await adapter.listTools().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(LocalMachineOfflineError);
  });

  it("DOES call a tunnel-edge 502 offline — that is the commonest shape of all", async () => {
    // Cloudflare answers 530 (and a plain proxy 502) when the hostname is still
    // registered but the origin has gone. It is an HTTP response, and it means
    // precisely "the machine is not there".
    const adapter = tunnelAdapter(await answersWith(502));
    const err = await adapter.listTools().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalMachineOfflineError);
  });

  it("claims no duration when no deadline expired", async () => {
    // "no answer within 5000ms" about a connection refused in a millisecond
    // sends someone looking for a slow network. Say nothing rather than that.
    const adapter = tunnelAdapter(`http://127.0.0.1:${await deadPort()}/mcp`);
    const err = await adapter.listTools().catch((e: unknown) => e);
    expect((err as Error).message).not.toMatch(/within \d+ms/);
    expect((err as Error).message).toMatch(/is not reachable/);
  });

  it("a wrong path still FAILS an explicit listing, taking its peers with it", async () => {
    const url = await answersWith(404);
    const config = parseConfig(`${BASE}
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
  - slug: anki
    kind: local-tunnel
    url: "${url}"
    connectTimeoutMs: 750
    entitlements: [admin]
`);
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: {},
    });
    const policies = compileToolPolicies(config);

    await expect(
      listToolsFor(["anki", "echo"], registry, policies, () => {}, {
        onUnlistable: () => {},
      }),
    ).rejects.toThrow(/requested by name but its upstream could not be listed/);
    await registry.close();
  });
});

describe("a machine that goes away mid-session", () => {
  it("reads as offline on the FIRST request, not the second", async () => {
    // The connection is cached, so shutting a laptop is discovered by a request
    // running on a socket that has just died — not by a fresh handshake. If the
    // offline verdict were scoped to the handshake, the first request after
    // someone closes their laptop (the commonest moment there is) would get a
    // generic upstream error and only the retry would explain itself.
    const app = express();
    let alive = true;
    const mcp = new McpServer(
      { name: "standin", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    mcp.tool("ping", "ping", {}, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    app.post(/.*/, (req, res) => {
      void (async () => {
        if (!alive) {
          req.socket.destroy();
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => void transport.close());
        await mcp.server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      })();
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;

    const adapter = tunnelAdapter(`http://127.0.0.1:${port}/mcp`);
    expect((await adapter.listTools()).map((t) => t.name)).toEqual(["ping"]);

    alive = false; // the lid closes, on a connection that is already open
    const err = await adapter.listTools().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalMachineOfflineError);
  });
});

describe("an empty result is never silently returned", () => {
  it("still says something when the only other named server serves nothing", async () => {
    // `?servers=anki,quiet` with the laptop asleep and `quiet` legitimately
    // serving zero tools. The failure mode to avoid is `{"tools":[]}` with no
    // hint that a machine was skipped — which is now impossible, because the
    // skipped machine leaves a tool behind rather than a gap.
    const config = parseConfig(`${BASE}
servers:
  - slug: quiet
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
    tools: { deny: [echo, whoami] }
  - slug: anki
    kind: local-tunnel
    url: "http://127.0.0.1:${await deadPort()}/mcp"
    connectTimeoutMs: 750
    entitlements: [admin]
`);
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: {},
    });
    const policies = compileToolPolicies(config);

    const tools = await listToolsFor(
      ["anki", "quiet"],
      registry,
      policies,
      () => {},
      { onUnlistable: () => {} },
    );
    expect(tools.map((t) => t.name)).toEqual(["anki__troubleshoot_host"]);
    await registry.close();
  });
});

describe("every failing slug is reported, not just the first", () => {
  it("calls onUnlistable for each broken named server", async () => {
    // `onUnlistable` drives a per-slug metric. Reporting only the first would
    // make the second dead bundle in a two-bundle outage invisible to the
    // counter that exists to find it.
    const config = parseConfig(`${BASE}
bundles:
  - name: b1
  - name: b2
servers:
  - { slug: broken-a, kind: supplementary-image, image: "ghcr.io/o/x:1", bundle: b1, path: /a, entitlements: [admin] }
  - { slug: broken-b, kind: supplementary-image, image: "ghcr.io/o/y:1", bundle: b2, path: /b, entitlements: [admin] }
`);
    const dead = await deadPort();
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: {
        STRAD_BUNDLE_URL_B1: `http://127.0.0.1:${dead}`,
        STRAD_BUNDLE_URL_B2: `http://127.0.0.1:${dead}`,
      },
    });
    const policies = compileToolPolicies(config);
    const unlistable: string[] = [];

    await expect(
      listToolsFor(["broken-a", "broken-b"], registry, policies, () => {}, {
        onUnlistable: (slug) => unlistable.push(slug),
      }),
    ).rejects.toThrow();
    expect(unlistable.sort()).toEqual(["broken-a", "broken-b"]);
    await registry.close();
  });
});

describe("the troubleshooting surface", () => {
  /**
   * A machine that is off is not an outage, it is a person's laptop — and the
   * only useful thing to say about it is what to run on it. These cover the
   * whole path: config -> listing -> a real MCP client calling the tool.
   */

  const RECOVERY = `
    recovery:
      machine: "Tadas's MacBook"
      commands:
        - "launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared"
        - "open -a Anki"
      notes: "Anki itself must be open — the MCP server lives inside the app."
`;

  async function tunnelRegistry(
    url: string,
    extra = RECOVERY,
  ): Promise<{ registry: Registry; config: StradConfig }> {
    const config = parseConfig(`${BASE}
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
  - slug: anki
    kind: local-tunnel
    url: "${url}"
    connectTimeoutMs: 750
    entitlements: [admin]${extra}
`);
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: {},
    });
    return { registry, config };
  }

  /** A real MCP client over the gateway server, as `/mcp` and the console build it. */
  async function connect(
    registry: Registry,
    config: StradConfig,
    selected: string[],
  ): Promise<Client> {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = buildGatewayServer({
      config,
      registry,
      policies: compileToolPolicies(config),
      mode: "core",
      selected,
      principalId: "test",
      log: () => {},
      explicit: { onUnlistable: () => {} },
    });
    const client = new Client({ name: "test", version: "1" }, {});
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return client;
  }

  it("names the machine in the tool it offers", async () => {
    const { registry, config } = await tunnelRegistry(
      `http://127.0.0.1:${await deadPort()}/mcp`,
    );
    const client = await connect(registry, config, ["anki"]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["anki__troubleshoot_host"]);
    // The description carries the outage, because a name cannot: a client that
    // renders nothing but names and descriptions still communicates it.
    expect(tools[0]?.description).toMatch(/Tadas's MacBook/);
    expect(tools[0]?.description).toMatch(/not answering/);
    // No arguments to get wrong.
    expect(tools[0]?.inputSchema.properties).toEqual({});

    await client.close();
    await registry.close();
  });

  it("returns the exact commands to run on that machine", async () => {
    const { registry, config } = await tunnelRegistry(
      `http://127.0.0.1:${await deadPort()}/mcp`,
    );
    const client = await connect(registry, config, ["anki"]);

    const res = (await client.callTool({
      name: "anki__troubleshoot_host",
      arguments: {},
    })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content[0]!.text;

    // The whole point of the feature, asserted literally.
    expect(text).toMatch(/launchctl kickstart -k gui\/\$\(id -u\)/);
    expect(text).toMatch(/open -a Anki/);
    expect(text).toMatch(/Tadas's MacBook/);
    expect(text).toMatch(/the MCP server lives inside the app/);
    // Diagnosing a failure is not itself a failure.
    expect(res.isError).toBeFalsy();

    await client.close();
    await registry.close();
  });

  it("says so when the machine has come back since the listing", async () => {
    // The gap between listing and call is exactly when somebody is running the
    // commands, so the tool re-checks rather than replaying a stale verdict.
    const app = express();
    const mcp = new McpServer(
      { name: "standin", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    mcp.tool("ping", "ping", {}, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    app.post(/.*/, (req, res) => {
      void (async () => {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => void transport.close());
        await mcp.server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      })();
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;

    const { registry, config } = await tunnelRegistry(
      `http://127.0.0.1:${port}/mcp`,
    );
    const client = await connect(registry, config, ["anki"]);

    // The machine is up, so the listing is the real toolset — and the tool is
    // still answerable, which is what someone who just ran the commands does.
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "anki__ping",
    ]);
    const res = (await client.callTool({
      name: "anki__troubleshoot_host",
      arguments: {},
    })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toMatch(/answering again/);
    expect(res.content[0]!.text).toMatch(/serving 1 tool/);

    await client.close();
    await registry.close();
  });

  it("falls back to generic guidance, and invents no commands", async () => {
    // No `recovery:` block. A tunnel name guessed from a hostname is right often
    // enough to be trusted and wrong often enough to waste an afternoon, so the
    // honest generic answer is the one that ships.
    const { registry, config } = await tunnelRegistry(
      `http://127.0.0.1:${await deadPort()}/mcp`,
      "",
    );
    const client = await connect(registry, config, ["anki"]);

    const res = (await client.callTool({
      name: "anki__troubleshoot_host",
      arguments: {},
    })) as { content: { text: string }[] };
    const text = res.content[0]!.text;
    expect(text).toMatch(/No recovery commands are configured/);
    expect(text).toMatch(/local-tunnel-host/);
    expect(text).not.toMatch(/cloudflared tunnel run/);

    await client.close();
    await registry.close();
  });

  it("does not resolve a ${REF} url to put a hostname in a tool result", async () => {
    // `url:` may be a secret ref, and this text goes to every entitled client.
    // "which laptop is this" is worth a sentence and is not worth reading a
    // secret to answer.
    const config = parseConfig(`${BASE}
servers:
  - slug: anki
    kind: local-tunnel
    url: "https://\${ANKI_TUNNEL_HOST}/mcp"
    entitlements: [admin]
`);
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(
        new EnvSecretProvider({ ANKI_TUNNEL_HOST: "secret.example" }),
      ),
      mode: "core",
      env: {},
    });
    // Neither the ref nor the value it resolves to. A hostname is worth a
    // sentence, and is not worth reading a secret to write it.
    expect(registry.get("anki")?.host?.hostname).toBeUndefined();
    await registry.close();
  });

  it("keeps /healthz honest: an offline machine is still unreachable", async () => {
    // The tool is a courtesy to CLIENTS. If it also made the reachability
    // monitor read `ok`, a laptop being shut would look like a healthy fleet
    // and the deploy gate would lose a signal it is built on.
    const { registry } = await tunnelRegistry(
      `http://127.0.0.1:${await deadPort()}/mcp`,
    );
    const { snapshot } = await probeToolSurfaces({
      registry,
      slugs: ["anki"],
      timeoutMs: 3_000,
    });
    expect(snapshot.surfaces[0]).toMatchObject({
      slug: "anki",
      state: "unreachable",
      tools: 0,
      kind: "local-tunnel",
    });
    await registry.close();
  });

  it("survives a tools: allow list written for the real toolset", async () => {
    // The trap this exists to avoid: an `allow:` list names the machine's real
    // tools, the machine goes off, and the policy filters away the one tool
    // that would have explained it — reinstating the silence exactly.
    const config = parseConfig(`${BASE}
servers:
  - slug: anki
    kind: local-tunnel
    url: "http://127.0.0.1:${await deadPort()}/mcp"
    connectTimeoutMs: 750
    entitlements: [admin]
    tools: { allow: [list_decks] }
    recovery:
      commands: ["launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared"]
`);
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: {},
    });
    const client = await connect(registry, config, ["anki"]);

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "anki__troubleshoot_host",
    ]);
    // ...and it must be CALLABLE too. Listing a tool and then refusing it is
    // the worst of both.
    const res = (await client.callTool({
      name: "anki__troubleshoot_host",
      arguments: {},
    })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toMatch(/launchctl kickstart/);

    await client.close();
    await registry.close();
  });

  it("offers nothing of the sort for a kind strad deploys", async () => {
    // The licence is scoped to a machine somebody owns. A supplementary image
    // that cannot be listed is a deploy failure, and there is no laptop to go
    // and switch on.
    const config = parseConfig(`${BASE}
bundles:
  - name: bundle
servers:
  - { slug: broken, kind: supplementary-image, image: "ghcr.io/o/x:1", bundle: bundle, path: /nope, entitlements: [admin] }
`);
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: { STRAD_BUNDLE_URL_BUNDLE: `http://127.0.0.1:${await deadPort()}` },
    });
    expect(registry.get("broken")?.host).toBeUndefined();
    await expect(
      listToolsFor(
        ["broken"],
        registry,
        compileToolPolicies(config),
        () => {},
        { onUnlistable: () => {} },
      ),
    ).rejects.toThrow(/requested by name but its upstream could not be listed/);
    await registry.close();
  });
});

describe("a host that REFUSES, which is not a host that is off", () => {
  /**
   * The asymmetry this closes. A 403 used to fail the entire `?servers=`
   * listing, taking healthy servers with it — on the reasoning that a broken
   * credential which silently removes one server from a fleet goes unnoticed for
   * weeks. That reasoning was about SILENCE, and there is none left: the slug
   * now says out loud that it was refused, and says it is a credential rather
   * than a laptop. So it degrades like an offline machine, with a different
   * remedy.
   */

  const CONFIG = (url: string) =>
    parseConfig(`${BASE}
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
  - slug: anki
    kind: local-tunnel
    url: "${url}"
    connectTimeoutMs: 750
    entitlements: [admin]
    recovery:
      machine: "Tadas's MacBook"
      commands: ["cloudflared tunnel info anki"]
`);

  it("is its own error, and says the machine is answering", async () => {
    const adapter = tunnelAdapter(await answersWith(403));
    const err = await adapter.listTools().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LocalHostRefusedError);
    expect(err).toBeInstanceOf(LocalHostUnavailableError);
    // NOT the offline verdict. Telling someone to restart a tunnel that is
    // working is how an afternoon disappears.
    expect(err).not.toBeInstanceOf(LocalMachineOfflineError);
    expect((err as Error).message).toMatch(/refused strad's credentials/);
    expect((err as Error).message).toMatch(/It is ANSWERING/);
  });

  it("no longer takes the whole listing down with it", async () => {
    const config = CONFIG(await answersWith(403));
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: {},
    });

    const tools = await listToolsFor(
      ["anki", "echo"],
      registry,
      compileToolPolicies(config),
      () => {},
      { onUnlistable: () => {} },
    );
    expect(tools.map((t) => t.name)).toContain("echo__echo");
    expect(tools.map((t) => t.name)).toContain("anki__troubleshoot_host");
    await registry.close();
  });

  it("prescribes the credential, not the tunnel", async () => {
    const config = CONFIG(await answersWith(403));
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: {},
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = buildGatewayServer({
      config,
      registry,
      policies: compileToolPolicies(config),
      mode: "core",
      selected: ["anki"],
      principalId: "test",
      log: () => {},
      explicit: { onUnlistable: () => {} },
    });
    const client = new Client({ name: "test", version: "1" }, {});
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const res = (await client.callTool({
      name: "anki__troubleshoot_host",
      arguments: {},
    })) as { content: { text: string }[] };
    const text = res.content[0]!.text;
    expect(text).toMatch(/REFUSED strad's credentials/);
    expect(text).toMatch(/It is not off/);
    expect(text).toMatch(/token/);

    await client.close();
    await registry.close();
  });

  it("still hard-fails a 404, which no command on that machine fixes", async () => {
    // The boundary of the licence. A wrong path is strad's own config error,
    // and a machine's owner cannot fix it — so it stays a failure.
    const config = CONFIG(await answersWith(404));
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: {},
    });
    await expect(
      listToolsFor(
        ["anki", "echo"],
        registry,
        compileToolPolicies(config),
        () => {},
        { onUnlistable: () => {} },
      ),
    ).rejects.toThrow(/requested by name but its upstream could not be listed/);
    await registry.close();
  });
});

describe("reachability", () => {
  it("reports the kind, so a consumer can tell a laptop from an outage", async () => {
    const config = parseConfig(`${BASE}
servers:
  - { slug: anki, kind: local-tunnel, url: "http://127.0.0.1:1/mcp", entitlements: [admin] }
`);
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: {},
    });

    // `kind` riding along on the snapshot is what lets `/healthz`, the deploy
    // gate and the console each decide for themselves whether an unreachable
    // slug is anybody's problem. For this kind it is nobody's.
    expect(registry.get("anki")?.kind).toBe("local-tunnel");
    await registry.close();
  });
});

describe("credentials come from the server's OWN namespace", () => {
  /**
   * THE CASE THIS KIND EXISTS TO SERVE, end to end.
   *
   * A tunnel in front of a machine you own is locked down with Cloudflare Access
   * service-token headers plus an app-level bearer, so a `local-tunnel` entry
   * carries three credentials that belong to exactly one server. They had
   * nowhere to live but `/strad/{env}/gateway/static/`: strad runs no container
   * for an unhosted kind, so `params: true` and the render-time `env:` layer are
   * both closed to it, and the runtime provider read one namespace.
   *
   * This asserts the whole path — config -> registry -> adapter -> wire — rather
   * than the provider in isolation, because the provider was never the part in
   * doubt. The part in doubt was whether the registry hands each server its own.
   */
  it("sends headers resolved from /strad/{env}/mcp/{slug}/static/", async () => {
    const seen: Record<string, string | undefined> = {};
    const app = express();
    const mcp = new McpServer(
      { name: "standin", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    mcp.tool("ping", "ping", {}, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    app.post(/.*/, (req, res) => {
      void (async () => {
        seen["cf-access-client-id"] = req.headers["cf-access-client-id"] as
          string | undefined;
        seen["cf-access-client-secret"] = req.headers[
          "cf-access-client-secret"
        ] as string | undefined;
        seen.authorization = req.headers.authorization;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => void transport.close());
        await mcp.server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      })();
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;

    const config = parseConfig(`
version: 1
gateway:
  name: strad
  env: test
  secrets:
    provider: gcp-parameter-store
    envFallback: false
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: anki
    kind: local-tunnel
    url: "http://127.0.0.1:${port}/mcp"
    entitlements: [admin]
    headers:
      CF-Access-Client-Id: "\${ANKI_CF_ACCESS_CLIENT_ID}"
      CF-Access-Client-Secret: "\${ANKI_CF_ACCESS_CLIENT_SECRET}"
      Authorization: "Bearer \${ANKI_MCP_API_KEY}"
`);

    // Seeded EXACTLY where Tadas seeded them in prod, and nowhere else. The
    // gateway namespace holds a decoy for one of the three: a shared value must
    // lose to the server's own.
    const resolver = {
      async resolve(namespace: string): Promise<Record<string, string>> {
        if (namespace === "/strad/test/mcp/anki/static/") {
          return {
            ANKI_CF_ACCESS_CLIENT_ID: "id.access",
            ANKI_CF_ACCESS_CLIENT_SECRET: "sekret",
            ANKI_MCP_API_KEY: "bearer-mine",
          };
        }
        if (namespace === "/strad/test/gateway/static/") {
          return { ANKI_MCP_API_KEY: "bearer-shared" };
        }
        return {};
      },
    };

    const registry = await Registry.build({
      config,
      secrets: buildSecretProviders({ config, env: {}, resolver }),
      mode: "core",
      env: {},
    });
    try {
      const adapter = registry.get("anki")!;
      expect((await adapter.listTools()).map((t) => t.name)).toEqual(["ping"]);
      expect(seen["cf-access-client-id"]).toBe("id.access");
      expect(seen["cf-access-client-secret"]).toBe("sekret");
      expect(seen.authorization).toBe("Bearer bearer-mine");
    } finally {
      await registry.close();
    }
  });
});
