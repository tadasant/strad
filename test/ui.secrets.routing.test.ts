import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  normalisePathPrefix,
  validatePathPrefix,
} from "../src/secrets/parameters/index.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";
import { selectNamespace } from "../src/ui/index.ts";
import { classifyPath, paramsConsumers } from "../src/ui/param-routing.ts";

/**
 * The console's parameters page as an ADDRESSING surface, and as a page that
 * tells the truth about where a value goes.
 *
 * Three things are proven here that the older ui.secrets suite does not touch:
 *
 *   1. MULTI-NAMESPACE. `SECRETS_NAMESPACES` is a list; the store and the MCP
 *      server always handled every entry. The console addressed `[0]` only. The
 *      picker, the listing and every write now follow `?ns=` / the `ns` form
 *      field — and an `ns` that is not a managed namespace is ignored, because it
 *      is the prefix a new parameter's PATH is built from.
 *   2. PATH PREFIX. A create now composes `{namespace}{prefix}{VARIABLE}`, so the
 *      console can write the canonical `{slug}/static/{VAR}` that parameter
 *      resolution actually reads. Without the prefix it could only ever write
 *      `{namespace}{VAR}`, which routes to nothing.
 *   3. THE ROUTING CLAIM. The page states whether anything will read a path, and
 *      that statement is COMPUTED from the running config rather than asserted in
 *      prose. This suite is the thing that keeps it honest: a config with no
 *      `params: true` server must never render a page that says a value is
 *      delivered.
 */

const BOOTSTRAP = "bootstrap-secret-xyz";
const MCP_NS = "/strad/test/mcp/";
const GATEWAY_NS = "/strad/test/gateway/static/";

/**
 * Two managed namespaces, and two server kinds: `wired` opts into parameter
 * resolution, `unwired` does not. That asymmetry is the whole point — a page
 * that renders both the same way is the bug.
 */
const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${MCP_NS}"
      SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${VIEWER_KEY}"
    consoleEnv:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${MCP_NS},${GATEWAY_NS}"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
  - slug: wired
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /wired
    entitlements: [admin]
    params: true
  - slug: unwired
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /unwired
    entitlements: [admin]
`);

const ADMIN_KEY = JSON.stringify({
  client_email: "strad-secrets-admin@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
});
const VIEWER_KEY = JSON.stringify({
  client_email: "strad-secrets-viewer@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
});
const SECRETS = { ADMIN_KEY, VIEWER_KEY };

// --- units ------------------------------------------------------------------

describe("path prefixes", () => {
  it("normalises to a single trailing slash, or empty", () => {
    expect(normalisePathPrefix("")).toBe("");
    expect(normalisePathPrefix("   ")).toBe("");
    expect(normalisePathPrefix("wired/static")).toBe("wired/static/");
    expect(normalisePathPrefix("/wired/static/")).toBe("wired/static/");
  });

  it("accepts slug-shaped segments and refuses traversal", () => {
    expect(validatePathPrefix("")).toBeNull();
    expect(validatePathPrefix("wired/static/")).toBeNull();
    expect(
      validatePathPrefix("remote-filesystem-tmp-public/static"),
    ).toBeNull();
    expect(validatePathPrefix("../escape/")).not.toBeNull();
    expect(validatePathPrefix("has space/static/")).not.toBeNull();
    expect(validatePathPrefix(`${"a".repeat(201)}/`)).not.toBeNull();
  });
});

describe("namespace selection is an allow-list", () => {
  const managed = [MCP_NS, GATEWAY_NS];

  it("honours a managed namespace", () => {
    expect(selectNamespace(GATEWAY_NS, managed)).toBe(GATEWAY_NS);
  });

  it("falls back to the first for anything unmanaged", () => {
    // The value becomes the PREFIX of a written path. An attacker-supplied one
    // must not be honoured, and a stale bookmark should still land somewhere.
    expect(selectNamespace("/strad/prod/mcp/", managed)).toBe(MCP_NS);
    expect(selectNamespace(undefined, managed)).toBe(MCP_NS);
    expect(selectNamespace(["/strad/test/mcp/"], managed)).toBe(MCP_NS);
  });
});

describe("routing is computed from the config, not asserted", () => {
  it("a params: true server's canonical path is delivered, at deploy time", () => {
    const r = classifyPath(CONFIG, `${MCP_NS}wired/static/TOKEN`);
    expect(r.state).toBe("delivered");
    expect(r.when).toBe("deploy");
    expect(r.slug).toBe("wired");
  });

  it("a server WITHOUT params: true is stored and delivered nowhere", () => {
    const r = classifyPath(CONFIG, `${MCP_NS}unwired/static/TOKEN`);
    expect(r.state).toBe("not-wired");
    expect(r.detail).toContain("params: true");
  });

  it("a path with no {slug}/static/ prefix routes to nothing", () => {
    expect(classifyPath(CONFIG, `${MCP_NS}TOKEN`).state).toBe("unrouted");
    expect(classifyPath(CONFIG, `${MCP_NS}wired/oauth/TOKEN`).state).toBe(
      "unrouted",
    );
  });

  it("names a slug that is not configured", () => {
    const r = classifyPath(CONFIG, `${MCP_NS}nosuch/static/TOKEN`);
    expect(r.state).toBe("unrouted");
    expect(r.detail).toContain("nosuch");
  });

  it("the gateway namespace is not runtime-read under provider: env", () => {
    const r = classifyPath(CONFIG, `${GATEWAY_NS}TOKEN`);
    expect(r.state).toBe("not-wired");
    expect(r.detail).toContain("env");
  });

  it("paramsConsumers lists exactly the opted-in servers", () => {
    expect(paramsConsumers(CONFIG).map((c) => c.slug)).toEqual(["wired"]);
  });
});

// --- through the real Express app -------------------------------------------

let fake: FakeGcp;
let server: Server;
let baseUrl: string;

const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

const auth = { authorization: `Bearer ${BOOTSTRAP}` };

async function post(
  path: string,
  fields: Record<string, string>,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

async function get(path: string): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`, { headers: auth });
  return res.text();
}

beforeAll(async () => {
  fake = createFakeGcp();
  const registry = await Registry.build({
    config: CONFIG,
    secrets: new EnvSecretProvider(SECRETS),
    mode: "core",
    env,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    secrets: SECRETS,
    parametersStore: () => fake.store,
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

describe("the console addresses every managed namespace", () => {
  it("offers each one in the picker", async () => {
    const html = await get("/ui/secrets");
    expect(html).toContain('name="ns"');
    expect(html).toContain(`<option value="${MCP_NS}" selected>`);
    expect(html).toContain(`<option value="${GATEWAY_NS}"`);
    expect(html).toContain("2 managed");
  });

  it("lists the SECOND namespace when ?ns= selects it", async () => {
    fake.parameters.clear();
    fake.secrets.clear();
    await fake.store.create({
      path: `${MCP_NS}wired/static/IN_MCP_NS`,
      secret: false,
      value: "a",
    });
    await fake.store.create({
      path: `${GATEWAY_NS}IN_GATEWAY_NS`,
      secret: false,
      value: "b",
    });

    const first = await get("/ui/secrets");
    expect(first).toContain("IN_MCP_NS");
    expect(first).not.toContain("IN_GATEWAY_NS");

    const second = await get(
      `/ui/secrets?ns=${encodeURIComponent(GATEWAY_NS)}`,
    );
    expect(second).toContain("IN_GATEWAY_NS");
    expect(second).not.toContain("IN_MCP_NS");
    expect(second).toContain(`<option value="${GATEWAY_NS}" selected>`);
  });

  it("an unmanaged ?ns= falls back rather than listing it", async () => {
    const html = await get("/ui/secrets?ns=%2Fstrad%2Fprod%2Fmcp%2F");
    expect(html).toContain(`<option value="${MCP_NS}" selected>`);
    expect(html).not.toContain("/strad/prod/mcp/");
  });

  it("a write lands in the SELECTED namespace and stays there", async () => {
    fake.parameters.clear();
    fake.secrets.clear();

    const res = await post("/ui/secrets/create", {
      ns: GATEWAY_NS,
      prefix: "",
      variable: "GATEWAY_LEVEL_TOKEN",
      value: "v",
    });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(`${GATEWAY_NS}GATEWAY_LEVEL_TOKEN`);
    // Still on the namespace the human was looking at, not bounced to the first.
    expect(html).toContain(`<option value="${GATEWAY_NS}" selected>`);
    expect(await fake.store.list(GATEWAY_NS)).toHaveLength(1);
    expect(await fake.store.list(MCP_NS)).toHaveLength(0);
  });

  it("an unmanaged ns on a POST cannot steer the written path", async () => {
    fake.parameters.clear();
    fake.secrets.clear();

    await post("/ui/secrets/create", {
      ns: "/strad/prod/mcp/",
      prefix: "wired/static/",
      variable: "SNEAKY",
      value: "v",
    });

    const written = await fake.store.list("/strad/");
    expect(written.map((p) => p.path)).toEqual([
      `${MCP_NS}wired/static/SNEAKY`,
    ]);
  });
});

describe("a create composes namespace + prefix + variable", () => {
  it("writes the canonical {slug}/static/{VAR} path", async () => {
    fake.parameters.clear();
    fake.secrets.clear();

    const res = await post("/ui/secrets/create", {
      ns: MCP_NS,
      prefix: "wired/static",
      variable: "WIRED_API_TOKEN",
      secret: "on",
      value: "tok",
      note: "routed to the wired server",
    });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(`${MCP_NS}wired/static/WIRED_API_TOKEN`);
    const listed = await fake.store.list(MCP_NS);
    expect(listed.map((p) => p.path)).toEqual([
      `${MCP_NS}wired/static/WIRED_API_TOKEN`,
    ]);
  });

  it("rejects a malformed prefix without writing anything", async () => {
    fake.parameters.clear();
    fake.secrets.clear();

    const res = await post("/ui/secrets/create", {
      ns: MCP_NS,
      prefix: "../escape/",
      variable: "NOPE",
      value: "v",
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("path prefix");
    expect(await fake.store.list(MCP_NS)).toHaveLength(0);
  });

  it("an empty prefix still works — it is optional", async () => {
    fake.parameters.clear();
    fake.secrets.clear();

    await post("/ui/secrets/create", {
      ns: MCP_NS,
      variable: "BARE",
      value: "v",
    });
    expect((await fake.store.list(MCP_NS)).map((p) => p.path)).toEqual([
      `${MCP_NS}BARE`,
    ]);
  });

  it("offers real server slugs as prefix suggestions", async () => {
    const html = await get("/ui/secrets");
    expect(html).toContain('<option value="wired/static/"');
    expect(html).toContain("wired — params: true");
    expect(html).toContain("unwired — not wired");
  });
});

describe("the page says where a value actually goes", () => {
  it("flags each row from the live config", async () => {
    fake.parameters.clear();
    fake.secrets.clear();
    await fake.store.create({
      path: `${MCP_NS}wired/static/DELIVERED`,
      secret: false,
      value: "a",
    });
    await fake.store.create({
      path: `${MCP_NS}unwired/static/STRANDED`,
      secret: false,
      value: "b",
    });

    const html = await get("/ui/secrets");
    expect(html).toContain("delivered · deploy");
    expect(html).toContain("not wired");
  });

  it("counts the wired servers in the always-visible banner", async () => {
    const html = await get("/ui/secrets");
    // 1 of 3 enabled, container-backed servers: secrets, wired, unwired.
    expect(html).toContain("<strong>1 of 3</strong>");
  });

  it("every explanation is behind an accordion, none of it expanded", async () => {
    const html = await get("/ui/secrets");
    const opened = html.match(/<details class="acc" open/g) ?? [];
    expect(opened).toHaveLength(0);
    expect(html).toContain("How a parameter here routes into strad");
    expect(html).toContain("Examples, from this gateway's own servers");
    expect(html).toContain("Secret vs non-secret, and what an agent can see");
    expect(html).toContain("Namespaces, and where the fence actually is");
    // The old always-on posture paragraph is gone from the page body.
    expect(html).not.toContain(
      "Parameter Manager indexes everything; Secret Manager backs the secret parts.</strong>",
    );
  });

  it("grounds its examples in this gateway's own servers", async () => {
    const html = await get("/ui/secrets");
    expect(html).toContain("/strad/test/mcp/wired/static/EXAMPLE_TOKEN");
    expect(html).toContain("/strad/test/mcp/unwired/static/EXAMPLE_TOKEN");
    expect(html).toContain("/strad/test/gateway/static/EXAMPLE_TOKEN");
  });
});
