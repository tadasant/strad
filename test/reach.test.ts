import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { componentToken } from "../src/auth/internal-token.ts";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig, parseYamlDocument } from "../src/config/load.ts";
import {
  AccessControlChanged,
  assertNoAccessControlChange,
} from "../src/config/overlay.ts";
import {
  activeGrants,
  pinViolation,
  reachIssues,
} from "../src/config/reach.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * Flow-through: `reaches:` / `reachableFrom:` (src/config/reach.ts) and the
 * `/_strad/reach/{slug}/mcp` route that serves a grant (src/http/reach.ts).
 *
 * The route is driven end to end over a real socket with the real MCP SDK
 * client, the way a hosted server calls it. The targets are `echo` builtins so
 * the call lands somewhere observable without a network.
 */

const ROOT = "InternalTokenRootNeverShown";
const IMAGE = "ghcr.io/tadasant/strad-bundle-internal:latest";

const YAML = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle-internal
  - name: bundle-other
servers:
  - slug: showcase
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle-internal
    path: /showcase
    entitlements: [admin]
    reaches:
      - slug: sheet
        tools: [echo]
        pin: { text: "the-one-sheet" }
      - slug: whoami-only
        tools: [whoami]
  - slug: neighbour
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle-internal
    path: /neighbour
    entitlements: [admin]
  - slug: elsewhere
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-other
    path: /elsewhere
    entitlements: [admin]
  - slug: sheet
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
    reachableFrom: [showcase]
  - slug: whoami-only
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
    reachableFrom: [showcase]
  - slug: unreached
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`;

/** A one-server config around a grant, for the schema rules. */
function withGrant(grant: string, target: string, extraServers = ""): string {
  return `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles: [{ name: b }]
servers:
  - slug: src
    kind: supplementary-image
    image: ${IMAGE}
    bundle: b
    path: /src
    entitlements: [admin]
${grant}
  - slug: tgt
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
${target}
${extraServers}`;
}

const GRANT = `    reaches:
      - slug: tgt
        tools: [echo]`;
const CONSENT = `    reachableFrom: [src]`;

/** The config:check verdict on a document (scripts/check-config.ts). */
const issuesOf = (yaml: string) =>
  reachIssues(parseConfig(yaml))
    .map((i) => i.message)
    .join("\n");

describe("the reaches: rules (config:check)", () => {
  it("accepts a grant both sides agree on", () => {
    expect(issuesOf(withGrant(GRANT, CONSENT))).toBe("");
    const cfg = parseConfig(withGrant(GRANT, CONSENT));
    const src = cfg.servers.find((s) => s.slug === "src");
    expect(src).toMatchObject({
      reaches: [{ slug: "tgt", tools: ["echo"], pin: {} }],
    });
  });

  it("defaults both halves to nothing, so no server reaches by omission", () => {
    const cfg = parseConfig(withGrant("", ""));
    expect(cfg.servers[0]).toMatchObject({ reaches: [], reachableFrom: [] });
  });

  it("refuses a grant the target has not consented to", () => {
    expect(issuesOf(withGrant(GRANT, ""))).toMatch(
      /does not list it under reachableFrom/,
    );
  });

  it("refuses consent nobody's grant matches", () => {
    expect(issuesOf(withGrant("", CONSENT))).toMatch(
      /declares no reaches: grant for it/,
    );
  });

  it("refuses a target that is not configured", () => {
    const grant = `    reaches:
      - slug: ghost
        tools: [echo]`;
    expect(issuesOf(withGrant(grant, ""))).toMatch(/not a configured server/);
  });

  it("refuses a tool the target's own tools: policy withholds", () => {
    // The grant can never exceed what the target serves to anyone.
    const target = `${CONSENT}
    tools: { allow: [whoami] }`;
    expect(issuesOf(withGrant(GRANT, target))).toMatch(
      /own tools: policy withholds/,
    );
  });

  it("refuses an empty tool list", () => {
    const grant = `    reaches:
      - slug: tgt
        tools: []`;
    expect(() => parseConfig(withGrant(grant, CONSENT))).toThrow();
  });

  it("refuses a chain: a target that itself reaches onward", () => {
    const extra = `  - slug: mid
    kind: supplementary-image
    image: ${IMAGE}
    bundle: b
    path: /mid
    entitlements: [admin]
    reachableFrom: [src]
    reaches:
      - slug: tgt
        tools: [echo]`;
    const grant = `    reaches:
      - slug: mid
        tools: [anything]`;
    const target = `    reachableFrom: [mid]`;
    expect(issuesOf(withGrant(grant, target, extra))).toMatch(
      /one hop; chains are refused/,
    );
  });

  it("boots with a dangling half, which serves nothing", () => {
    // A runtime removal of either half must stay possible: it is the kill
    // switch. So the schema accepts it, and the grant is simply inactive.
    const cfg = parseConfig(withGrant(GRANT, ""));
    expect(activeGrants(cfg, "src")).toEqual([]);
    expect(
      activeGrants(parseConfig(withGrant(GRANT, CONSENT)), "src"),
    ).toHaveLength(1);
  });

  it("serves neither of two grants onto one target", () => {
    const twice = `    reaches:
      - slug: tgt
        tools: [echo]
      - slug: tgt
        tools: [whoami]`;
    expect(issuesOf(withGrant(twice, CONSENT))).toMatch(/twice/);
    expect(activeGrants(parseConfig(withGrant(twice, CONSENT)), "src")).toEqual(
      [],
    );
  });

  it("refuses a local-tunnel target, and never serves one", () => {
    const yaml = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles: [{ name: b }]
servers:
  - slug: src
    kind: supplementary-image
    image: ${IMAGE}
    bundle: b
    path: /src
    entitlements: [admin]
${GRANT}
  - slug: tgt
    kind: local-tunnel
    url: https://tunnel.example.com/mcp
    entitlements: [admin]
${CONSENT}
`;
    expect(issuesOf(yaml)).toMatch(/a local-tunnel/);
    expect(activeGrants(parseConfig(yaml), "src")).toEqual([]);
  });

  it("refuses an unknown key on a grant", () => {
    const grant = `    reaches:
      - slug: tgt
        tools: [echo]
        everything: true`;
    expect(() => parseConfig(withGrant(grant, CONSENT))).toThrow();
  });
});

describe("pinViolation", () => {
  it("passes exact values and refuses anything else", () => {
    const pin = { spreadsheet_id: "abc", n: 1 };
    expect(pinViolation(pin, { spreadsheet_id: "abc", n: 1, x: 2 })).toBe(null);
    expect(pinViolation(pin, { spreadsheet_id: "abd", n: 1 })).toBe(
      "spreadsheet_id",
    );
    // No normalisation: "1" is not 1, and absent is a violation.
    expect(pinViolation(pin, { spreadsheet_id: "abc", n: "1" })).toBe("n");
    expect(pinViolation(pin, { n: 1 })).toBe("spreadsheet_id");
    expect(pinViolation(undefined, {})).toBe(null);
  });
});

describe("a runtime write cannot touch a grant", () => {
  const base = parseYamlDocument(YAML);

  it("refuses adding reachableFrom to a checked-in slug", () => {
    expect(() =>
      assertNoAccessControlChange(base, {
        slug: "unreached",
        kind: "builtin",
        module: "./servers/echo.js",
        entitlements: ["admin"],
        reachableFrom: ["showcase"],
      }),
    ).toThrow(AccessControlChanged);
  });

  it("refuses reaches: on a slug only the overlay declares", () => {
    // Unlike entitlements:, overlay-only slugs are bound too.
    expect(() =>
      assertNoAccessControlChange(base, {
        slug: "new-thing",
        kind: "supplementary-image",
        image: IMAGE,
        bundle: "bundle-internal",
        path: "/showcase",
        entitlements: ["admin"],
        reaches: [{ slug: "sheet", tools: ["echo"] }],
      }),
    ).toThrow(/cannot be written at runtime/);
  });

  it("lets an edit through that carries the checked-in grant unchanged", () => {
    const declared = (
      base as { servers: Record<string, unknown>[] }
    ).servers.find((s) => s.slug === "sheet")!;
    expect(() =>
      assertNoAccessControlChange(base, { ...declared }),
    ).not.toThrow();
  });
});

describe("/_strad/reach/{slug}/mcp", () => {
  const config = parseConfig(YAML);
  const env: NodeJS.ProcessEnv = {
    STRAD_MODE: "core",
    STRAD_INTERNAL_TOKEN: ROOT,
    STRAD_BUNDLE_URL_BUNDLE_INTERNAL: "http://bundle-internal:8080",
    STRAD_BUNDLE_URL_BUNDLE_OTHER: "http://bundle-other:8080",
  };
  let server: Server;
  let base: string;

  beforeAll(async () => {
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
    });
    server = createServer(app);
    server.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => {
    server.close();
  });

  async function connect(slug: string, token: string): Promise<Client> {
    const client = new Client({ name: "reach-test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`${base}/_strad/reach/${slug}/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } },
      ),
    );
    return client;
  }

  const internal = componentToken(ROOT, "bundle-internal");

  it("lists exactly the granted tools, namespaced by target", async () => {
    const client = await connect("showcase", internal);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["sheet__echo", "whoami-only__whoami"]);
    await client.close();
  });

  it("serves a call that honours the pin", async () => {
    const client = await connect("showcase", internal);
    const result = await client.callTool({
      name: "sheet__echo",
      arguments: { text: "the-one-sheet" },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("the-one-sheet");
    await client.close();
  });

  it("refuses a call that breaks the pin, before the target runs", async () => {
    const client = await connect("showcase", internal);
    await expect(
      client.callTool({ name: "sheet__echo", arguments: { text: "other" } }),
    ).rejects.toThrow(/argument "text" is not allowed/);
    await client.close();
  });

  it("refuses an argument the tool does not declare, under a pin", async () => {
    // A pin names one spelling of the resource; an undeclared second spelling
    // must not walk around it.
    const client = await connect("showcase", internal);
    await expect(
      client.callTool({
        name: "sheet__echo",
        arguments: { text: "the-one-sheet", spreadsheetId: "another" },
      }),
    ).rejects.toThrow(/not allowed/);
    await client.close();
  });

  it("refuses a tool the grant does not name, on a granted target", async () => {
    const client = await connect("showcase", internal);
    await expect(
      client.callTool({ name: "sheet__whoami", arguments: {} }),
    ).rejects.toThrow(/not permitted/);
    await client.close();
  });

  it("refuses a slug that is not granted", async () => {
    const client = await connect("showcase", internal);
    await expect(
      client.callTool({ name: "unreached__whoami", arguments: {} }),
    ).rejects.toThrow(/not selected/);
    await client.close();
  });

  it("serves no resources", async () => {
    const client = await connect("showcase", internal);
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    await client.close();
  });

  async function post(slug: string, token?: string): Promise<Response> {
    return fetch(`${base}/_strad/reach/${slug}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  }

  it("401s without a component token, and for the root itself", async () => {
    expect((await post("showcase")).status).toBe(401);
    expect((await post("showcase", ROOT)).status).toBe(401);
  });

  it("403s another component speaking for the slug", async () => {
    // bundle-other holds a valid token of its own, but showcase is not on it.
    const other = componentToken(ROOT, "bundle-other");
    expect((await post("showcase", other)).status).toBe(403);
  });

  it("403s a slug on the caller's component that holds no grant", async () => {
    expect((await post("neighbour", internal)).status).toBe(403);
  });
});
