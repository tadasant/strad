import express from "express";
import type { Server as HttpServer } from "node:http";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";
import {
  HttpServerAdapter,
  LocalMachineOfflineError,
  UpstreamError,
} from "../src/gateway/adapters/http.ts";
import { listToolsFor } from "../src/gateway/mcpServer.ts";
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
      secrets: new EnvSecretProvider({}),
      mode: "core",
      env: {},
    });
  }

  it("does not take a healthy server down with it", async () => {
    const registry = await registryWithDeadTunnel();
    const policies = compileToolPolicies(
      parseConfig(`${BASE}\nservers: []\n`),
    );

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
    expect(tools.some((t) => t.name.startsWith("anki__"))).toBe(false);
    await registry.close();
  });

  it("still fails when the offline machine is the ONLY thing selected", async () => {
    const registry = await registryWithDeadTunnel();
    const policies = compileToolPolicies(
      parseConfig(`${BASE}\nservers: []\n`),
    );

    // An empty toolset here would read as "Anki offers no tools", which is both
    // false and unactionable — the exact confusion the named-server rule exists
    // to prevent. So this one still throws, and says why.
    await expect(
      listToolsFor(["anki"], registry, policies, () => {}, {
        onUnlistable: () => {},
      }),
    ).rejects.toThrow(/the machine hosting "anki" is not reachable/);
    await registry.close();
  });

  it("leaves an unnamed listing alone: contributes nothing, breaks nothing", async () => {
    const registry = await registryWithDeadTunnel();
    const policies = compileToolPolicies(
      parseConfig(`${BASE}\nservers: []\n`),
    );

    // No `explicit` — the "everything I'm entitled to" listing. Unchanged
    // behaviour, and it already did the right thing for a dead upstream.
    const tools = await listToolsFor(
      ["anki", "echo"],
      registry,
      policies,
      () => {},
    );
    expect(tools.map((t) => t.name)).toContain("echo__echo");
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
      secrets: new EnvSecretProvider({}),
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

describe("reachability", () => {
  it("reports the kind, so a consumer can tell a laptop from an outage", async () => {
    const config = parseConfig(`${BASE}
servers:
  - { slug: anki, kind: local-tunnel, url: "http://127.0.0.1:1/mcp", entitlements: [admin] }
`);
    const registry = await Registry.build({
      config,
      secrets: new EnvSecretProvider({}),
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
