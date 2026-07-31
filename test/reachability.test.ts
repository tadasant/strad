import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import type { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import {
  ToolSurfaceMonitor,
  probeToolSurfaces,
} from "../src/gateway/reachability.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";

/**
 * The staging failure, reproduced end to end.
 *
 * A `supplementary-image` slug routed to `/secrets` on a bundle whose image does
 * not mount that path. Express answers `404 Cannot POST /secrets`, the adapter
 * throws, and before this the gateway returned `200 {"tools":[]}` — a transport
 * failure wearing the costume of a server with no tools. Nothing in the
 * deployment reported it; it had to be found by polling `tools/list`.
 *
 * So the fake bundle here is not a mock of an MCP server, it is a mock of the
 * WRONG one: an Express app that mounts `/mounted` and 404s everything else,
 * exactly like a stale bundle image.
 */

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: healthy
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
  - slug: stale-mount
    kind: supplementary-image
    image: ghcr.io/example/bundle:latest
    bundle: bundle
    path: /not-mounted
    entitlements: [admin]
  - slug: policy-emptied
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
    tools:
      allow: [a_tool_this_server_does_not_have]
`);

const admin = mintToken({ env: "test", label: "admin", roles: ["admin"] });

let bundle: HttpServer;
let gateway: HttpServer;
let baseUrl: string;
let registry: Registry;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  // The stale bundle: one path mounted, everything else a 404 HTML page.
  const fake = express();
  fake.all("/mounted", (_req, res) => res.json({ ok: true }));
  bundle = await listen(fake);

  env = {
    STRAD_TOKENS: JSON.stringify([admin.record]),
    STRAD_INTERNAL_TOKEN: "internal",
    STRAD_BUNDLE_URL_BUNDLE: addressOf(bundle),
  };

  registry = await Registry.build({
    config: CONFIG,
    secrets: new EnvSecretProvider({}),
    mode: "core",
    env,
  });

  const monitor = new ToolSurfaceMonitor({ registry, timeoutMs: 5000 });
  await monitor.refresh();

  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    toolSurfaces: () => monitor.snapshot(),
  });
  gateway = await listen(app);
  baseUrl = addressOf(gateway);
});

afterAll(async () => {
  gateway?.close();
  bundle?.close();
  await registry?.close();
});

function listen(app: express.Express): Promise<HttpServer> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function addressOf(server: HttpServer): string {
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

async function connect(servers?: string): Promise<Client> {
  const url = new URL(`${baseUrl}/mcp`);
  if (servers) url.searchParams.set("servers", servers);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${admin.plaintext}` } },
    }),
  );
  return client;
}

describe("a requested server whose upstream cannot be listed", () => {
  it("fails the request instead of answering with an empty toolset", async () => {
    const client = await connect("stale-mount");
    await expect(client.listTools()).rejects.toThrow(
      /"stale-mount" was requested by name .*serving no tools/s,
    );
    await client.close();
  });

  it("does not relay the upstream's own error text to the client", async () => {
    const client = await connect("stale-mount");
    // The real one is a full HTML page from someone else's Express.
    await expect(client.listTools()).rejects.not.toThrow(
      /Cannot POST|DOCTYPE/i,
    );
    await client.close();
  });

  it("still fails when it is one of several named servers", async () => {
    const client = await connect("healthy,stale-mount");
    await expect(client.listTools()).rejects.toThrow(/"stale-mount"/);
    await client.close();
  });
});

describe("the unfiltered listing", () => {
  it("degrades rather than failing, so one sick server does not take the rest down", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((t) => t.name.startsWith("healthy__"))).toBe(true);
    expect(tools.some((t) => t.name.startsWith("stale-mount__"))).toBe(false);
    await client.close();
  });
});

describe("the boundary of the hard failure", () => {
  // Where the new rule STOPS. `policy-emptied` answers tools/list perfectly
  // well and its `tools:` allow-list then filters every tool away, so the
  // caller gets an empty list — and that is correct. The failure is a listing
  // that THREW, not a listing that came back short; conflating them would turn
  // every deny-everything policy into a 500.
  it("a named server that answers with no tools is an empty list, not an error", async () => {
    const client = await connect("policy-emptied");
    const { tools } = await client.listTools();
    expect(tools).toEqual([]);
    await client.close();
  });
});

describe("probeToolSurfaces", () => {
  it("separates a slug that serves tools from one that cannot be reached", async () => {
    const { snapshot, failures } = await probeToolSurfaces({
      registry,
      timeoutMs: 5000,
    });
    const byslug = new Map(snapshot.surfaces.map((s) => [s.slug, s]));

    expect(byslug.get("healthy")?.state).toBe("ok");
    expect(byslug.get("healthy")?.tools).toBeGreaterThan(0);
    expect(byslug.get("healthy")?.kind).toBe("builtin");
    expect(byslug.get("stale-mount")?.state).toBe("unreachable");
    expect(byslug.get("stale-mount")?.tools).toBe(0);
    // The kind is what lets the deploy gate tell "our component is broken" from
    // "someone else's server is having an afternoon".
    expect(byslug.get("stale-mount")?.kind).toBe("supplementary-image");
    expect(snapshot.degraded).toEqual(["stale-mount"]);
    // The upstream's message is available to the LOGGER and to nobody else.
    expect(failures.get("stale-mount")).toMatch(/stale-mount/);
  });

  it("classifies an upstream that never answers as unreachable, on its own deadline", async () => {
    // A wedged upstream, not a failing one: listTools() never settles. Without
    // withDeadline the probe hangs and the monitor silently stops reporting —
    // the failure mode it exists to catch.
    const wedged = {
      slugs: ["wedged"],
      get: () => ({
        slug: "wedged",
        kind: "remote-http" as const,
        listTools: () => new Promise<never>(() => {}),
        callTool: () => Promise.reject(new Error("unused")),
        close: () => Promise.resolve(),
      }),
      has: () => true,
      close: () => Promise.resolve(),
    };
    const started = Date.now();
    const { snapshot, failures } = await probeToolSurfaces({
      registry: wedged as unknown as Registry,
      timeoutMs: 100,
    });
    expect(snapshot.surfaces[0]?.state).toBe("unreachable");
    expect(failures.get("wedged")).toMatch(/did not answer within 100ms/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("calls a server that answers with no tools `empty`, not `unreachable`", async () => {
    const empty = {
      slugs: ["nothing"],
      get: () => ({
        slug: "nothing",
        kind: "builtin" as const,
        listTools: () => Promise.resolve([]),
        callTool: () => Promise.reject(new Error("unused")),
        close: () => Promise.resolve(),
      }),
      has: () => true,
      close: () => Promise.resolve(),
    };
    const { snapshot } = await probeToolSurfaces({
      registry: empty as unknown as Registry,
    });
    expect(snapshot.surfaces[0]?.state).toBe("empty");
    expect(snapshot.degraded).toEqual(["nothing"]);
  });
});

describe("ToolSurfaceMonitor", () => {
  it("says so out loud on the first probe, with a reason of its own authorship", async () => {
    const warnings: Record<string, unknown>[] = [];
    const logs: Record<string, unknown>[] = [];
    const monitor = new ToolSurfaceMonitor({
      registry,
      timeoutMs: 5000,
      warn: (e) => warnings.push(e),
      log: (e) => logs.push(e),
    });
    await monitor.refresh();

    const degraded = warnings.find((w) => w.slug === "stale-mount");
    expect(degraded).toBeDefined();
    expect(degraded?.evt).toBe("strad.tool_surface_degraded");
    expect(degraded?.state).toBe("unreachable");
    expect(String(degraded?.reason)).toMatch(/serves NOTHING/);
    // A healthy slug does not get a line of its own on the first probe.
    expect(warnings.some((w) => w.slug === "healthy")).toBe(false);
    expect(logs.some((l) => l.evt === "strad.tool_surface")).toBe(true);
  });

  it("does not repeat itself while the state is unchanged", async () => {
    const warnings: Record<string, unknown>[] = [];
    const monitor = new ToolSurfaceMonitor({
      registry,
      timeoutMs: 5000,
      warn: (e) => warnings.push(e),
      log: () => {},
    });
    await monitor.refresh();
    const afterFirst = warnings.length;
    await monitor.refresh();
    await monitor.refresh();
    expect(warnings.length).toBe(afterFirst);
  });

  it("has no snapshot before the first probe", () => {
    const monitor = new ToolSurfaceMonitor({ registry });
    expect(monitor.snapshot()).toBeNull();
  });

  it("logs a recovery when a slug starts serving again", async () => {
    let dead = true;
    const flapping = {
      slugs: ["flapping"],
      get: () => ({
        slug: "flapping",
        kind: "supplementary-image" as const,
        listTools: () =>
          dead
            ? Promise.reject(new Error("upstream refused"))
            : Promise.resolve([{ name: "t", inputSchema: { type: "object" } }]),
        callTool: () => Promise.reject(new Error("unused")),
        close: () => Promise.resolve(),
      }),
      has: () => true,
      close: () => Promise.resolve(),
    };
    const logs: Record<string, unknown>[] = [];
    const monitor = new ToolSurfaceMonitor({
      registry: flapping as unknown as Registry,
      log: (e) => logs.push(e),
      warn: () => {},
    });

    await monitor.refresh();
    dead = false;
    await monitor.refresh();

    const recovered = logs.find(
      (l) => l.evt === "strad.tool_surface_recovered",
    );
    expect(recovered?.slug).toBe("flapping");
    expect(monitor.snapshot()?.degraded).toEqual([]);
  });

  it("keeps probing on a timer, and stops when told to", async () => {
    let probes = 0;
    const counting = {
      slugs: ["counted"],
      get: () => ({
        slug: "counted",
        kind: "builtin" as const,
        listTools: () => {
          probes += 1;
          return Promise.resolve([]);
        },
        callTool: () => Promise.reject(new Error("unused")),
        close: () => Promise.resolve(),
      }),
      has: () => true,
      close: () => Promise.resolve(),
    };
    const monitor = new ToolSurfaceMonitor({
      registry: counting as unknown as Registry,
      // Degraded (the slug is `empty`), so the RETRY interval is the one in
      // play — which is the interval a deploy converges on.
      retryIntervalMs: 5,
      intervalMs: 60_000,
      log: () => {},
      warn: () => {},
    });

    monitor.start();
    await waitFor(() => probes >= 3);
    monitor.stop();

    const afterStop = probes;
    await new Promise((r) => setTimeout(r, 40));
    // stop() means stop. A tick that was in flight must not re-arm.
    expect(probes).toBe(afterStop);
  });

  it("falls back to the steady interval rather than fast-probing a fault forever", async () => {
    let probes = 0;
    const alwaysEmpty = {
      slugs: ["counted"],
      get: () => ({
        slug: "counted",
        kind: "builtin" as const,
        listTools: () => {
          probes += 1;
          return Promise.resolve([]);
        },
        callTool: () => Promise.reject(new Error("unused")),
        close: () => Promise.resolve(),
      }),
      has: () => true,
      close: () => Promise.resolve(),
    };
    const monitor = new ToolSurfaceMonitor({
      registry: alwaysEmpty as unknown as Registry,
      retryIntervalMs: 5,
      retryProbes: 3,
      // Long enough that reaching it means the fast retries were exhausted.
      intervalMs: 60_000,
      log: () => {},
      warn: () => {},
    });

    monitor.start();
    await waitFor(() => probes >= 3);
    await new Promise((r) => setTimeout(r, 60));
    monitor.stop();
    // Three degraded probes spend the budget; the fourth waits out the steady
    // interval, which this test is far too short to reach.
    expect(probes).toBe(3);
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("/healthz", () => {
  it("names the slugs that are serving nothing, instead of only listing them", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    const body = (await res.json()) as {
      ok: boolean;
      servers: string[];
      degraded: string[];
      toolSurfaces: {
        observedAt: string;
        servers: { slug: string; state: string; kind: string }[];
      };
    };

    // Still 200, still liveness: a degraded upstream is not a reason for App
    // Platform to restart core.
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.servers).toContain("stale-mount");
    expect(body.degraded).toEqual(["stale-mount"]);
    expect(body.toolSurfaces.servers).toHaveLength(3);
    expect(body.toolSurfaces.observedAt).toMatch(/^\d{4}-/);
    expect(
      body.toolSurfaces.servers.find((s) => s.slug === "stale-mount"),
    ).toMatchObject({ state: "unreachable", kind: "supplementary-image" });
  });

  it("puts no upstream-authored text on this public, unauthenticated route", async () => {
    // The probe that motivated this file failed with a whole HTML error page
    // from someone else's Express. It belongs in our logs and nowhere else —
    // this route needs no token.
    const res = await fetch(`${baseUrl}/healthz`);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toMatch(/DOCTYPE|Cannot POST|<pre>/i);
  });

  it("omits the surface fields entirely when nothing is monitoring", async () => {
    const app = createApp({
      config: CONFIG,
      registry,
      tokenStore: tokenStoreFromConfig(CONFIG, env),
      mode: "core",
      env,
    });
    const server = await listen(app);
    const res = await fetch(`${addressOf(server)}/healthz`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty("degraded");
    expect(body).not.toHaveProperty("toolSurfaces");
    server.close();
  });
});
