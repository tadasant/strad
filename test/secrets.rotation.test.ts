import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import { randomUUID } from "node:crypto";
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
import { HttpServerAdapter } from "../src/gateway/adapters/http.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import type { ParameterStore } from "../src/secrets/parameters/types.ts";
import { gatewayParameterPath } from "../src/secrets/parameters/namespace.ts";
import { StoreSecretProvider } from "../src/secrets/provider/index.ts";

/**
 * The claim this whole change exists to make, tested end to end:
 *
 *   **A secret rotated in the store reaches a RUNNING gateway, with no redeploy
 *   and no restart.**
 *
 * Nothing here is mocked at the seam under test. A real MCP client talks to a
 * real strad app, which proxies over real HTTP to a real MCP upstream that
 * checks the bearer token it was handed. The secret lives in the in-memory
 * Parameter Manager + Secret Manager fake (src/secrets/parameters/fake.ts), and
 * it is rotated through the store's own `rotate()` — the same call the SSO
 * console makes.
 *
 * The upstream starts out rejecting the credential the gateway holds. A gateway
 * that resolved `${UPSTREAM_TOKEN}` once at boot would keep failing forever. This
 * one does not, and that is the test.
 */

const ENV = "test";
const OLD_TOKEN = "upstream-token-v1";
const NEW_TOKEN = "upstream-token-v2";

/** A real MCP upstream that accepts exactly one bearer token at a time. */
function startUpstream(accepted: () => string): Promise<{
  url: string;
  close: () => Promise<void>;
  rejections: () => number;
}> {
  let rejections = 0;
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req: Request, res: Response) => {
    if (req.headers.authorization !== `Bearer ${accepted()}`) {
      rejections += 1;
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
        { name: "upstream", version: "0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "ping",
            description: "ping",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    res.status(400).json({ error: "no session" });
  });

  const handler = async (req: Request, res: Response) => {
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
            // The gateway holds keep-alive sockets open to this upstream, so a
            // bare close() waits for them and the afterAll hook times out.
            s.closeAllConnections();
            s.close(() => r());
          }),
        rejections: () => rejections,
      });
    });
  });
}

const clientToken = mintToken({ env: ENV, label: "admin", roles: ["admin"] });

let upstream: Awaited<ReturnType<typeof startUpstream>>;
let gateway: Server;
let gatewayUrl: string;
let fake: ReturnType<typeof createFakeGcp>;
let accepted = OLD_TOKEN;
let now = 1_000_000;
let provider: StoreSecretProvider;
/** A second admin client over the SAME store state — a write nobody told us about. */
let foreign: ParameterStore;
const PATH = gatewayParameterPath(ENV, "UPSTREAM_TOKEN");

beforeAll(async () => {
  upstream = await startUpstream(() => accepted);

  // The secret, in the store. `create` with secret:true puts the VALUE in the
  // Secret Manager map and only a `__REF__` pointer in Parameter Manager.
  // The store client the container would hold: ONE reading of the store for
  // the TTL, on a clock the test controls so a TTL assertion does not have to
  // sleep for a minute.
  fake = createFakeGcp({ snapshotTtlMs: 60_000, now: () => now });
  foreign = fake.another();
  await fake.store.create({ path: PATH, secret: true, value: OLD_TOKEN });

  const config = parseConfig(`
version: 1
gateway:
  name: strad
  env: ${ENV}
  secrets:
    provider: gcp-parameter-store
    ttlSeconds: 60
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: up
    kind: remote-http
    url: ${upstream.url}
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${UPSTREAM_TOKEN}"
`);

  const env: NodeJS.ProcessEnv = {
    STRAD_TOKENS: JSON.stringify([clientToken.record]),
  };

  // The provider the container would build over it. It holds no TTL of its
  // own: how long a value is reused is the store client's decision.
  provider = new StoreSecretProvider(
    fake.store,
    `/strad/${ENV}/gateway/static/`,
    { now: () => now },
  );

  const registry = await Registry.build({
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
  await upstream?.close();
});

async function call(): Promise<string> {
  const c = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(gatewayUrl), {
      requestInit: {
        headers: { authorization: `Bearer ${clientToken.plaintext}` },
      },
    }),
  );
  try {
    const res = (await c.callTool({ name: "up__ping", arguments: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    if (res.isError) throw new Error(res.content[0]?.text ?? "tool error");
    return res.content[0]!.text;
  } finally {
    await c.close();
  }
}

describe("a secret rotated in the store reaches a running gateway", () => {
  it("resolves the initial value from the store, not from any env var", async () => {
    // Nothing put UPSTREAM_TOKEN in process.env. The only place it exists is the
    // store, and the call only succeeds if the gateway went and got it.
    expect(process.env.UPSTREAM_TOKEN).toBeUndefined();
    expect(await call()).toBe("pong");
  });

  it("keeps working on the OLD value for the length of the TTL", async () => {
    // Rotated through a DIFFERENT client — `gcloud`, another deployment's
    // console — so nothing tells this process. The fake's `store` is the one
    // the gateway holds; a write through it would drop the snapshot itself.
    await foreign.rotate(PATH, NEW_TOKEN);
    // The upstream has NOT switched yet, so the held value is still correct.
    expect(await call()).toBe("pong");
  });

  it("picks up the ROTATION once the TTL elapses — same process, no restart", async () => {
    // The upstream accepts only the new token from here. A gateway that had baked
    // the old one at boot would be locked out permanently.
    accepted = NEW_TOKEN;
    await expect(call()).rejects.toThrow();

    now += 61_000; // the TTL passes

    expect(await call()).toBe("pong");
  });

  it("invalidate() makes a rotation visible with NO clock movement at all", async () => {
    // This is the path a write through strad's own SSO console takes, and it is
    // the difference between "within the TTL" and "now".
    const V3 = "upstream-token-v3";
    accepted = V3;
    await foreign.rotate(PATH, V3);

    const before = now;
    await expect(call()).rejects.toThrow(); // still serving the held v2

    provider.invalidate();
    expect(await call()).toBe("pong");
    expect(now).toBe(before); // no TTL elapsed; the invalidate did it
  });

  it("rejected the stale credential rather than falling open", () => {
    // The upstream really did turn the gateway away while it held an old token.
    // Without this, every assertion above could pass on an upstream that never
    // checked anything.
    expect(upstream.rejections()).toBeGreaterThan(0);
  });

  it("the secret VALUE never appears in a Parameter Manager payload", () => {
    // The IAM split is only real if the value genuinely lives in Secret Manager.
    // A viewer credential reads Parameter Manager and nothing else.
    for (const payload of fake.pmPayloads()) {
      expect(payload).not.toContain(OLD_TOKEN);
      expect(payload).not.toContain(NEW_TOKEN);
    }
  });
});

// =============================================================================
// The narrow race: a rotation that lands mid-handshake
// =============================================================================

/**
 * Two `connect()` calls straddling a rotation.
 *
 * The one that resolved the OLD credential can finish its handshake LAST and
 * overwrite the cached client with a connection carrying the superseded
 * `Authorization` header — while the adapter's fingerprint already reads "new",
 * so nothing ever reconnects and the rotation stays invisible for the life of
 * the process. It is narrow, it is silent, and it defeats the entire feature,
 * which is exactly the combination worth a deterministic test.
 *
 * Determinism comes from gating the upstream's FIRST handshake: the old-credential
 * connect is held open until the new-credential one has already completed.
 */
describe("a credential that rotates mid-handshake", () => {
  it("never leaves the superseded connection cached", async () => {
    const OLD = "mid-old";
    const NEW = "mid-new";

    let releaseFirst!: () => void;
    const firstHandshake = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let handshakes = 0;
    // An OVERLAP WINDOW: during the rotation the upstream honours both tokens.
    // This is the realistic case and the only one in which the bug is silent —
    // the old-credential connection SUCCEEDS, so nothing errors, and it quietly
    // outlives the window. A server that rejected the old token immediately
    // would surface the problem on its own.
    let accepts = new Set([OLD, NEW]);

    const accepted = (auth: string | undefined) =>
      typeof auth === "string" && accepts.has(auth.replace(/^Bearer /, ""));

    const transports: Record<string, StreamableHTTPServerTransport> = {};
    const app = express();
    app.use(express.json());
    app.post("/mcp", (req: Request, res: Response) => {
      void (async () => {
        const sid = req.headers["mcp-session-id"] as string | undefined;
        const existing = sid ? transports[sid] : undefined;
        if (existing) {
          if (!accepted(req.headers.authorization)) {
            res.status(401).json({ error: "bad token" });
            return;
          }
          await existing.handleRequest(req, res, req.body);
          return;
        }
        if (!sid && isInitializeRequest(req.body)) {
          // Hold the FIRST handshake open. That is the old-credential connect.
          handshakes += 1;
          if (handshakes === 1) await firstHandshake;
          if (!accepted(req.headers.authorization)) {
            res.status(401).json({ error: "bad token" });
            return;
          }
          const server = new McpServer(
            { name: "u", version: "0" },
            { capabilities: { tools: {} } },
          );
          server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
              {
                name: "ping",
                description: "p",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          }));
          server.setRequestHandler(CallToolRequestSchema, async () => ({
            content: [{ type: "text", text: "pong" }],
          }));
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports[id] = transport;
            },
          });
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
          return;
        }
        res.status(400).end();
      })();
    });

    const s: Server = await new Promise((r) => {
      const srv = app.listen(0, () => r(srv));
    });
    const addr = s.address();
    if (typeof addr === "string" || !addr) throw new Error("no port");
    const url = `http://127.0.0.1:${addr.port}/mcp`;

    // The endpoint thunk is the rotation: the first resolve hands out the old
    // credential, every later one the new.
    let resolves = 0;
    const adapter = new HttpServerAdapter({
      slug: "mid",
      kind: "remote-http",
      endpoint: async () => {
        resolves += 1;
        return {
          url,
          headers: { authorization: `Bearer ${resolves === 1 ? OLD : NEW}` },
        };
      },
      timeoutMs: 5_000,
    });

    try {
      // A: resolves OLD, then blocks in the handshake.
      const a = adapter.listTools().catch(() => null);
      await new Promise((r) => setImmediate(r));

      // B: resolves NEW, sees the fingerprint changed, connects afresh — and
      // completes while A is still held.
      const b = adapter.listTools().catch(() => null);
      await new Promise((r) => setImmediate(r));

      releaseFirst(); // A's handshake finally lands, carrying the old header —
      await Promise.all([a, b]); // and SUCCEEDS, because the window is still open.

      // The window closes: the old credential is dead.
      accepts = new Set([NEW]);

      // The decisive assertion. If A's connection had been installed, the
      // adapter is holding a session opened with the old header and reuses it
      // (its fingerprint already reads "new", so it never reconnects) — and the
      // upstream answers 401.
      const tools = await adapter.listTools();
      expect(tools.map((t) => t.name)).toEqual(["ping"]);
    } finally {
      await adapter.close();
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
