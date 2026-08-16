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
import type { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import {
  compileToolPolicies,
  toolAllowed,
  unmatchedAllowEntries,
  unmatchedDenyEntries,
} from "../src/gateway/toolPolicy.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";

/**
 * Capability enforcement, end to end.
 *
 * The property under test is the one the whole re-architecture rests on: with
 * capability moved OFF the container and ONTO the gateway, one upstream now
 * holds every tool — read-only is a decision strad makes, not a process that
 * lacks the code. So it is not enough that a withheld tool is missing from
 * tools/list. A denied tools/call must be REFUSED, and must never reach the
 * upstream at all.
 *
 * Hence a real upstream MCP server here — over real HTTP, with a call counter —
 * rather than a stub adapter. If the gateway ever forwarded a denied call, the
 * counter would move, and this file would fail.
 */

// --- the upstream: ONE server, full capability, two slugs will share it ------

const upstreamCalls: { name: string; count: number }[] = [];

function record(name: string): void {
  const hit = upstreamCalls.find((c) => c.name === name);
  if (hit) hit.count += 1;
  else upstreamCalls.push({ name, count: 1 });
}

function callsTo(name: string): number {
  return upstreamCalls.find((c) => c.name === name)?.count ?? 0;
}

function upstreamApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.all("/mcp", async (req, res) => {
    const server = new McpServer(
      { name: "thing", version: "1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "read_thing",
          description: "read",
          inputSchema: { type: "object" as const, properties: {} },
        },
        {
          name: "write_thing",
          description: "write",
          inputSchema: { type: "object" as const, properties: {} },
        },
        {
          name: "delete_thing",
          description: "delete",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      record(request.params.name);
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
  const upstreamAddr = upstream.address();
  if (typeof upstreamAddr === "string" || !upstreamAddr)
    throw new Error("port");
  const upstreamUrl = `http://127.0.0.1:${upstreamAddr.port}/mcp`;

  // The heart of the change: thing-ro and thing-rw are the SAME upstream —
  // one container, one process, every tool present — differing only in policy.
  const config = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: thing-ro
    kind: remote-http
    url: ${upstreamUrl}
    entitlements: [admin]
    tools:
      allow: [read_thing]
  - slug: thing-rw
    kind: remote-http
    url: ${upstreamUrl}
    entitlements: [admin]
  - slug: thing-nodelete
    kind: remote-http
    url: ${upstreamUrl}
    entitlements: [admin]
    tools:
      deny: [delete_thing]
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
  const addr = gateway.address();
  if (typeof addr === "string" || !addr) throw new Error("port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  gateway?.close();
  upstream?.close();
});

beforeEach(() => {
  upstreamCalls.length = 0;
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

describe("capability policy", () => {
  it("two slugs on ONE upstream expose different tool counts", async () => {
    const ro = await connect("thing-ro");
    const rw = await connect("thing-rw");

    const roTools = (await ro.listTools()).tools.map((t) => t.name);
    const rwTools = (await rw.listTools()).tools.map((t) => t.name);

    expect(roTools).toEqual(["thing-ro__read_thing"]);
    expect(rwTools).toHaveLength(3);
    expect(rwTools).toContain("thing-rw__write_thing");

    await ro.close();
    await rw.close();
  });

  it("REJECTS a denied tools/call — and never forwards it upstream", async () => {
    const ro = await connect("thing-ro");

    // The client calls a name it was never shown. Listing filtered it; that is
    // decoration. THIS is the enforcement.
    await expect(
      ro.callTool({ name: "thing-ro__write_thing", arguments: {} }),
    ).rejects.toThrow(/capability policy withholds it/);

    expect(callsTo("write_thing")).toBe(0);
    await ro.close();
  });

  it("still allows what the policy permits, on the same upstream", async () => {
    const ro = await connect("thing-ro");
    const result = await ro.callTool({
      name: "thing-ro__read_thing",
      arguments: {},
    });
    expect(JSON.stringify(result.content)).toContain("did read_thing");
    expect(callsTo("read_thing")).toBe(1);
    await ro.close();
  });

  it("the read-write slug can call the very tool the read-only slug cannot", async () => {
    const rw = await connect("thing-rw");
    await rw.callTool({ name: "thing-rw__write_thing", arguments: {} });
    expect(callsTo("write_thing")).toBe(1);
    await rw.close();
  });

  it("deny hides and refuses, without an allow list", async () => {
    const client = await connect("thing-nodelete");
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toHaveLength(2);
    expect(tools).not.toContain("thing-nodelete__delete_thing");

    await expect(
      client.callTool({ name: "thing-nodelete__delete_thing", arguments: {} }),
    ).rejects.toThrow(/capability policy withholds it/);
    expect(callsTo("delete_thing")).toBe(0);
    await client.close();
  });
});

describe("toolAllowed", () => {
  const config = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: a
    kind: remote-http
    url: https://example.com/mcp
    entitlements: [admin]
    tools:
      allow: [x, y]
      deny: [y]
  - slug: b
    kind: remote-http
    url: https://example.com/mcp
    entitlements: [admin]
`);
  const policies = compileToolPolicies(config);

  it("allow is exhaustive and deny wins over it", () => {
    const p = policies.get("a");
    expect(toolAllowed(p, "x")).toBe(true);
    expect(toolAllowed(p, "y")).toBe(false); // denied despite being allowed
    expect(toolAllowed(p, "z")).toBe(false); // not on the allow list
  });

  it("no policy means no restriction", () => {
    expect(policies.has("b")).toBe(false);
    expect(toolAllowed(policies.get("b"), "anything")).toBe(true);
  });

  it("flags allow entries the upstream does not offer (a typo narrows silently)", () => {
    expect(unmatchedAllowEntries(policies.get("a"), ["x"])).toEqual(["y"]);
    expect(unmatchedAllowEntries(policies.get("a"), ["x", "y"])).toEqual([]);
  });

  it("flags deny entries the upstream does not offer (a rename stops subtracting)", () => {
    // Changes nothing at runtime — a deny that matches no tool refuses no call —
    // which is exactly why it needs saying out loud somewhere. The caller is the
    // pre-deploy check, not the request path.
    expect(unmatchedDenyEntries(policies.get("a"), ["x"])).toEqual(["y"]);
    expect(unmatchedDenyEntries(policies.get("a"), ["x", "y"])).toEqual([]);
    expect(unmatchedDenyEntries(policies.get("a"), [])).toEqual(["y"]);
  });

  it("says nothing about a policy with no deny list, or no policy at all", () => {
    // `b` has no `tools:` block; `allow`-only policies must not report their
    // allow entries as unmatched DENY entries.
    expect(unmatchedDenyEntries(policies.get("b"), [])).toEqual([]);
    expect(unmatchedDenyEntries(undefined, ["x"])).toEqual([]);
    expect(unmatchedDenyEntries({ allow: new Set(["x"]) }, [])).toEqual([]);
  });
});

describe("config schema", () => {
  it("rejects an empty tools: block", () => {
    expect(() =>
      parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: a
    kind: remote-http
    url: https://example.com/mcp
    entitlements: [admin]
    tools: {}
`),
    ).toThrow(/allow.*deny|deny.*allow/s);
  });
});
