import type { Server as HttpServer } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  HANDSHAKE_MAX_AGE_MS,
  HttpServerAdapter,
} from "../src/gateway/adapters/http.ts";
import { EVENTS_EXTENSION } from "../src/gateway/events.ts";

/**
 * `HANDSHAKE_MAX_AGE_MS` at the adapter: when a cached connection's handshake
 * is re-asked, how many times, what a failed re-ask costs, and which kinds pay
 * for it at all. Real MCP over real HTTP; the clock is the adapter's `now`.
 */

interface Stub {
  url: string;
  /** `initialize` requests received. */
  handshakes: () => number;
  /** What the CURRENT container is: events on, and whether `initialize` fails. */
  state: { events: boolean; failInitialize: boolean };
  /** Hold every `tools/list` until the returned function is called. */
  holdTools: () => () => void;
  close: () => Promise<void>;
}

async function stub(): Promise<Stub> {
  let handshakes = 0;
  const state = { events: false, failInitialize: false };
  let gate: Promise<void> | null = null;

  const app = express();
  app.use(express.json());
  app.post("/mcp", async (req: Request, res: Response) => {
    if ((req.body as { method?: string })?.method === "initialize") {
      handshakes += 1;
      if (state.failInitialize) {
        res.status(503).end();
        return;
      }
    }
    const server = new McpServer(
      { name: "stub", version: "0" },
      {
        capabilities: {
          tools: {},
          ...(state.events ? { extensions: { [EVENTS_EXTENSION]: {} } } : {}),
        },
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (gate) await gate;
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
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const http = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = http.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    handshakes: () => handshakes,
    state,
    holdTools: () => {
      let release = (): void => {};
      gate = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        gate = null;
        release();
      };
    },
    close: () => new Promise<void>((r) => http.close(() => r())),
  };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(kind: "supplementary-image" | "remote-http") {
  const upstream = await stub();
  let t = 1_000_000;
  const adapter = new HttpServerAdapter({
    slug: "s",
    kind,
    endpoint: async () => ({ url: upstream.url, headers: {} }),
    timeoutMs: 5_000,
    now: () => t,
  });
  cleanup.push(() => upstream.close());
  cleanup.push(() => adapter.close());
  return {
    upstream,
    adapter,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("a supplementary-image connection's handshake", () => {
  it("is reused until it ages out, then asked again once", async () => {
    const { upstream, adapter, advance } = await setup("supplementary-image");
    expect(await adapter.supportsEvents()).toBe(false);
    expect(upstream.handshakes()).toBe(1);

    // The container is replaced with one that serves events.
    upstream.state.events = true;
    advance(HANDSHAKE_MAX_AGE_MS - 1);
    expect(await adapter.supportsEvents()).toBe(false);
    await adapter.listTools();
    expect(upstream.handshakes()).toBe(1);

    advance(1);
    expect(await adapter.supportsEvents()).toBe(true);
    expect(upstream.handshakes()).toBe(2);
    expect(await adapter.supportsEvents()).toBe(true);
    expect(upstream.handshakes()).toBe(2);
  });

  it("is asked again ONCE however many callers arrive at the expiry", async () => {
    const { upstream, adapter, advance } = await setup("supplementary-image");
    await adapter.listTools();
    advance(HANDSHAKE_MAX_AGE_MS);
    await Promise.all(Array.from({ length: 8 }, () => adapter.listTools()));
    expect(upstream.handshakes()).toBe(2);
  });

  it("keeps the aged connection when the re-handshake fails, and retries an interval later", async () => {
    const { upstream, adapter, advance } = await setup("supplementary-image");
    await adapter.listTools();

    upstream.state.failInitialize = true;
    advance(HANDSHAKE_MAX_AGE_MS);
    // The call still answers, on the connection that works.
    expect((await adapter.listTools()).map((t) => t.name)).toEqual(["ping"]);
    const afterFailure = upstream.handshakes();
    expect(afterFailure).toBeGreaterThanOrEqual(2);

    // Believed for another interval: no re-handshake per request in between.
    await adapter.listTools();
    expect(upstream.handshakes()).toBe(afterFailure);

    upstream.state.failInitialize = false;
    upstream.state.events = true;
    advance(HANDSHAKE_MAX_AGE_MS);
    expect(await adapter.supportsEvents()).toBe(true);
    expect(upstream.handshakes()).toBe(afterFailure + 1);
  });

  it("lets a request already running on the aged connection finish there", async () => {
    const { upstream, adapter, advance } = await setup("supplementary-image");
    await adapter.listTools();

    const release = upstream.holdTools();
    const inFlight = adapter.listTools();
    advance(HANDSHAKE_MAX_AGE_MS);
    upstream.state.events = true;
    // A new caller gets a fresh connection while the old one is still leased.
    expect(await adapter.supportsEvents()).toBe(true);
    release();
    expect((await inFlight).map((t) => t.name)).toEqual(["ping"]);
  });
});

describe("a remote-http connection's handshake", () => {
  it("is not re-asked on age: the upstream may hold a session per connection", async () => {
    const { upstream, adapter, advance } = await setup("remote-http");
    await adapter.listTools();
    advance(HANDSHAKE_MAX_AGE_MS * 10);
    await adapter.listTools();
    expect(upstream.handshakes()).toBe(1);
  });
});
