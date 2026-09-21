import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import {
  cspOrigin,
  frameCsp,
  MCP_APP_MIME,
  toolResourceUri,
  toolVisibility,
  withBlankTarget,
} from "../src/ui/apps.ts";

/**
 * `/apps/:server` — the console as an MCP Apps host (src/ui/apps.ts).
 *
 * The upstream is a real MCP server on a socket, shipping what SEP-1865 says a
 * server ships: a tool carrying `_meta.ui.resourceUri`, the `ui://` resource it
 * names, and an app-invisible tool. What is asserted is the host's half: the
 * app is found through the TOOL, the frame is served in an opaque origin under
 * a policy that names only well-formed declared origins, and a call from the
 * page is the signed-in human's own, onto this slug only, refusing a tool whose
 * visibility excludes "app".
 */

const PAGE = "<!doctype html><title>showcase</title><p>hello from the app</p>";
const called: string[] = [];

function upstream(): express.Express {
  const app = express();
  app.use(express.json());
  app.all("/mcp", async (req, res) => {
    const server = new McpServer(
      { name: "app-upstream", version: "1" },
      { capabilities: { tools: {}, resources: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "show",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
          _meta: { ui: { resourceUri: "ui://shop/page" } },
        },
        {
          name: "model_ui",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
          _meta: {
            ui: { resourceUri: "ui://shop/other", visibility: ["model"] },
          },
        },
        { name: "act", inputSchema: { type: "object", properties: {} } },
        {
          name: "model_only",
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      called.push(r.params.name);
      return {
        content: [{ type: "text", text: `ran ${r.params.name}` }],
        structuredContent: { ran: r.params.name },
      };
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        { uri: "ui://shop/page", name: "page", mimeType: MCP_APP_MIME },
      ],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (r) => ({
      contents: [
        {
          uri: r.params.uri,
          mimeType: MCP_APP_MIME,
          text: PAGE,
          _meta: {
            ui: {
              csp: {
                resourceDomains: [
                  "https://images.example.com",
                  // Spliced into a header: must not survive.
                  "https://evil.example.com; script-src *",
                  "http://plain.example.com",
                ],
              },
            },
          },
        },
      ],
    }));
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

const BOOTSTRAP = "bootstrap-secret-apps";
const cookie = `strad_console=${BOOTSTRAP}`;
let up: Server;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    up = upstream().listen(0, () => resolve());
  });
  const upPort = (up.address() as { port: number }).port;
  const config = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: [shop, echo] }
  other: { servers: [walled] }
servers:
  - slug: shop
    kind: remote-http
    url: http://127.0.0.1:${upPort}/mcp
    entitlements: [admin]
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
  - slug: walled
    kind: remote-http
    url: http://127.0.0.1:${upPort}/mcp
    entitlements: [other]
`);
  const env: NodeJS.ProcessEnv = {
    ALLOW_DEV_AUTH: "true",
    ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
    STRAD_TOKENS: "[]",
  };
  const app = createApp({
    config,
    registry: await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env,
    }),
    tokenStore: tokenStoreFromConfig(config, env),
    mode: "core",
    env,
    secrets: {},
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server?.close();
  up?.close();
});

const get = (path: string, withCookie = true) =>
  fetch(`${baseUrl}${path}`, { headers: withCookie ? { cookie } : {} });

const call = (slug: string, body: unknown) =>
  fetch(`${baseUrl}/apps/${slug}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  });

describe("pure units", () => {
  it("cspOrigin keeps an https origin and nothing that could add a directive", () => {
    expect(cspOrigin("https://images.craigslist.org")).toBe(
      "https://images.craigslist.org",
    );
    expect(cspOrigin("https://*.example.com:8443")).toBe(
      "https://*.example.com:8443",
    );
    for (const bad of [
      "https://a.example.com; script-src *",
      "https://a.example.com/path",
      "http://a.example.com",
      "https://localhost",
      "*",
      42,
    ]) {
      expect(cspOrigin(bad)).toBe(null);
    }
  });

  it("frameCsp sandboxes without allow-same-origin and connects nowhere", () => {
    const csp = frameCsp(["https://images.example.com"]);
    expect(csp).toMatch(/^sandbox allow-scripts /);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("img-src data: blob: https://images.example.com");
  });

  it("reads the spec's _meta.ui fields, and the deprecated flat key", () => {
    expect(toolResourceUri({ ui: { resourceUri: "ui://a/b" } })).toBe(
      "ui://a/b",
    );
    expect(toolResourceUri({ "ui/resourceUri": "ui://a/b" })).toBe("ui://a/b");
    expect(toolResourceUri({ ui: { resourceUri: "https://x" } })).toBe(null);
    expect(toolVisibility(undefined)).toEqual(["model", "app"]);
    expect(toolVisibility({ ui: { visibility: ["app"] } })).toEqual(["app"]);
  });
});

describe("withBlankTarget", () => {
  it("lands after <head>, else after the doctype, else first", () => {
    expect(withBlankTarget("<html><head><title>x</title></head></html>")).toBe(
      '<html><head><base target="_blank"><title>x</title></head></html>',
    );
    expect(withBlankTarget("<!DOCTYPE html><p>x")).toBe(
      '<!DOCTYPE html><base target="_blank"><p>x',
    );
    expect(withBlankTarget("<p>x")).toBe('<base target="_blank"><p>x');
  });
});

describe("GET /apps/:server", () => {
  it("runs no tool when another site started the navigation", async () => {
    const res = await fetch(`${baseUrl}/apps/shop`, {
      headers: { cookie, "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("initialTool");
    expect(html).toContain("You followed a link from outside the console");
    // The way in is a same-origin link to the same URL.
    expect(html).toContain('class="open" href="/apps/shop"');
  });

  it("renders the host with the frame and the tool that declares the UI", async () => {
    const res = await get("/apps/shop");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      JSON.stringify(
        `/apps/shop/frame?uri=${encodeURIComponent("ui://shop/page")}`,
      ),
    );
    expect(html).toContain(
      '"sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox"',
    );
    // Nothing frames the host, and the host frames exactly its frame route.
    const host = new URL(baseUrl).host;
    expect(res.headers.get("content-security-policy")).toBe(
      `frame-ancestors 'none'; frame-src ${host}/apps/shop/frame`,
    );
    expect(html).toContain('const initialTool = "show"');
    // The page itself is never inlined into the console's origin.
    expect(html).not.toContain("hello from the app");
  });

  it("says so for a server that ships no app", async () => {
    const res = await get("/apps/echo");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("ships no app");
  });

  it("refuses a slug the console identity is not entitled to", async () => {
    expect((await get("/apps/walled")).status).toBe(424);
  });

  it("is behind the console gate", async () => {
    const res = await get("/apps/shop", false);
    expect(res.status).not.toBe(200);
  });
});

describe("GET /apps/:server/frame", () => {
  it("serves the server's page in an opaque origin, naming only well-formed origins", async () => {
    const res = await get(
      `/apps/shop/frame?uri=${encodeURIComponent("ui://shop/page")}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      '<!doctype html><base target="_blank"><title>showcase</title><p>hello from the app</p>',
    );
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("https://images.example.com");
    expect(csp).not.toContain("evil.example.com");
    expect(csp).not.toContain("plain.example.com");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is behind the console gate", async () => {
    expect((await get("/apps/shop/frame", false)).status).not.toBe(200);
  });
});

describe("POST /apps/:server/tools/call", () => {
  it("runs a tool on this slug and returns its result", async () => {
    const res = await call("shop", { tool: "act", arguments: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      result: { structuredContent: unknown };
    };
    expect(body.ok).toBe(true);
    expect(body.result.structuredContent).toEqual({ ran: "act" });
  });

  it("lets the host's opening call through for a read-only UI tool, and nothing else", async () => {
    // Host-initiated per the spec, so visibility does not bind it.
    const opening = await call("shop", { tool: "model_ui", initial: true });
    expect(opening.status).toBe(200);
    // `initial` on a tool that declares no UI is not an opening call.
    called.length = 0;
    const res = await call("shop", { tool: "model_only", initial: true });
    expect(res.status).toBe(403);
    expect(called).not.toContain("model_only");
  });

  it("refuses a tool the server does not list", async () => {
    called.length = 0;
    const res = await call("shop", { tool: "not_a_tool" });
    expect(res.status).toBe(404);
    expect(called).toEqual([]);
  });

  it("does not treat an opening call with arguments as the host's", async () => {
    const res = await call("shop", {
      tool: "model_ui",
      initial: true,
      arguments: { anything: 1 },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a tool whose visibility excludes app, before it runs", async () => {
    called.length = 0;
    const res = await call("shop", { tool: "model_only" });
    expect(res.status).toBe(403);
    expect(called).not.toContain("model_only");
  });

  it("pins a call to its own slug: another slug's name is not a way out", async () => {
    // `echo__whoami` is taken as a bare name ON `shop`, which lists no such
    // tool: refused before any upstream runs, and the echo builtin never runs.
    called.length = 0;
    const res = await call("shop", { tool: "echo__whoami" });
    expect(res.status).toBe(404);
    expect(called).toEqual([]);
  });

  it("demands JSON, which a cross-site form cannot send", async () => {
    const res = await fetch(`${baseUrl}/apps/shop/tools/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        cookie,
      },
      body: "tool=act",
    });
    expect(res.status).toBe(415);
  });
});
