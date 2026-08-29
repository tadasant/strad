import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { probeToolSurfaces } from "../src/gateway/reachability.ts";
import { Registry } from "../src/gateway/registry.ts";
import { ServerUnconfiguredError } from "../src/gateway/unconfigured.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import { gatewayParameterPath } from "../src/secrets/parameters/namespace.ts";
import {
  sharedSecretProviders,
  StoreSecretProvider,
} from "../src/secrets/provider/index.ts";
import { errorKind } from "../src/telemetry/index.ts";

/**
 * THE RUNTIME HALF, END TO END.
 *
 * The deploy no longer fails on a credential a human deferred, so a running
 * gateway now has to hold a state it never held before: a slug it cannot resolve
 * a credential for, which is not broken, will not fix itself, and must not drag
 * anything else down.
 *
 * Three claims, and every one of them is a thing Tadas asked for in words:
 *
 *   1. the slug is INACTIVE, and inactive FOR THIS REASON — distinguishable from
 *      an upstream that is down and from a slug nobody is entitled to;
 *   2. every other server is untouched — no empty listing, no 500, no `degraded`;
 *   3. it ACTIVATES ON ITS OWN once the value lands, with no redeploy and no
 *      restart. This file proves that by seeding into a store a RUNNING gateway
 *      is already holding, advancing only the clock, and asking again.
 *
 * Nothing is mocked at the seam under test. A real MCP client talks to a real
 * strad app over HTTP, which proxies to a real MCP upstream, resolving its
 * credential out of the in-memory Parameter Manager + Secret Manager fake.
 */

const ENV = "test";
const GRANOLA_TOKEN = "granola-token";
const APIFY_TOKEN = "apify-token";

/** A real MCP upstream that accepts exactly one bearer token. */
function startUpstream(
  name: string,
  accepted: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req: Request, res: Response) => {
    if (req.headers.authorization !== `Bearer ${accepted}`) {
      res.status(401).json({ error: "bad token" });
      return;
    }
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const existing = sid ? transports[sid] : undefined;
    if (existing) {
      await existing.handleRequest(req, res, req.body);
      return;
    }
    if (!sid && isInitializeRequest(req.body)) {
      const server = new McpServer(
        { name, version: "0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "ping",
            description: `${name} ping`,
            inputSchema: { type: "object" as const, properties: {} },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: "text" as const, text: `${name} pong` }],
      }));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => `${name}-${Math.random()}`,
        onsessioninitialized: (id) => {
          transports[id] = transport;
        },
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    res.status(400).end();
  });

  const handler = async (req: Request, res: Response): Promise<void> => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const t = sid ? transports[sid] : undefined;
    if (!t) {
      res.status(400).end();
      return;
    }
    await t.handleRequest(req, res);
  };
  app.get("/mcp", handler);
  app.delete("/mcp", handler);

  return new Promise((resolve) => {
    const s: Server = app.listen(0, () => {
      const addr = s.address();
      if (typeof addr === "string" || !addr) throw new Error("no port");
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        close: () =>
          new Promise<void>((r) => {
            s.closeAllConnections();
            s.close(() => r());
          }),
      });
    });
  });
}

const clientToken = mintToken({ env: ENV, label: "admin", roles: ["admin"] });

let granola: Awaited<ReturnType<typeof startUpstream>>;
let apify: Awaited<ReturnType<typeof startUpstream>>;
let gateway: Server;
let gatewayUrl: string;
let fake: ReturnType<typeof createFakeGcp>;
let registry: Registry;
/** The clock the provider reads. Advancing it is what expires a TTL. */
let clock = 1_000_000;

const yaml = (waiver: string): string => `
version: 1
gateway:
  name: strad
  env: ${ENV}
  secrets:
    provider: gcp-parameter-store
    ttlSeconds: 60
    negativeTtlSeconds: 10
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: granola
    kind: remote-http
    url: ${granola.url}
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${GRANOLA_TOKEN}"
  - slug: apify
    kind: remote-http
    url: ${apify.url}
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${APIFY_TOKEN}"
${waiver}`;

beforeAll(async () => {
  granola = await startUpstream("granola", GRANOLA_TOKEN);
  apify = await startUpstream("apify", APIFY_TOKEN);

  // GRANOLA_TOKEN is seeded. APIFY_TOKEN is NOT — that absence is the subject
  // of the whole file, and it is the state prod is in the moment a new server's
  // PR merges ahead of its token.
  fake = createFakeGcp();
  await fake.store.create({
    path: gatewayParameterPath(ENV, "GRANOLA_TOKEN"),
    secret: true,
    value: GRANOLA_TOKEN,
  });

  const config = parseConfig(yaml("    mayBeUnseeded: [APIFY_TOKEN]\n"));
  const env: NodeJS.ProcessEnv = {
    STRAD_TOKENS: JSON.stringify([clientToken.record]),
  };

  const provider = new StoreSecretProvider(
    fake.store,
    `/strad/${ENV}/gateway/static/`,
    { ttlMs: 60_000, negativeTtlMs: 10_000, now: () => clock },
  );

  registry = await Registry.build({
    config,
    secrets: sharedSecretProviders(provider),
    mode: "core",
    env,
  });
  const app = createApp({
    config,
    registry,
    tokenStore: tokenStoreFromConfig(config, env),
    mode: "core",
    env,
  });
  await new Promise<void>((r) => {
    gateway = app.listen(0, () => r());
  });
  const addr = gateway.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  gatewayUrl = `http://127.0.0.1:${addr.port}/mcp`;
});

afterAll(async () => {
  gateway?.closeAllConnections();
  gateway?.close();
  await registry?.close();
  await granola?.close();
  await apify?.close();
});

/** A real MCP client, optionally narrowing to named servers. */
async function connect(servers?: string): Promise<Client> {
  const url = servers
    ? `${gatewayUrl}?servers=${encodeURIComponent(servers)}`
    : gatewayUrl;
  const c = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: { Authorization: `Bearer ${clientToken.plaintext}` },
      },
    }),
  );
  return c;
}

describe("a slug whose deferred credential is not seeded yet", () => {
  it("reports `unconfigured`, and is NOT in `degraded`", async () => {
    const { snapshot, unconfigured } = await probeToolSurfaces({ registry });
    const bySlug = new Map(snapshot.surfaces.map((s) => [s.slug, s]));

    expect(bySlug.get("apify")!.state).toBe("unconfigured");
    expect(bySlug.get("granola")!.state).toBe("ok");

    // The load-bearing exclusion. `degraded` is what /healthz publishes and what
    // the staging deploy gate asserts on — counting a deliberately-deferred
    // credential there would red the very deploy this feature exists to let
    // through, one layer further down than the preflight that used to.
    expect(snapshot.degraded).toEqual([]);
    // Named on its own instead, so "which slugs are waiting on a token" is one
    // unauthenticated read.
    expect(snapshot.unconfigured).toEqual(["apify"]);

    // And the reason names the credential, from strad's own config.
    expect(unconfigured.get("apify")).toEqual(["APIFY_TOKEN"]);
  });

  it("publishes the list on /healthz, unauthenticated, slugs only", async () => {
    // The route a human (or a deploy job) actually reads. `degraded` and
    // `unconfigured` are two lists beside each other because they call for two
    // different actions — go and look, versus go and seed.
    const snapshot = (await probeToolSurfaces({ registry })).snapshot;
    const health = createApp({
      config: parseConfig(yaml("    mayBeUnseeded: [APIFY_TOKEN]\n")),
      registry,
      tokenStore: tokenStoreFromConfig(parseConfig(yaml("")), {}),
      mode: "core",
      env: {},
      toolSurfaces: () => snapshot,
    });
    const srv = health.listen(0);
    await new Promise((r) => srv.once("listening", r));
    const port = (srv.address() as { port: number }).port;
    try {
      const body = (await (
        await fetch(`http://127.0.0.1:${port}/healthz`)
      ).json()) as {
        degraded: string[];
        unconfigured: string[];
        toolSurfaces: { servers: { slug: string; state: string }[] };
      };
      expect(body.unconfigured).toEqual(["apify"]);
      expect(body.degraded).toEqual([]);
      expect(
        body.toolSurfaces.servers.find((s) => s.slug === "apify")!.state,
      ).toBe("unconfigured");
      // No `${NAME}` anywhere on this route. It is public, and a secret name is
      // a fact about a deployment that a public route has no reason to publish.
      expect(JSON.stringify(body)).not.toContain("APIFY_TOKEN");
    } finally {
      srv.closeAllConnections();
      srv.close();
    }
  });

  it("classifies for telemetry as itself, not as `unknown`", () => {
    // `unknown` is the bucket an alert rule uses to find real faults. A deploy
    // that shipped ahead of a token on purpose must not page out of it — the
    // mistake `LocalMachineOfflineError` already made once.
    expect(
      errorKind(new ServerUnconfiguredError("apify", ["APIFY_TOKEN"])),
    ).toBe("server_unconfigured");
  });

  it("costs the fleet nothing: every other server lists normally", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("granola__ping");
    expect(names).not.toContain("apify__ping");
    await client.close();

    // ...and the sibling still WORKS, not merely lists. An unconfigured slug
    // sharing a provider must not poison the resolution of one that resolves.
    const c2 = await connect("granola");
    const res = (await c2.callTool({
      name: "granola__ping",
      arguments: {},
    })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe("granola pong");
    await c2.close();
  });

  it("fails a NAMED listing cleanly, and says which credential", async () => {
    // The console hands out one `?servers=<slug>` per server, so this is the
    // case a human actually hits. A silent empty toolset would look like a
    // broken integration; this says what is missing and who fixes it.
    const client = await connect("apify");
    await expect(client.listTools()).rejects.toThrow(
      /apify.*not configured yet.*APIFY_TOKEN.*mayBeUnseeded/s,
    );
    await client.close();
  });

  it("fails a tool CALL cleanly, without sending a literal ${...} upstream", async () => {
    // The alternative to throwing is splicing the literal "${APIFY_TOKEN}" into
    // an Authorization header and posting it to a third party. The upstream here
    // would answer 401 to that, so a passing assertion on OUR message is also
    // the proof that we never sent it.
    const client = await connect("granola,apify");
    await expect(
      client.callTool({ name: "apify__ping", arguments: {} }),
    ).rejects.toThrow(/apify.*not configured yet.*APIFY_TOKEN/s);
    await client.close();
  });
});

describe("seeding the value, with the gateway still running", () => {
  it("activates the slug on its own — no redeploy, no restart", async () => {
    // The claim in Tadas's own words: "they immediately become active with no
    // additional PRs". This is what "immediately" really is — the store write,
    // then a TTL. Nothing here restarts the process, rebuilds the registry, or
    // touches the config.
    await fake.store.create({
      path: gatewayParameterPath(ENV, "APIFY_TOKEN"),
      secret: true,
      value: APIFY_TOKEN,
    });

    // The only thing that moves is the clock, past both the snapshot TTL and the
    // miss-refresh floor. In prod that is `negativeTtlSeconds` of wall time.
    clock += 61_000;

    const { snapshot } = await probeToolSurfaces({ registry });
    const bySlug = new Map(snapshot.surfaces.map((s) => [s.slug, s]));
    expect(bySlug.get("apify")!.state).toBe("ok");
    expect(snapshot.unconfigured).toEqual([]);
    expect(snapshot.degraded).toEqual([]);

    // And it SERVES, through the same long-lived process and the same client
    // path that was refusing a moment ago.
    const client = await connect("apify");
    const res = (await client.callTool({
      name: "apify__ping",
      arguments: {},
    })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe("apify pong");
    await client.close();
  });
});

describe("without the waiver, nothing about today changes", () => {
  it("an undeclared missing credential is `unreachable` AND degraded", async () => {
    // The negative control, and the property the whole design is protecting: a
    // secret nobody deferred is still a loud fault. Same absent name, same
    // provider, same store — only the `mayBeUnseeded:` line is gone.
    const config = parseConfig(yaml(""));
    const provider = new StoreSecretProvider(
      createFakeGcp().store,
      `/strad/${ENV}/gateway/static/`,
      { ttlMs: 60_000, now: () => clock },
    );
    const bare = await Registry.build({
      config,
      secrets: sharedSecretProviders(provider),
      mode: "core",
      env: {},
    });
    try {
      const { snapshot } = await probeToolSurfaces({ registry: bare });
      const bySlug = new Map(snapshot.surfaces.map((s) => [s.slug, s]));
      expect(bySlug.get("apify")!.state).toBe("unreachable");
      expect(snapshot.degraded).toContain("apify");
      expect(snapshot.unconfigured).toEqual([]);
    } finally {
      await bare.close();
    }
  });
});
