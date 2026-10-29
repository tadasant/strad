import type { Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { EVENTS_EXTENSION } from "../src/gateway/events.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * MCP Events through core — draft SEP-3415, poll mode — against the wire
 * contract Zimmer's poller is built to (docs/mcp-events-spec-pin.md).
 *
 * Two real upstreams behind a real strad app, both stateless Streamable HTTP
 * the way the bundle host serves its mounts:
 *
 *   - `feed`   advertises the events extension and serves one event type;
 *   - `quiet`  is tools-only, as every other server strad proxies is;
 *   - `unset`  registers the handlers WITHOUT advertising, and refuses every
 *              poll by naming the variable it lacks — the Slack mount until
 *              SLACK_APP_TOKEN is seeded.
 *
 * What is pinned: the advertisement follows the selected upstreams; names are
 * slug-prefixed both ways; the entitlement check is the one tools use and
 * everything outside it is -32024; an upstream's own refusal reaches the caller
 * with its code and its words, once.
 */

const ListEvents = z.object({
  method: z.literal("events/list"),
  params: z.object({}).passthrough().optional(),
});
const PollEvents = z.object({
  method: z.literal("events/poll"),
  params: z.object({ name: z.string() }).passthrough(),
});

class CodedError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

interface Seen {
  polls: Record<string, unknown>[];
}

function upstream(kind: "feed" | "quiet" | "unset", seen: Seen) {
  return async (req: Request, res: Response) => {
    const server = new McpServer(
      { name: kind, version: "0" },
      {
        capabilities: {
          tools: {},
          ...(kind === "feed"
            ? { extensions: { [EVENTS_EXTENSION]: {} } }
            : {}),
        },
      },
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
      content: [{ type: "text", text: `pong from ${kind}` }],
    }));
    if (kind !== "quiet") {
      server.setRequestHandler(ListEvents, async () => ({
        events:
          kind === "feed"
            ? [
                {
                  name: "message_posted",
                  description: "a message",
                  delivery: ["poll"],
                  inputSchema: { type: "object", properties: {} },
                  payloadSchema: { type: "object", properties: {} },
                },
              ]
            : [],
      }));
      server.setRequestHandler(PollEvents, async (request) => {
        seen.polls.push(request.params);
        if (kind === "unset") {
          throw new CodedError(
            -32023,
            "Slack events are not configured on this deployment: SLACK_APP_TOKEN is not set.",
            { kind: "event" },
          );
        }
        if (request.params.name !== "message_posted") {
          throw new CodedError(-32023, "unknown event type", { kind: "event" });
        }
        if (request.params.cursor === null) {
          return {
            events: [],
            cursor: "v1.100",
            truncated: false,
            hasMore: false,
            nextPollMs: 5000,
          } as never;
        }
        return {
          events: [
            {
              eventId: "slack:C1:1700000000.000100",
              name: "message_posted",
              timestamp: "2023-11-14T22:13:20.000Z",
              data: { channel_id: "C1", text: "hi" },
            },
          ],
          cursor: "v1.101",
          truncated: false,
          hasMore: false,
          nextPollMs: 5000,
        } as never;
      });
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}

const seen: Seen = { polls: [] };
let upstreamServer: HttpServer;
let stradServer: HttpServer;
let registry: Registry;
let baseUrl: string;
let adminToken: string;
let narrowToken: string;

beforeAll(async () => {
  const up = express();
  up.use(express.json());
  for (const kind of ["feed", "quiet", "unset"] as const) {
    up.post(`/${kind}`, upstream(kind, seen));
  }
  const upUrl = await new Promise<string>((resolve) => {
    upstreamServer = up.listen(0, () => {
      const addr = upstreamServer.address();
      if (typeof addr === "string" || !addr) throw new Error("no port");
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });

  const config = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles:
  admin: { servers: ["*"] }
  narrow: { servers: [quiet] }
servers:
  - slug: feed
    kind: remote-http
    url: "${upUrl}/feed"
    entitlements: [admin]
  - slug: quiet
    kind: remote-http
    url: "${upUrl}/quiet"
    entitlements: [admin, narrow]
  - slug: unset
    kind: remote-http
    url: "${upUrl}/unset"
    entitlements: [admin]
`);
  const admin = mintToken({ env: "test", label: "admin", roles: ["admin"] });
  const narrow = mintToken({ env: "test", label: "narrow", roles: ["narrow"] });
  adminToken = admin.plaintext;
  narrowToken = narrow.plaintext;
  const env: NodeJS.ProcessEnv = {
    STRAD_TOKENS: JSON.stringify([admin.record, narrow.record]),
  };
  registry = await Registry.build({
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
  await new Promise<void>((resolve) => {
    stradServer = app.listen(0, () => resolve());
  });
  const addr = stradServer.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  stradServer?.close();
  await registry?.close();
  await new Promise<void>((r) => upstreamServer.close(() => r()));
});

async function client(servers?: string, token = adminToken): Promise<Client> {
  const c = new Client({ name: "events-client", version: "1" });
  const url = new URL(`${baseUrl}/mcp${servers ? `?servers=${servers}` : ""}`);
  await c.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return c;
}

const Loose = ResultSchema.passthrough();

function poll(c: Client, name: string, cursor: string | null, args = {}) {
  return c.request(
    { method: "events/poll", params: { name, arguments: args, cursor } },
    Loose,
  );
}

describe("the events extension on initialize", () => {
  it("is advertised when a selected slug's upstream advertises it", async () => {
    const c = await client("feed,quiet");
    expect(c.getServerCapabilities()?.extensions?.[EVENTS_EXTENSION]).toEqual(
      {},
    );
    expect(c.getServerCapabilities()?.tools).toBeDefined();
    await c.close();
  });

  it("is not advertised when no selected upstream serves events", async () => {
    for (const servers of ["quiet", "unset", "quiet,unset"]) {
      const c = await client(servers);
      expect(
        c.getServerCapabilities()?.extensions?.[EVENTS_EXTENSION],
      ).toBeUndefined();
      await c.close();
    }
  });
});

describe("events/list", () => {
  it("is the union over the selection, slug-prefixed like tools", async () => {
    const c = await client();
    const res = await c.request({ method: "events/list", params: {} }, Loose);
    const events = res.events as { name: string; delivery: string[] }[];
    expect(events.map((e) => e.name)).toEqual(["feed__message_posted"]);
    expect(events[0]!.delivery).toEqual(["poll"]);
    expect(res.nextCursor).toBeUndefined();
    await c.close();
  });

  it("lists nothing for a selection that serves no events", async () => {
    const c = await client("quiet");
    const res = await c.request({ method: "events/list", params: {} }, Loose);
    expect(res.events).toEqual([]);
    await c.close();
  });
});

describe("events/poll", () => {
  it("a null cursor is 'from now': no events, a fresh cursor", async () => {
    const c = await client("feed");
    const res = await poll(c, "feed__message_posted", null);
    expect(res).toMatchObject({
      events: [],
      cursor: "v1.100",
      truncated: false,
      hasMore: false,
      nextPollMs: 5000,
    });
    await c.close();
  });

  it("forwards the bare name, the arguments and the cursor, and prefixes the answer", async () => {
    const c = await client("feed");
    const res = await poll(c, "feed__message_posted", "v1.100", {
      addressed_to_bot: true,
    });
    expect(res.events).toEqual([
      {
        eventId: "slack:C1:1700000000.000100",
        name: "feed__message_posted",
        timestamp: "2023-11-14T22:13:20.000Z",
        data: { channel_id: "C1", text: "hi" },
      },
    ]);
    expect(res.cursor).toBe("v1.101");
    expect(seen.polls.at(-1)).toMatchObject({
      name: "message_posted",
      arguments: { addressed_to_bot: true },
      cursor: "v1.100",
    });
    await c.close();
  });

  it("is Forbidden (-32024) for a slug the request did not select", async () => {
    const c = await client("quiet");
    await expect(poll(c, "feed__message_posted", null)).rejects.toMatchObject({
      code: -32024,
    });
    await c.close();
  });

  it("is Forbidden for a principal not entitled to the slug, and for a slug that does not exist", async () => {
    const c = await client(undefined, narrowToken);
    await expect(poll(c, "feed__message_posted", null)).rejects.toMatchObject({
      code: -32024,
    });
    await expect(poll(c, "nosuch__message_posted", null)).rejects.toMatchObject(
      { code: -32024 },
    );
    await c.close();
  });

  it("refuses a name that is not namespaced", async () => {
    const c = await client("feed");
    await expect(poll(c, "message_posted", null)).rejects.toMatchObject({
      code: -32602,
    });
    await c.close();
  });

  it("relays an upstream's refusal with its code and its words, unprefixed", async () => {
    const c = await client("unset");
    const err = await poll(c, "unset__message_posted", null).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: -32023, data: { kind: "event" } });
    const message = (err as Error).message;
    expect(message).toContain("SLACK_APP_TOKEN is not set");
    // The SDK prefixes once on this side; core must not add a second.
    expect(message.match(/MCP error/g)).toHaveLength(1);
    await c.close();
  });

  it("an unknown event type on a serving slug is NotFound", async () => {
    const c = await client("feed");
    await expect(poll(c, "feed__nope", null)).rejects.toMatchObject({
      code: -32023,
    });
    await c.close();
  });

  it("a tools-only upstream answers NotFound, not method-not-found", async () => {
    const c = await client("quiet");
    await expect(poll(c, "quiet__message_posted", null)).rejects.toMatchObject({
      code: -32023,
    });
    await c.close();
  });

  it("accepts the Mcp-Method and Mcp-Name headers, and does not require them", async () => {
    const res = await fetch(`${baseUrl}/mcp?servers=feed`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        "mcp-method": "events/poll",
        "mcp-name": "feed__message_posted",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "events/poll",
        params: { name: "feed__message_posted", arguments: {}, cursor: null },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    const body = JSON.parse(line ? line.slice(5) : text);
    expect(body.result).toMatchObject({ events: [], cursor: "v1.100" });
  });
});

describe("tools are unaffected", () => {
  it("still lists and calls through the same session", async () => {
    const c = await client("feed,quiet");
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "feed__ping",
      "quiet__ping",
    ]);
    const res = await c.callTool({ name: "feed__ping", arguments: {} });
    expect(res.content).toEqual([{ type: "text", text: "pong from feed" }]);
    await c.close();
  });
});
