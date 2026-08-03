import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";

/**
 * End-to-end through a REAL MCP client against the real Express app.
 *
 * The point is to exercise the protocol path, not a mock of it: if the toolset
 * varied by session, or `?servers=` leaked authority, this is where it shows.
 */

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin:   { servers: ["*"] }
  limited: { servers: [alpha] }
servers:
  - slug: alpha
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin, limited]
    options: { greeting: "from alpha" }
  - slug: beta
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`);

const adminToken = mintToken({ env: "test", label: "admin", roles: ["admin"] });
const limitedToken = mintToken({
  env: "test",
  label: "limited",
  roles: ["limited"],
});

const env: NodeJS.ProcessEnv = {
  STRAD_TOKENS: JSON.stringify([adminToken.record, limitedToken.record]),
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const registry = await Registry.build({
    config: CONFIG,
    secrets: new EnvSecretProvider({}),
    mode: "core",
    env,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

async function connect(token: string, servers?: string): Promise<Client> {
  const url = new URL(`${baseUrl}/mcp`);
  if (servers !== undefined) url.searchParams.set("servers", servers);

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client(
    { name: "test", version: "1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

describe("/mcp", () => {
  it("401s with no token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("401s with a garbage token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer strad_test_deadbeef_nope" },
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "invalid_token" });
  });

  it("initialize + tools/list returns every entitled server, namespaced", async () => {
    const client = await connect(adminToken.plaintext);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "alpha__echo",
      "alpha__whoami",
      "beta__echo",
      "beta__whoami",
    ]);
    await client.close();
  });

  it("?servers= narrows the toolset", async () => {
    const client = await connect(adminToken.plaintext, "alpha");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "alpha__echo",
      "alpha__whoami",
    ]);
    await client.close();
  });

  it("tools/call routes to the right server", async () => {
    const client = await connect(adminToken.plaintext, "alpha");
    const res = await client.callTool({
      name: "alpha__echo",
      arguments: { text: "ping" },
    });
    expect(res.content).toEqual([{ type: "text", text: "ping" }]);
    await client.close();
  });

  it("refuses a tool from a server not selected in THIS request", async () => {
    // beta is entitled, but not selected. The toolset is derived from the
    // request, so a tool name learned from a *different* request must not work
    // here — otherwise ?servers= would be cosmetic, filtering tools/list while
    // leaving every tool callable.
    const client = await connect(adminToken.plaintext, "alpha");
    await expect(
      client.callTool({ name: "beta__echo", arguments: { text: "sneaky" } }),
    ).rejects.toThrow(/not selected/);
    await client.close();
  });

  it("424s — not 401 — when asking for a server you are not entitled to", async () => {
    // A 401 here would send the client into an OAuth loop against strad, which
    // is not the thing that's missing. 424 says: you're fine, the dependency isn't.
    const res = await fetch(`${baseUrl}/mcp?servers=alpha,beta`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${limitedToken.plaintext}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });

    expect(res.status).toBe(424);
    const body = (await res.json()) as {
      error: string;
      servers: { slug: string; status: string }[];
    };
    expect(body.error).toBe("downstream_not_authenticated");
    expect(body.servers).toEqual([{ slug: "beta", status: "not_entitled" }]);
  });

  it("a limited token sees only its own server, with no ?servers= at all", async () => {
    const client = await connect(limitedToken.plaintext);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "alpha__echo",
      "alpha__whoami",
    ]);
    await client.close();
  });

  it("is stateless: two clients on one process get independent toolsets", async () => {
    const wide = await connect(adminToken.plaintext);
    const narrow = await connect(adminToken.plaintext, "beta");

    const wideTools = (await wide.listTools()).tools.map((t) => t.name);
    const narrowTools = (await narrow.listTools()).tools.map((t) => t.name);

    expect(wideTools).toHaveLength(4);
    expect(narrowTools.sort()).toEqual(["beta__echo", "beta__whoami"]);

    // And the wide one is unchanged by the narrow one existing.
    expect((await wide.listTools()).tools).toHaveLength(4);

    await wide.close();
    await narrow.close();
  });
});

describe("/healthz", () => {
  it("reports the mounted servers without auth", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      mode: "core",
      servers: ["alpha", "beta"],
    });
  });
});

describe("/mcp-upload", () => {
  it("proxies raw POST bodies to a supplementary image mount", async () => {
    const seen: { url?: string; auth?: string; body?: string } = {};
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen.url = req.url;
        seen.auth = req.headers.authorization;
        seen.body = Buffer.concat(chunks).toString("utf8");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, bytes: seen.body.length }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    const addr = upstream.address();
    if (typeof addr === "string" || !addr) throw new Error("no upstream port");

    const cfg = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle-rfs
servers:
  - slug: remote-filesystem-tmp-public
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-rfs
    path: /remote-filesystem-tmp-public
    entitlements: [admin]
`);
    const localEnv = {
      STRAD_TOKENS: "[]",
      STRAD_BUNDLE_URL_BUNDLE_RFS: `http://127.0.0.1:${addr.port}`,
    };
    const registry = await Registry.build({
      config: cfg,
      secrets: new EnvSecretProvider({}),
      mode: "core",
      env: localEnv,
    });
    const app = createApp({
      config: cfg,
      registry,
      tokenStore: tokenStoreFromConfig(cfg, localEnv),
      mode: "core",
      env: localEnv,
    });
    const gateway = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const gatewayAddr = gateway.address();
    if (typeof gatewayAddr === "string" || !gatewayAddr) {
      throw new Error("no gateway port");
    }

    try {
      const res = await fetch(
        `http://127.0.0.1:${gatewayAddr.port}/mcp-upload/remote-filesystem-tmp-public/token123`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"hello":true}',
        },
      );
      await expect(res.json()).resolves.toEqual({ ok: true, bytes: 14 });
      expect(seen).toEqual({
        url: "/remote-filesystem-tmp-public/upload/token123",
        auth: undefined,
        body: '{"hello":true}',
      });
    } finally {
      gateway.close();
      upstream.close();
    }
  });
});
