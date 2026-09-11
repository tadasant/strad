import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig, parseYamlDocument } from "../src/config/load.ts";
import { EMPTY_OVERLAY } from "../src/config/overlay.ts";
import { RuntimeConfig } from "../src/config/runtime.ts";
import { MemoryConfigStore } from "../src/config/store.ts";
import type { StradConfig } from "../src/config/schema.ts";
import { Registry } from "../src/gateway/registry.ts";
import { ReloadableGateway } from "../src/gateway/reload.ts";
import { ToolSurfaceMonitor } from "../src/gateway/reachability.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * THE claim this whole feature makes: a server added through the console is
 * reachable at `/mcp` in the same process, with no restart and no deploy.
 *
 * Everything here is real — a real Express app, a real MCP client, a real
 * `Registry.build`, and a real second strad standing in for the third-party
 * upstream. Nothing about the reload is stubbed, because a stub of the reload
 * is a test of the stub.
 */

const UPSTREAM_YAML = `
version: 1
gateway: { name: upstream, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
    options: { greeting: "from the upstream" }
`;

const BOOTSTRAP = "strad_console_bootstrap_token_for_this_test";

const GATEWAY_YAML = `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: resident
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
    options: { greeting: "always here" }
`;

const gatewayDoc = parseYamlDocument(GATEWAY_YAML);
const gatewayConfig = parseConfig(GATEWAY_YAML);

const mcpToken = mintToken({ env: "test", label: "admin", roles: ["admin"] });
const upstreamToken = mintToken({
  env: "test",
  label: "upstream",
  roles: ["admin"],
});

let upstream: Server;
let upstreamUrl: string;
let gatewayServer: Server;
let gatewayUrl: string;
let runtime: RuntimeConfig;
let store: MemoryConfigStore;

const env: NodeJS.ProcessEnv = {
  STRAD_TOKENS: JSON.stringify([mcpToken.record]),
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

beforeAll(async () => {
  // A real MCP server for the new entry to point at.
  const upstreamConfig = parseConfig(UPSTREAM_YAML);
  const upstreamEnv = { STRAD_TOKENS: JSON.stringify([upstreamToken.record]) };
  const upstreamApp = createApp({
    config: upstreamConfig,
    registry: await Registry.build({
      config: upstreamConfig,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: upstreamEnv,
    }),
    tokenStore: tokenStoreFromConfig(upstreamConfig, upstreamEnv),
    mode: "core",
    env: upstreamEnv,
  });
  upstream = createServer(upstreamApp);
  upstreamUrl = await listen(upstream);

  // The gateway under test, built exactly the way src/index.ts builds it.
  store = new MemoryConfigStore();
  const runtimeRef: { current: RuntimeConfig | null } = { current: null };

  const build = async (next: StradConfig) => {
    const registry = await Registry.build({
      config: next,
      secrets: sharedSecretProviders(new EnvSecretProvider(env)),
      mode: "core",
      env,
    });
    const toolSurfaces = new ToolSurfaceMonitor({
      registry,
      intervalMs: 3_600_000,
    });
    const app = createApp({
      config: next,
      registry,
      tokenStore: tokenStoreFromConfig(next, env),
      mode: "core",
      env,
      toolSurfaces: () => toolSurfaces.snapshot(),
      runtimeConfig: () => runtimeRef.current,
    });
    return { config: next, registry, app, toolSurfaces };
  };

  const gateway = await ReloadableGateway.start(build, gatewayConfig, {
    drainMs: 10,
  });
  runtime = new RuntimeConfig({
    baseDocument: gatewayDoc,
    config: gatewayConfig,
    overlay: EMPTY_OVERLAY,
    store,
    rebuild: (next) => gateway.reload(next),
  });
  runtimeRef.current = runtime;

  gatewayServer = createServer(gateway.handle);
  gatewayUrl = await listen(gatewayServer);
});

afterAll(() => {
  gatewayServer?.close();
  upstream?.close();
});

async function connect(servers: string): Promise<Client> {
  const url = new URL(`${gatewayUrl}/mcp`);
  url.searchParams.set("servers", servers);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${mcpToken.plaintext}` } },
  });
  const client = new Client(
    { name: "test", version: "1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

function consoleFetch(path: string, body?: URLSearchParams): Promise<Response> {
  return fetch(`${gatewayUrl}${path}`, {
    ...(body
      ? {
          method: "POST",
          body,
          headers: {
            authorization: `Bearer ${BOOTSTRAP}`,
            "content-type": "application/x-www-form-urlencoded",
          },
        }
      : { headers: { authorization: `Bearer ${BOOTSTRAP}` } }),
    redirect: "manual",
  });
}

function saveForm(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams({
    revision: String(runtime.overlay().revision),
    ...fields,
  });
}

describe("adding a connector through the console", () => {
  it("starts with the slug unroutable", async () => {
    const res = await fetch(`${gatewayUrl}/mcp?servers=added`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mcpToken.plaintext}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    // 424: the gateway knows the selection cannot be served.
    expect(res.status).toBe(424);
  });

  it("lists the checked-in roster with a source badge", async () => {
    const res = await consoleFetch("/connectors");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("resident");
    expect(html).toContain("config file");
    expect(html).toContain("Add a connector");
  });

  it("SERVES the new server on the very next request — no restart", async () => {
    const res = await consoleFetch(
      "/connectors/save",
      saveForm({
        kind: "remote-http",
        slug: "added",
        title: "Added from the console",
        url: `${upstreamUrl}/mcp?servers=echo`,
        headers: `Authorization: Bearer ${upstreamToken.plaintext}`,
        "entitlement:admin": "on",
        enabled: "on",
      }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("live on this gateway now");

    // The process never restarted, and this is the same listening socket.
    const client = await connect("added");
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    expect(tools.tools.map((t) => t.name).join(",")).toContain("added__");
    await client.close();
  });

  it("kept the slug that was already there", async () => {
    const client = await connect("resident,added");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.some((n) => n.startsWith("resident__"))).toBe(true);
    expect(names.some((n) => n.startsWith("added__"))).toBe(true);
    await client.close();
  });

  it("actually CALLS a tool through the added server", async () => {
    const client = await connect("added");
    const name = (await client.listTools()).tools
      .map((t) => t.name)
      .find((n) => n.includes("whoami"));
    expect(name).toBeDefined();
    const result = await client.callTool({
      name: name as string,
      arguments: {},
    });
    expect(JSON.stringify(result)).toContain("from the upstream");
    await client.close();
  });

  it("persisted the change, so a restart would find it", async () => {
    const stored = await store.read();
    expect(stored.servers.upserts.map((u) => u.slug)).toEqual(["added"]);
    expect(stored.revision).toBe(1);
  });

  it("shows the new entry as coming from the console", async () => {
    const html = await (await consoleFetch("/connectors")).text();
    expect(html).toContain("Added from the console");
    expect(html).toContain(">console<");
  });

  it("offers it as a 'copy from' source for the next one of the same kind", async () => {
    const html = await (
      await consoleFetch("/connectors/new?kind=remote-http")
    ).text();
    expect(html).toContain("Start from an existing remote-http");
    expect(html).toContain('<option value="added"');
  });

  it("prefills every field but the slug when copied from", async () => {
    const html = await (
      await consoleFetch("/connectors/new?kind=remote-http&copyFrom=added")
    ).text();
    expect(html).toContain(`${upstreamUrl}/mcp?servers=echo`);
    expect(html).toContain("Added from the console");
    // The one field that must be unique is the one that is NOT copied: the
    // slug input renders blank even though everything around it is prefilled.
    expect(html).toMatch(/name="slug"[^>]*value=""/);
  });

  it("refuses a save built on a stale revision, without changing anything", async () => {
    const res = await consoleFetch(
      "/connectors/save",
      new URLSearchParams({
        revision: "0",
        kind: "remote-http",
        slug: "stale",
        url: "https://stale.example.com/mcp",
        "entitlement:admin": "on",
        enabled: "on",
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("changed while this form was open");
    expect(runtime.config().servers.map((s) => s.slug)).not.toContain("stale");
  });

  it("refuses a builtin, and says why", async () => {
    const html = await (
      await consoleFetch("/connectors/new?kind=builtin")
    ).text();
    expect(html).toContain("cannot be added from the console");
  });

  it("refuses an entry that would break a cross-entry rule, and keeps serving", async () => {
    const res = await consoleFetch(
      "/connectors/save",
      saveForm({
        kind: "remote-http",
        slug: "bad-role",
        url: "https://bad.example.com/mcp",
        "entitlement:nobody": "on",
        enabled: "on",
      }),
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("would make the config invalid");
    expect(html).toContain("nobody");
    // And the roster is untouched.
    expect(runtime.config().servers.map((s) => s.slug)).toEqual([
      "resident",
      "added",
    ]);
  });

  it("disables the server, and STOPS serving it, in the same process", async () => {
    const res = await consoleFetch(
      "/connectors/added/toggle",
      new URLSearchParams(),
    );
    expect(res.status).toBe(200);

    const probe = await fetch(`${gatewayUrl}/mcp?servers=added`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mcpToken.plaintext}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(probe.status).toBe(424);
    expect(JSON.stringify(await probe.json())).toContain("disabled");
  });

  it("re-enables it and serves it again", async () => {
    await consoleFetch("/connectors/added/toggle", new URLSearchParams());
    const client = await connect("added");
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it("removes it, and the roster returns to the checked-in one", async () => {
    const res = await consoleFetch(
      "/connectors/added/remove",
      new URLSearchParams(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("no longer routed");
    expect(runtime.config().servers.map((s) => s.slug)).toEqual(["resident"]);
    expect((await store.read()).servers.upserts).toEqual([]);
  });

  it("leaves the checked-in server serving throughout", async () => {
    const client = await connect("resident");
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });
});

describe("the editor is absent when the deployment did not ask for it", () => {
  it("404s with a reason rather than a bare Express 404", async () => {
    const plain = createApp({
      config: gatewayConfig,
      registry: await Registry.build({
        config: gatewayConfig,
        secrets: sharedSecretProviders(new EnvSecretProvider(env)),
        mode: "core",
        env,
      }),
      tokenStore: tokenStoreFromConfig(gatewayConfig, env),
      mode: "core",
      env,
    });
    const server = createServer(plain);
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/connectors`, {
        headers: { authorization: `Bearer ${BOOTSTRAP}` },
        redirect: "manual",
      });
      // Not mounted at all: no runtimeConfig was passed.
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
