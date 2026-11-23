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
  type ServerSecretProviders,
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
/** A narrow role, for the one suite that asks what a write is worth to one. */
const fleetToken = mintToken({ env: "test", label: "fleet", roles: ["fleet"] });
const upstreamToken = mintToken({
  env: "test",
  label: "upstream",
  roles: ["admin"],
});

const env: NodeJS.ProcessEnv = {
  STRAD_TOKENS: JSON.stringify([mcpToken.record, fleetToken.record]),
  // What a deploy binds for a rendered bundle. Only the re-point suite below
  // declares one; without it a supplementary write is refused as unreachable
  // before it is ever judged on its path.
  STRAD_BUNDLE_URL_BUNDLE: "http://bundle.internal:8080",
};

/**
 * The per-slug namespaces a store-backed deployment would hold.
 *
 * A runtime-authored entry resolves its `${NAME}` refs against its OWN
 * namespace and nothing else (`forServerIsolated`), so a credential for one has
 * to be here rather than in `env` — which is exactly the production shape, and
 * exactly what stops a runtime `url:` reaching core's environment. Modelled
 * rather than faked away, because a test that put the credential in `env` would
 * pass only by exercising the chain this feature is not allowed to use.
 */
const slugSecrets: Record<string, Record<string, string>> = {
  "notes-personal": { NOTES_TOKEN: upstreamToken.plaintext },
  "notes-work": { NOTES_TOKEN: upstreamToken.plaintext },
};

function providers(): ServerSecretProviders {
  const shared = new EnvSecretProvider(env);
  return {
    shared,
    forServer: () => shared,
    forServerIsolated: (slug) => ({
      name: "slug-namespace",
      get: (variable) => Promise.resolve(slugSecrets[slug]?.[variable] ?? null),
      invalidate: () => undefined,
    }),
    invalidate: () => shared.invalidate(),
  };
}

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
  baseDoc: unknown = gatewayDoc,
): Promise<{ url: string; server: Server; runtime: RuntimeConfig }> {
  const runtimeRef: { current: RuntimeConfig | null } = { current: null };
  const build = async (next: StradConfig) => {
    const registry = await Registry.build({
      config: next,
      secrets: providers(),
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
    baseDocument: baseDoc,
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

async function connect(
  base: string,
  servers: string,
  token: string = mcpToken.plaintext,
): Promise<Client> {
  const url = new URL(`${base}/mcp`);
  url.searchParams.set("servers", servers);
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
      "connectors__restore_connector",
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
        headers: { Authorization: "Bearer ${NOTES_TOKEN}" },
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
    // The credential came back as the ref it is, so the copy below carries a
    // working connector rather than a redaction.
    expect(entry.headers).toEqual({ Authorization: "Bearer ${NOTES_TOKEN}" });

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

describe("the guards on the write tools", () => {
  it("refuses a RENAME that would land on another entry", async () => {
    const client = await connect(gatewayUrl, "connectors");
    await call(client, "save_connector", {
      entry: {
        slug: "one",
        kind: "remote-http",
        url: "https://one/mcp",
        entitlements: ["admin"],
      },
    });
    await call(client, "save_connector", {
      entry: {
        slug: "two",
        kind: "remote-http",
        url: "https://two/mcp",
        entitlements: ["admin"],
      },
    });

    const { isError, body } = await call(client, "save_connector", {
      previousSlug: "one",
      entry: {
        slug: "two",
        kind: "remote-http",
        url: "https://renamed/mcp",
        entitlements: ["admin"],
      },
    });
    expect(isError).toBe(true);
    expect(String(body.error)).toContain("already exists");
    // Neither entry moved.
    expect(runtime.config().servers.map((s) => s.slug)).toEqual(
      expect.arrayContaining(["one", "two"]),
    );

    await call(client, "remove_connector", { slug: "one" });
    await call(client, "remove_connector", { slug: "two" });
    await client.close();
  });

  it("refuses a non-boolean `enabled` rather than coercing it", async () => {
    // `inputSchema` is documentation, not a runtime validator: `!== false`
    // would have ENABLED a server on the string "false".
    const client = await connect(gatewayUrl, "connectors");
    const { isError, body } = await call(client, "set_connector_enabled", {
      slug: "resident",
      enabled: "false",
    });
    expect(isError).toBe(true);
    expect(String(body.error)).toContain("must be a boolean");
    expect(
      runtime.config().servers.find((s) => s.slug === "resident")?.enabled,
    ).toBe(true);
    await client.close();
  });

  it("REFUSES a save that would store a credential VALUE", async () => {
    // The third bound on what a runtime write may reach: the overlay parameter
    // is non-secret, so a literal saved here is a credential at rest in the
    // clear. `test/config.secret-position.test.ts` has the rule; this is the
    // door.
    const client = await connect(gatewayUrl, "connectors");
    const entry = {
      slug: "leaky",
      kind: "remote-http",
      url: "https://leaky/mcp",
      entitlements: ["admin"],
      headers: {
        Authorization: "Bearer super-secret-literal",
        "X-Key": "${LEAKY_KEY}",
      },
    };
    const refused = await call(client, "save_connector", { entry });
    expect(refused.isError).toBe(true);
    expect(String(refused.body.error)).toContain("Authorization:");
    // The refusal is returned to the caller, so it must not quote what it
    // refused — and the header that WAS a ref is not blamed for it.
    expect(String(refused.body.error)).not.toContain("super-secret-literal");
    expect(String(refused.body.error)).not.toContain("X-Key");
    expect(runtime.config().servers.map((s) => s.slug)).not.toContain("leaky");

    // The same connector with the value NAMED instead is accepted, and comes
    // back whole: naming the parameter is the point of the field.
    const named = {
      ...entry,
      headers: {
        Authorization: "Bearer ${LEAKY_TOKEN}",
        "X-Key": "${LEAKY_KEY}",
      },
    };
    expect(
      (await call(client, "save_connector", { entry: named })).isError,
    ).toBe(false);
    const { body } = await call(client, "get_connector", { slug: "leaky" });
    expect((body.entry as { headers: unknown }).headers).toStrictEqual(
      named.headers,
    );

    await call(client, "remove_connector", { slug: "leaky" });
    await client.close();
  });

  it("still redacts a literal out of an entry the CHECKED-IN config declares", async () => {
    // Which is the only way one can reach `get_connector` at all. A
    // deployment mounts the read tools precisely so an agent can browse a
    // roster it did not author, and that roster is not bound by the rule above.
    const literalYaml = GATEWAY_YAML.replace(
      `    title: A checked-in one
    entitlements: [admin]`,
      `    title: A checked-in one
    entitlements: [admin]
    headers:
      Authorization: "Bearer checked-in-literal"
      X-Key: "\${RESIDENT_KEY}"`,
    );
    const booted = await boot(
      parseConfig(literalYaml),
      new MemoryConfigStore(),
      EMPTY_OVERLAY,
      parseYamlDocument(literalYaml),
    );
    try {
      const client = await connect(booted.url, "connectors");
      const { body } = await call(client, "get_connector", {
        slug: "resident",
      });
      const headers = (body.entry as { headers: Record<string, string> })
        .headers;
      expect(headers.Authorization).not.toContain("checked-in-literal");
      expect(headers.Authorization).toContain("redacted");
      expect(headers["X-Key"]).toBe("${RESIDENT_KEY}");

      // A copy-and-save round trip is refused rather than writing the sentinel
      // in as the value.
      const copied = await call(client, "save_connector", {
        entry: { ...(body.entry as Record<string, unknown>), slug: "copied" },
      });
      expect(copied.isError).toBe(true);
      expect(String(copied.body.error)).toContain("redact");

      // Disabling re-upserts the entry, so it would copy the checked-in literal
      // into the store; `apply` refuses it and the message names the way out.
      const disabled = await call(client, "set_connector_enabled", {
        slug: "resident",
        enabled: false,
      });
      expect(disabled.isError).toBe(true);
      expect(String(disabled.body.error)).toContain("Authorization:");
      expect(String(disabled.body.error)).not.toContain("checked-in-literal");
      expect(String(disabled.body.error)).toContain(
        "removing it is always allowed",
      );
      expect(booted.runtime.overlay().servers.upserts).toEqual([]);

      // Removal stores no entry, so it is not judged — it is the way out.
      const removed = await call(client, "remove_connector", {
        slug: "resident",
      });
      expect(removed.isError).toBe(false);
      expect(booted.runtime.overlay().servers.removals).toEqual(["resident"]);
      expect(JSON.stringify(booted.runtime.overlay())).not.toContain(
        "checked-in-literal",
      );
      await client.close();
    } finally {
      booted.server.close();
    }
  });

  it("reports removals and can restore one", async () => {
    const client = await connect(gatewayUrl, "connectors");

    // `resident` comes from the checked-in document, so removing it records a
    // removal rather than dropping an upsert.
    await call(client, "remove_connector", { slug: "resident" });
    const after = await call(client, "list_connectors");
    expect(after.body.removed).toEqual(["resident"]);
    expect(
      (after.body.connectors as { slug: string }[]).map((c) => c.slug),
    ).not.toContain("resident");

    const restored = await call(client, "restore_connector", {
      slug: "resident",
    });
    expect(restored.isError).toBe(false);
    expect(restored.body.removed).toEqual([]);
    expect(runtime.config().servers.map((s) => s.slug)).toContain("resident");
    await client.close();
  });

  it("refuses restoring something that was not removed", async () => {
    const client = await connect(gatewayUrl, "connectors");
    const { isError, body } = await call(client, "restore_connector", {
      slug: "resident",
    });
    expect(isError).toBe(true);
    expect(String(body.error)).toContain("not a removed connector");
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
          authorizeParams: { access_type: "offline", prompt: "consent" },
        },
      },
    });
    const read = await call(client, "get_connector", {
      slug: "upstream-oauth",
    });
    expect(JSON.stringify(read.body)).toContain('"access_type":"offline"');

    const { body } = await call(client, "describe_connector_authorization", {
      slug: "upstream-oauth",
    });
    expect(body.flow).toBe("oauth-refresh");
    // The half an agent cannot do, named as such rather than attempted.
    expect(body.completedBy).toBe("human");
    expect(body.humanUrl).toBe("https://strad.example.com/ui/upstream-oauth");
    expect(body.credentialPath).toBe(
      "/strad/test/mcp/upstream-oauth/oauth/UPSTREAM_OAUTH_REFRESH_TOKEN",
    );
    expect(String(body.instructions)).toContain("agent cannot");
    expect(String(body.instructions)).toContain("Connect button");

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

describe("re-pointing a checked-in mount over /mcp", () => {
  /**
   * The escalation, driven the way it was measured: a real MCP client, an
   * entitled caller, `save_connector` moving nothing but `path:`.
   *
   * `shop` and `vault` are two mounts in ONE container. `vault` is admin-only
   * and tool-narrowed; `shop` carries no tools policy and the fleet role
   * reaches it. Re-pointing `shop` at `/vault` would take `shop`'s roles to
   * `vault`'s credential and inherit neither of `vault`'s protections, because
   * an allow-list stays attached to the slug that declares it. Before the fix
   * this call returned ok.
   */
  const YAML = `
version: 1
gateway:
  name: strad
  env: test
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
  fleet: { servers: [connectors, shop] }
bundles:
  - name: bundle
servers:
  - slug: connectors
    kind: builtin
    module: "./servers/connectors.js"
    bundle: core
    entitlements: [admin, fleet]
  - slug: shop
    kind: supplementary-image
    image: ghcr.io/example/bundle:latest
    bundle: bundle
    path: /shop
    entitlements: [admin, fleet]
  - slug: vault
    kind: supplementary-image
    image: ghcr.io/example/bundle:latest
    bundle: bundle
    path: /vault
    entitlements: [admin]
    tools:
      allow: [read_item]
`;

  let booted: { url: string; server: Server; runtime: RuntimeConfig };

  beforeAll(async () => {
    booted = await boot(
      parseConfig(YAML),
      new MemoryConfigStore(),
      EMPTY_OVERLAY,
      parseYamlDocument(YAML),
    );
  });

  afterAll(() => booted?.server.close());

  /** The entry as `get_connector` hands it back, with one field moved. */
  async function saveWith(
    client: Client,
    change: Record<string, unknown>,
  ): Promise<{ isError: boolean; body: Record<string, unknown> }> {
    const { body } = await call(client, "get_connector", { slug: "shop" });
    const entry = body.entry as Record<string, unknown>;
    return call(client, "save_connector", { entry: { ...entry, ...change } });
  }

  it("names path: among the fields only a deploy can move", async () => {
    const client = await connect(booted.url, "connectors");
    const { body } = await call(client, "get_connector", { slug: "shop" });
    expect(body.immutableFields).toContain("path");
    await client.close();
  });

  it("REFUSES a save that moves nothing but path:", async () => {
    const client = await connect(booted.url, "connectors");
    const refused = await saveWith(client, { path: "/vault" });
    expect(refused.isError).toBe(true);
    expect(String(refused.body.error)).toContain("path");
    // Nothing was written: the slug still serves the mount the file gave it.
    expect(
      booted.runtime.config().servers.find((srv) => srv.slug === "shop"),
    ).toMatchObject({ path: "/shop" });
    expect(booted.runtime.overlay().revision).toBe(0);
    await client.close();
  });

  it("REFUSES it through remove-then-recreate, which is two calls, not one", async () => {
    const client = await connect(booted.url, "connectors");
    const { body } = await call(client, "get_connector", { slug: "shop" });
    const entry = body.entry as Record<string, unknown>;

    const removed = await call(client, "remove_connector", { slug: "shop" });
    expect(removed.isError).toBe(false);
    try {
      const recreated = await call(client, "save_connector", {
        entry: { ...entry, path: "/vault" },
      });
      expect(recreated.isError).toBe(true);
      expect(String(recreated.body.error)).toContain("path");
    } finally {
      await call(client, "restore_connector", { slug: "shop" });
      await client.close();
    }
  });

  it("still saves an ordinary edit to the same entry", async () => {
    // The bound has to be narrow enough that the feature still works: a title
    // change on a checked-in supplementary slug goes through.
    const client = await connect(booted.url, "connectors");
    const saved = await saveWith(client, { title: "The shop" });
    expect(saved.isError).toBe(false);
    expect(
      booted.runtime.config().servers.find((srv) => srv.slug === "shop"),
    ).toMatchObject({ title: "The shop", path: "/shop" });
    await client.close();
  });

  it("still lets a NEW slug be pointed at a mount that is already deployed", async () => {
    // The `gmail-ro` / `gmail-rw` pattern, which is the point of the feature.
    // Nothing in the checked-in document is being overruled.
    const client = await connect(booted.url, "connectors");
    const created = await call(client, "save_connector", {
      entry: {
        slug: "vault-copy",
        kind: "supplementary-image",
        image: "ghcr.io/example/bundle:latest",
        bundle: "bundle",
        path: "/vault",
        entitlements: ["admin"],
      },
    });
    expect(created.isError).toBe(false);
    expect(booted.runtime.config().servers.map((srv) => srv.slug)).toContain(
      "vault-copy",
    );
    await client.close();
  });

  /**
   * The same bound, through the whole `/mcp` stack rather than against
   * `RuntimeConfig` directly.
   *
   * This is the part a unit test cannot show: the bound reads the principal that
   * AUTHENTICATED the request, so it is only real if that principal survives
   * router -> buildGatewayServer -> the adapter -> the builtin's call context. A
   * bound that silently received `undefined` here would refuse nothing and every
   * test against `assertAcceptable` would still pass.
   */
  describe("and the bound reads the principal the request authenticated", () => {
    it("REFUSES a narrow role's create onto the mount it cannot reach", async () => {
      const client = await connect(
        booted.url,
        "connectors",
        fleetToken.plaintext,
      );
      const refused = await call(client, "save_connector", {
        entry: {
          slug: "fleet-vault",
          kind: "supplementary-image",
          image: "ghcr.io/example/bundle:latest",
          bundle: "bundle",
          path: "/vault",
          entitlements: ["fleet"],
        },
      });
      expect(refused.isError).toBe(true);
      expect(String(refused.body.error)).toContain("bundle/vault");
      // Nothing was written, and the roster did not move.
      expect(
        booted.runtime.config().servers.map((srv) => srv.slug),
      ).not.toContain("fleet-vault");
      await client.close();
    });

    it("ALLOWS the same role onto the mount the checked-in config gave it", async () => {
      const client = await connect(
        booted.url,
        "connectors",
        fleetToken.plaintext,
      );
      const created = await call(client, "save_connector", {
        entry: {
          slug: "fleet-shop",
          kind: "supplementary-image",
          image: "ghcr.io/example/bundle:latest",
          bundle: "bundle",
          path: "/shop",
          entitlements: ["fleet"],
        },
      });
      expect(created.isError).toBe(false);
      expect(booted.runtime.config().servers.map((srv) => srv.slug)).toContain(
        "fleet-shop",
      );
      await call(client, "remove_connector", { slug: "fleet-shop" });
      await client.close();
    });
  });
});
