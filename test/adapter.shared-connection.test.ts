import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { HttpServerAdapter } from "../src/gateway/adapters/http.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";

/**
 * The claim under test:
 *
 *   **One method's failure cannot take another method's in-flight call down
 *   with it.**
 *
 * One cached MCP `Client` per slug serves every concurrent request for that
 * server, so a `close()` on it is felt by every request in flight. In production
 * the pair that exercised this was `resources/list` and `tools/list`: a
 * tools-only upstream answers `resources/list` with `-32601`, the gateway called
 * that a transport fault and closed the shared connection, and whichever
 * `tools/list` was in flight died with a `-32603`. `curl` loops and the
 * tool-surface monitor never issue the pair, so it was invisible for a week.
 * (tadasant/strad#81.)
 *
 * Nothing is mocked at the seam: these are real MCP clients talking to real MCP
 * servers over real HTTP. The ORDERING is what is controlled — the upstream
 * holds its `tools/list` answer until the test releases it, so "tools is still
 * in flight when resources fails" is a fact of the test rather than a race it
 * hopes to win.
 */

interface Stub {
  url: string;
  close: () => Promise<void>;
  /** JSON-RPC requests received, counted by method. */
  seen: (method: string) => number;
  /** Resolves once a `resources/list` response has gone out on the wire. */
  resourcesAnswered: () => Promise<void>;
  /** Let a held `tools/list` answer. */
  releaseTools: () => void;
  /** Drop every established MCP session, as a restarted upstream would. */
  killSessions: () => void;
}

interface StubOptions {
  /**
   * Advertise `resources` in the handshake. `false` is the shape of every
   * tools-only mount in the bundle — including `secrets`, the slug the
   * production failure surfaced on.
   */
  resources: boolean;
  /** Hold every `tools/list` until `releaseTools()`. */
  holdTools?: boolean;
}

/** An upstream whose `resources/list` fails with prose nobody could match on. */
const RESOURCES_FAILURE = "the vault is on fire and the ferrets have the keys";

function startStub(opts: StubOptions): Promise<Stub> {
  const counts = new Map<string, number>();
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  let releaseTools = (): void => {};
  const toolsGate = new Promise<void>((r) => {
    releaseTools = r;
  });
  let answeredResources = (): void => {};
  const resourcesAnswered = new Promise<void>((r) => {
    answeredResources = r;
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const method = (req.body as { method?: string } | undefined)?.method;
    if (method) counts.set(method, (counts.get(method) ?? 0) + 1);
    next();
  });

  const build = (): McpServer => {
    const server = new McpServer(
      { name: "stub", version: "0" },
      {
        capabilities: {
          tools: {},
          ...(opts.resources ? { resources: {} } : {}),
        },
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (opts.holdTools) await toolsGate;
      return {
        tools: [
          {
            name: "ping",
            description: "ping",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    if (opts.resources) {
      // Advertised, and then fails — the case a capability check alone cannot
      // save you from, and the one that has to not cost `tools/list` its
      // connection.
      server.setRequestHandler(ListResourcesRequestSchema, async () => {
        throw new Error(RESOURCES_FAILURE);
      });
    }
    return server;
  };

  app.post("/mcp", async (req: Request, res: Response) => {
    if (
      (req.body as { method?: string } | undefined)?.method === "resources/list"
    ) {
      res.on("finish", () => answeredResources());
    }

    const sid = req.headers["mcp-session-id"] as string | undefined;
    const existing = sid ? transports[sid] : undefined;
    if (existing) {
      await existing.handleRequest(req, res, req.body);
      return;
    }
    if (!sid && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      await build().connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "no session" },
      id: null,
    });
  });

  const session = async (req: Request, res: Response): Promise<void> => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const transport = sid ? transports[sid] : undefined;
    if (!transport) {
      res.status(400).send("bad session");
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", session);
  app.delete("/mcp", session);

  return new Promise((resolve) => {
    const s: HttpServer = app.listen(0, () => {
      const addr = s.address();
      if (typeof addr === "string" || !addr) throw new Error("no port");
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        close: () =>
          new Promise<void>((r) => {
            s.closeAllConnections();
            s.close(() => r());
          }),
        seen: (method) => counts.get(method) ?? 0,
        resourcesAnswered: () => resourcesAnswered,
        releaseTools: () => releaseTools(),
        killSessions: () => {
          for (const id of Object.keys(transports)) delete transports[id];
        },
      });
    });
  });
}

function adapterFor(url: string): HttpServerAdapter {
  return new HttpServerAdapter({
    slug: "stub",
    kind: "remote-http",
    endpoint: () => Promise.resolve({ url, headers: {} }),
    timeoutMs: 5_000,
  });
}

describe("a shared upstream connection survives one method's failure", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  it("a failing resources/list does not kill a tools/list in flight", async () => {
    const stub = await startStub({ resources: true, holdTools: true });
    const adapter = adapterFor(stub.url);
    cleanup.push(async () => {
      await adapter.close();
      await stub.close();
    });

    // tools/list goes first and is held by the upstream: it is unambiguously
    // in flight for the whole of what follows.
    const tools = adapter.listTools();
    const resources = await adapter.listResources().then(
      () => null,
      (err: unknown) => err,
    );

    // The resources failure surfaces to its OWN caller — that part is correct
    // and stays correct.
    expect(resources).toBeInstanceOf(Error);
    expect(String(resources)).toContain(RESOURCES_FAILURE);

    // And the peer request, still holding the same connection, completes.
    // Before the fix this rejected: `reset()` had closed the shared client and
    // the SDK failed the pending request with ConnectionClosed.
    stub.releaseTools();
    await expect(tools).resolves.toEqual([
      expect.objectContaining({ name: "ping" }),
    ]);

    // The upstream ANSWERED, so the transport was never in doubt: no reconnect,
    // and the next caller pays no handshake.
    expect(stub.seen("initialize")).toBe(1);
    await expect(adapter.listTools()).resolves.toHaveLength(1);
    expect(stub.seen("initialize")).toBe(1);
  });

  it("skips resources/list entirely on an upstream that never advertised it", async () => {
    const stub = await startStub({ resources: false, holdTools: true });
    const adapter = adapterFor(stub.url);
    cleanup.push(async () => {
      await adapter.close();
      await stub.close();
    });

    // The production shape: a tools-only mount (`secrets` advertises
    // `{ tools: {} }`) with a slow tools/list racing a client's resources/list.
    const tools = adapter.listTools();
    await expect(adapter.listResources()).resolves.toEqual([]);

    // Answered from the handshake, so it never reached the wire at all.
    expect(stub.seen("resources/list")).toBe(0);

    // A read is gated the same way. The router sweeps every selected server
    // when a URI hint misses, and this is what keeps that sweep from costing a
    // round trip per tools-only slug.
    await expect(adapter.readResource("ui://stub/panel")).rejects.toThrow(
      /does not serve resources/,
    );
    expect(stub.seen("resources/read")).toBe(0);

    stub.releaseTools();
    await expect(tools).resolves.toHaveLength(1);
    expect(stub.seen("initialize")).toBe(1);
  });

  it("still drops the cached connection when the transport itself fails", async () => {
    const stub = await startStub({ resources: false });
    const adapter = adapterFor(stub.url);
    cleanup.push(async () => {
      await adapter.close();
      await stub.close();
    });

    await expect(adapter.listTools()).resolves.toHaveLength(1);
    expect(stub.seen("initialize")).toBe(1);

    // Drop the upstream's side of the session, as a restarted container does.
    // This is the case retirement exists for: the cached client is now useless,
    // and the narrowing must not have turned "an answer is not a fault" into
    // "never reconnect".
    stub.killSessions();
    await expect(adapter.listTools()).rejects.toThrow(/upstream MCP server/);

    // The decisive assertion, on the SAME adapter: it handshakes again rather
    // than reusing the dead client. Without retirement this call fails too, and
    // `initialize` stays at 1 forever.
    await expect(adapter.listTools()).resolves.toHaveLength(1);
    expect(stub.seen("initialize")).toBe(2);
  });
});

describe("end to end: a real client asking for tools and resources at once", () => {
  it("gets its tools, on an upstream whose resources/list fails", async () => {
    const stub = await startStub({ resources: true, holdTools: true });
    const config = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: stub
    kind: remote-http
    url: "${stub.url}"
    entitlements: [admin]
`);
    const token = mintToken({ env: "test", label: "admin", roles: ["admin"] });
    const env: NodeJS.ProcessEnv = {
      STRAD_TOKENS: JSON.stringify([token.record]),
    };
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
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
    const strad: HttpServer = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = strad.address();
    if (typeof addr === "string" || !addr) throw new Error("no port");

    const client = new Client(
      { name: "repro", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        // `?servers=stub` names the server explicitly, which is what turns a
        // failed listing into a hard error for the client rather than a quietly
        // missing entry.
        new URL(`http://127.0.0.1:${addr.port}/mcp?servers=stub`),
        {
          requestInit: {
            headers: { authorization: `Bearer ${token.plaintext}` },
          },
        },
      ),
    );

    try {
      // The client shape the production failure needs: both listings in flight
      // at once, as a host application issues them on connect.
      const pair = Promise.allSettled([
        client.listTools(),
        client.listResources(),
      ]);
      await stub.resourcesAnswered();
      stub.releaseTools();
      const [tools, resources] = await pair;

      // Before the fix: `MCP error -32603: server "stub" was requested by name
      // but its upstream could not be listed…`.
      expect(tools.status).toBe("fulfilled");
      if (tools.status === "fulfilled") {
        expect(tools.value.tools.map((t) => t.name)).toEqual(["stub__ping"]);
      }
      // One failing upstream contributes zero resources rather than a 500 —
      // unchanged, and the reason nobody noticed the tools failure.
      expect(resources.status).toBe("fulfilled");
    } finally {
      await client.close().catch(() => {});
      strad.close();
      await registry.close();
      await stub.close();
    }
  });
});
