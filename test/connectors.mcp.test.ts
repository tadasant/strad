import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig, parseYamlDocument } from "../src/config/load.ts";
import { EMPTY_OVERLAY, type ServerOverlay } from "../src/config/overlay.ts";
import { RuntimeConfig } from "../src/config/runtime.ts";
import { MemoryConfigStore, type ConfigStore } from "../src/config/store.ts";
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
 * The OTHER door onto the roster: an agent editing the server list over /mcp.
 *
 * Driven through a real MCP client against the real gateway, because the claim
 * is about what a session can actually do — that a tool exists in the source is
 * not the same as an entitled caller being able to list and call it.
 */

const UPSTREAM_YAML = `
version: 1
gateway: { name: upstream, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: notes
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
    options: { greeting: "from the personal account" }
`;

const GATEWAY_YAML = `
version: 1
gateway:
  name: strad
  env: test
  publicUrl: https://strad.example.com
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: connectors
    kind: builtin
    module: "./servers/connectors.js"
    bundle: core
    entitlements: [admin]
  - slug: resident
    kind: remote-http
    url: https://resident.example.com/mcp
    title: A checked-in one
    entitlements: [admin]
`;

const gatewayDoc = parseYamlDocument(GATEWAY_YAML);
const gatewayConfig = parseConfig(GATEWAY_YAML);

const mcpToken = mintToken({ env: "test", label: "admin", roles: ["admin"] });
const upstreamToken = mintToken({
  env: "test",
  label: "upstream",
  roles: ["admin"],
});

const env: NodeJS.ProcessEnv = {
  STRAD_TOKENS: JSON.stringify([mcpToken.record]),
};

let upstream: Server;
let upstreamUrl: string;
let gatewayServer: Server;
let gatewayUrl: string;
let runtime: RuntimeConfig;
let store: MemoryConfigStore;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

/** A gateway wired exactly the way src/index.ts wires one. */
async function boot(
  config: StradConfig,
  configStore: ConfigStore | null,
  overlay: ServerOverlay = EMPTY_OVERLAY,
): Promise<{ url: string; server: Server; runtime: RuntimeConfig }> {
  const runtimeRef: { current: RuntimeConfig | null } = { current: null };
  const build = async (next: StradConfig) => {
    const registry = await Registry.build({
      config: next,
      secrets: sharedSecretProviders(new EnvSecretProvider(env)),
      mode: "core",
      env,
      runtime: () => runtimeRef.current,
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

  const gateway = await ReloadableGateway.start(build, config, { drainMs: 10 });
  const holder = new RuntimeConfig({
    baseDocument: gatewayDoc,
    config,
    overlay,
    store: configStore,
    rebuild: (next) => gateway.reload(next),
    env,
  });
  runtimeRef.current = holder;

  const server = createServer(gateway.handle);
  return { url: await listen(server), server, runtime: holder };
}

beforeAll(async () => {
  const upstreamConfig = parseConfig(UPSTREAM_YAML);
  const upstreamEnv = { STRAD_TOKENS: JSON.stringify([upstreamToken.record]) };
  upstream = createServer(
    createApp({
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
    }),
  );
  upstreamUrl = await listen(upstream);

  store = new MemoryConfigStore();
  const booted = await boot(gatewayConfig, store);
  gatewayUrl = booted.url;
  gatewayServer = booted.server;
  runtime = booted.runtime;
});

afterAll(() => {
  gatewayServer?.close();
  upstream?.close();
});

async function connect(base: string, servers: string): Promise<Client> {
  const url = new URL(`${base}/mcp`);
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

/** Call a connectors tool and parse the JSON it answers with. */
async function call(
  client: Client,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const result = await client.callTool({
    name: `connectors__${tool}`,
    arguments: args,
  });
  const content = result.content as { type: string; text: string }[];
  return {
    isError: result.isError === true,
    body: JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>,
  };
}

describe("the connectors tool surface", () => {
  it("lists the read and write tools when the roster is writable", async () => {
    const client = await connect(gatewayUrl, "connectors");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "connectors__describe_connector_authorization",
      "connectors__get_connector",
      "connectors__list_connectors",
      "connectors__remove_connector",
      "connectors__save_connector",
      "connectors__set_connector_enabled",
    ]);
    await client.close();
  });

  it("reports the roster an agent would act on", async () => {
    const client = await connect(gatewayUrl, "connectors");
    const { body } = await call(client, "list_connectors");
    expect(body.ok).toBe(true);
    expect(body.writable).toBe(true);
    expect(body.revision).toBe(0);
    const connectors = body.connectors as { slug: string; source: string }[];
    expect(connectors.map((c) => c.slug)).toEqual(["connectors", "resident"]);
    expect(connectors.every((c) => c.source === "file")).toBe(true);
    await client.close();
  });

  it("ADDS a connector that is reachable on the next request", async () => {
    const client = await connect(gatewayUrl, "connectors");
    const { isError, body } = await call(client, "save_connector", {
      expectedRevision: 0,
      entry: {
        slug: "notes-personal",
        kind: "remote-http",
        title: "Notes (personal account)",
        url: `${upstreamUrl}/mcp?servers=notes`,
        headers: { Authorization: `Bearer ${upstreamToken.plaintext}` },
        entitlements: ["admin"],
      },
    });
    expect(isError).toBe(false);
    expect(body.ok).toBe(true);
    expect(body.live).toBe(true);
    expect(body.revision).toBe(1);
    await client.close();

    // The proof: a NEW MCP session selects the slug the agent just created and
    // calls a tool through it. Same process, no restart.
    const added = await connect(gatewayUrl, "notes-personal");
    const whoami = (await added.listTools()).tools
      .map((t) => t.name)
      .find((n) => n.includes("whoami"));
    expect(whoami).toBeDefined();
    const result = await added.callTool({
      name: whoami as string,
      arguments: {},
    });
    expect(JSON.stringify(result)).toContain("from the personal account");
    await added.close();
  });

  it("hands back an entry an agent can copy from", async () => {
    const client = await connect(gatewayUrl, "connectors");
    const { body } = await call(client, "get_connector", {
      slug: "notes-personal",
    });
    const entry = body.entry as Record<string, unknown>;
    expect(entry.url).toBe(`${upstreamUrl}/mcp?servers=notes`);
    expect(body.source).toBe("store");
    expect(body.immutableFields).toEqual(["kind"]);

    // Copy-from, as an agent does it: same entry, different slug.
    const copy = await call(client, "save_connector", {
      entry: { ...entry, slug: "notes-second", title: "A copy" },
    });
    expect(copy.isError).toBe(false);
    expect(runtime.config().servers.map((s) => s.slug)).toContain(
      "notes-second",
    );
    await call(client, "remove_connector", { slug: "notes-second" });
    await client.close();
  });

  it("refuses a write computed against a stale revision", async () => {
    const client = await connect(gatewayUrl, "connectors");
    const { isError, body } = await call(client, "save_connector", {
      expectedRevision: 0,
      entry: { slug: "stale", kind: "remote-http", url: "https://s/mcp" },
    });
    expect(isError).toBe(true);
    expect(String(body.error)).toContain("roster has moved");
    expect(runtime.config().servers.map((s) => s.slug)).not.toContain("stale");
    await client.close();
  });

  it("refuses a builtin, naming the reason", async () => {
    const client = await connect(gatewayUrl, "connectors");
    const { isError, body } = await call(client, "save_connector", {
      entry: { slug: "nope", kind: "builtin", module: "./servers/echo.js" },
    });
    expect(isError).toBe(true);
    expect(String(body.error)).toContain("has to ship with a build");
    await client.close();
  });

  it("refuses a roster that would not validate, and keeps serving", async () => {
    const before = runtime.config().servers.map((s) => s.slug);
    const client = await connect(gatewayUrl, "connectors");
    const { isError, body } = await call(client, "save_connector", {
      entry: {
        slug: "bad-role",
        kind: "remote-http",
        url: "https://b/mcp",
        entitlements: ["nobody"],
      },
    });
    expect(isError).toBe(true);
    expect(JSON.stringify(body.detail)).toContain("nobody");
    expect(runtime.config().servers.map((s) => s.slug)).toEqual(before);
    await client.close();
  });

  it("disables and re-enables a connector in the same process", async () => {
    const client = await connect(gatewayUrl, "connectors");
    await call(client, "set_connector_enabled", {
      slug: "notes-personal",
      enabled: false,
    });
    expect(
      runtime.config().servers.find((s) => s.slug === "notes-personal")
        ?.enabled,
    ).toBe(false);

    await call(client, "set_connector_enabled", {
      slug: "notes-personal",
      enabled: true,
    });
    expect(
      runtime.config().servers.find((s) => s.slug === "notes-personal")
        ?.enabled,
    ).toBe(true);
    await client.close();
  });

  it("removes a connector, and the roster returns to the checked-in one", async () => {
    const client = await connect(gatewayUrl, "connectors");
    const { isError } = await call(client, "remove_connector", {
      slug: "notes-personal",
    });
    expect(isError).toBe(false);
    expect(runtime.config().servers.map((s) => s.slug)).toEqual([
      "connectors",
      "resident",
    ]);
    await client.close();
  });

  it("404s a slug that is not there rather than inventing one", async () => {
    const client = await connect(gatewayUrl, "connectors");
    for (const tool of ["get_connector", "remove_connector"]) {
      const { isError, body } = await call(client, tool, { slug: "ghost" });
      expect(isError, tool).toBe(true);
      expect(String(body.error), tool).toContain("No connector called ghost");
    }
    await client.close();
  });
});

describe("the OAuth handoff an agent can actually perform", () => {
  it("hands back a URL for a human and the path the credential lands at", async () => {
    const client = await connect(gatewayUrl, "connectors");
    await call(client, "save_connector", {
      entry: {
        slug: "upstream-oauth",
        kind: "remote-http",
        url: "https://api.example.com/mcp",
        entitlements: ["admin"],
        oauthRefresh: {
          tokenUrl: "https://api.example.com/oauth/token",
          clientId: "cid",
          clientSecret: "${UPSTREAM_OAUTH_CLIENT_SECRET}",
          refreshToken: "${UPSTREAM_OAUTH_REFRESH_TOKEN}",
        },
      },
    });

    const { body } = await call(client, "describe_connector_authorization", {
      slug: "upstream-oauth",
    });
    expect(body.flow).toBe("oauth-refresh");
    // The half an agent cannot do, named as such rather than attempted.
    expect(body.completedBy).toBe("human");
    expect(body.humanUrl).toBe("https://strad.example.com/ui/upstream-oauth");
    expect(body.credentialPath).toBe(
      "/strad/test/mcp/upstream-oauth/static/UPSTREAM_OAUTH_REFRESH_TOKEN",
    );
    expect(String(body.instructions)).toContain("agent cannot");

    await call(client, "remove_connector", { slug: "upstream-oauth" });
    await client.close();
  });

  it("says plainly when a connector needs no flow at all", async () => {
    const client = await connect(gatewayUrl, "connectors");
    const { body } = await call(client, "describe_connector_authorization", {
      slug: "resident",
    });
    expect(body.flow).toBe("none");
    expect(body.completedBy).toBeNull();
    await client.close();
  });
});

describe("what withholds the write tools", () => {
  it("lists only the read tools when the roster cannot be persisted", async () => {
    const readOnlyStore: ConfigStore = {
      backend: "gcp-parameter-store",
      writable: false,
      read: () => Promise.resolve(EMPTY_OVERLAY),
      write: () => Promise.reject(new Error("read-only")),
    };
    const booted = await boot(gatewayConfig, readOnlyStore);
    try {
      const client = await connect(booted.url, "connectors");
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "connectors__describe_connector_authorization",
        "connectors__get_connector",
        "connectors__list_connectors",
      ]);
      await client.close();
    } finally {
      booted.server.close();
    }
  });

  it("lists NOTHING when the deployment keeps its roster in the checked-in file", async () => {
    // `gateway.configStore:` off is the default, and the default must change
    // nothing: no surface appears on either door. A tool that answers "this
    // gateway has no runtime roster" to every call is not a tool.
    const booted = await boot(gatewayConfig, null);
    try {
      const client = await connect(booted.url, "connectors");
      expect((await client.listTools()).tools).toEqual([]);
      await client.close();
    } finally {
      booted.server.close();
    }
  });

  it("lists NOTHING in a process that has no roster holder at all", async () => {
    // A bundle-mode process, or any build that does not pass `runtime`. The
    // builtin is mounted and there is nothing behind it, so it offers nothing
    // rather than offering tools that answer "not here" to every call.
    const registry = await Registry.build({
      config: gatewayConfig,
      secrets: sharedSecretProviders(new EnvSecretProvider(env)),
      mode: "core",
      env,
    });
    try {
      const adapter = registry.get("connectors");
      expect(await adapter?.listTools()).toEqual([]);
    } finally {
      await registry.close();
    }
  });

  it("honours a tools: allow policy, so a deployment can mount the read half", async () => {
    const narrowed = parseConfig(
      GATEWAY_YAML.replace(
        `    entitlements: [admin]
  - slug: resident`,
        `    entitlements: [admin]
    tools:
      allow: [list_connectors, get_connector]
  - slug: resident`,
      ),
    );
    const booted = await boot(narrowed, new MemoryConfigStore());
    try {
      const client = await connect(booted.url, "connectors");
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "connectors__get_connector",
        "connectors__list_connectors",
      ]);
      // And the policy is enforced on the CALL, not only on the list.
      await expect(
        client.callTool({
          name: "connectors__save_connector",
          arguments: { entry: { slug: "x", kind: "remote-http" } },
        }),
      ).rejects.toThrow();
      await client.close();
    } finally {
      booted.server.close();
    }
  });
});
