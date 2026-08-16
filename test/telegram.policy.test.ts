import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { readFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";

/**
 * `telegram-ro` cannot send a Telegram message. Proven, not asserted in prose.
 *
 * The two slugs are ONE mount in ONE container running at full capability, so
 * the read-only tier is a gateway decision and nothing else — the send tool is
 * right there, loaded, one HTTP hop away. A `tools:` allow-list that filtered
 * `tools/list` and forwarded the call anyway would look identical from a
 * console and would post a message to a group as Tadas.
 *
 * So the upstream here counts its calls. If a refused `send_message` ever
 * reached it, the counter moves and this file fails.
 *
 * The allow-list is read from the config that ships, not restated here. The
 * other half of the join — that these names are the names the real image serves
 * — is `servers/bundle/scripts/smoke.mjs` (which pins the six by name) and the
 * pre-deploy `policy:check`, which matches every allow entry against the booted
 * container's own tool list.
 */

/** The full surface of the telegram mount, at the capability the bundle runs. */
const TELEGRAM_TOOLS = [
  "get_me",
  "list_chats",
  "get_chat",
  "get_chat_history",
  "search_messages",
  "send_message",
];

const STAGING = parseConfig(
  readFileSync(new URL("../infra/strad.staging.yaml", import.meta.url), "utf8"),
  "infra/strad.staging.yaml",
);

function stagingAllowList(slug: string): string[] {
  const server = STAGING.servers.find((s) => s.slug === slug);
  if (!server) throw new Error(`${slug} is not in the staging config`);
  return [...(server.tools?.allow ?? [])];
}

const calls: string[] = [];

function upstreamApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.all("/mcp", async (req, res) => {
    const server = new McpServer(
      { name: "strad-telegram", version: "test" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: TELEGRAM_TOOLS.map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object" as const, properties: {} },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      calls.push(request.params.name);
      return {
        content: [{ type: "text", text: `did ${request.params.name}` }],
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
  return app;
}

let upstream: HttpServer;
let gateway: HttpServer;
let baseUrl: string;

const token = mintToken({ env: "test", label: "admin", roles: ["admin"] });
const env: NodeJS.ProcessEnv = {
  STRAD_TOKENS: JSON.stringify([token.record]),
};

beforeAll(async () => {
  upstream = upstreamApp().listen(0);
  const addr = upstream.address();
  if (typeof addr === "string" || !addr) throw new Error("port");
  const upstreamUrl = `http://127.0.0.1:${addr.port}/mcp`;

  // Same upstream twice, exactly as staging points both slugs at /telegram on
  // the one bundle. The allow-list is staging's own.
  const config = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: telegram-ro
    kind: remote-http
    url: ${upstreamUrl}
    entitlements: [admin]
    tools:
      allow: [${stagingAllowList("telegram-ro").join(", ")}]
  - slug: telegram-rw
    kind: remote-http
    url: ${upstreamUrl}
    entitlements: [admin]
`);

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
  gateway = app.listen(0);
  const gatewayAddr = gateway.address();
  if (typeof gatewayAddr === "string" || !gatewayAddr) throw new Error("port");
  baseUrl = `http://127.0.0.1:${gatewayAddr.port}`;
});

afterAll(() => {
  gateway?.close();
  upstream?.close();
});

beforeEach(() => {
  calls.length = 0;
});

async function connect(servers: string): Promise<Client> {
  const url = new URL(`${baseUrl}/mcp`);
  url.searchParams.set("servers", servers);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token.plaintext}` } },
  });
  const client = new Client(
    { name: "test", version: "1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

describe("the telegram read/write split", () => {
  it("staging's telegram-ro allow-list is the read surface, exactly", () => {
    // Every read tool, and nothing that writes. A tool added to the server and
    // not to this list is withheld from the read-only slug silently, which is
    // the fail-closed direction — but it should still be a deliberate act.
    expect(stagingAllowList("telegram-ro").sort()).toEqual(
      TELEGRAM_TOOLS.filter((t) => t !== "send_message").sort(),
    );
    // telegram-rw carries no policy at all: it is the same mount, unrestricted.
    const rw = STAGING.servers.find((s) => s.slug === "telegram-rw");
    expect(rw?.tools).toBeUndefined();
  });

  it("telegram-ro is never shown send_message; telegram-rw is", async () => {
    const ro = await connect("telegram-ro");
    const rw = await connect("telegram-rw");

    const roTools = (await ro.listTools()).tools.map((t) => t.name);
    const rwTools = (await rw.listTools()).tools.map((t) => t.name);

    expect(roTools).toHaveLength(5);
    expect(roTools).not.toContain("telegram-ro__send_message");
    expect(roTools).toContain("telegram-ro__get_chat_history");
    expect(rwTools).toHaveLength(6);
    expect(rwTools).toContain("telegram-rw__send_message");

    await ro.close();
    await rw.close();
  });

  it("REFUSES a send_message call on telegram-ro, and nothing reaches Telegram", async () => {
    const ro = await connect("telegram-ro");

    await expect(
      ro.callTool({
        name: "telegram-ro__send_message",
        arguments: { chat: "-1001234567890", text: "hello" },
      }),
    ).rejects.toThrow(/capability policy withholds it/);

    // The assertion that matters. Filtering tools/list is decoration; a message
    // that never left the gateway is the product.
    expect(calls).toEqual([]);
    await ro.close();
  });

  it("reading a group's history still works on the read-only slug", async () => {
    const ro = await connect("telegram-ro");
    const result = await ro.callTool({
      name: "telegram-ro__get_chat_history",
      arguments: { chat: "-1001234567890" },
    });
    expect(JSON.stringify(result.content)).toContain("did get_chat_history");
    expect(calls).toEqual(["get_chat_history"]);
    await ro.close();
  });

  it("telegram-rw can call the very tool telegram-ro cannot", async () => {
    const rw = await connect("telegram-rw");
    await rw.callTool({
      name: "telegram-rw__send_message",
      arguments: { chat: "-1001234567890", text: "hello" },
    });
    expect(calls).toEqual(["send_message"]);
    await rw.close();
  });
});
