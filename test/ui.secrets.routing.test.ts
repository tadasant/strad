import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  normalisePathPrefix,
  validateNamespace,
  validatePathPrefix,
} from "../src/secrets/parameters/index.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";
import { selectNamespace } from "../src/ui/index.ts";
import {
  classifyPath,
  paramsConsumers,
  resolverConfigured,
} from "../src/ui/param-routing.ts";

/**
 * The console's parameters page as an ADDRESSING surface, and as a page that
 * tells the truth about where a value goes.
 *
 * Three properties, none of which the older ui.secrets suite touches:
 *
 *   1. MULTI-NAMESPACE. `SECRETS_NAMESPACES` is a list, and the picker, the
 *      listing and every write follow `?ns=` / the `ns` form field. An `ns` that
 *      is not a managed namespace is ignored, because it is the prefix a new
 *      parameter's PATH is built from.
 *   2. PATH PREFIX. A create composes `{namespace}{prefix}{VARIABLE}`, so the
 *      console can write the canonical `{slug}/static/{VAR}` that parameter
 *      resolution reads. `{namespace}{VAR}` alone routes to nothing.
 *   3. THE ROUTING CLAIM. The page states whether anything will read a path, and
 *      that statement is COMPUTED from the running config AND the environment
 *      rather than asserted in prose. This suite is what keeps it honest:
 *      neither a config without a `params: true` server NOR a deployment without
 *      the resolver credential may render a page that says a value is delivered.
 *      Those are two independent conditions and each has its own config below.
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
    // Uppercase collapses onto the SAME parameterId as the lowercase spelling
    // while naming a path no resolver matches. Refuse it rather than explain it.
    expect(validatePathPrefix("GCS/Static/")).not.toBeNull();
  });
});

describe("namespace selection checks SHAPE, not membership", () => {
  const managed = [MCP_NS, GATEWAY_NS];

  it("honours a configured namespace", () => {
    expect(selectNamespace(GATEWAY_NS, managed)).toBe(GATEWAY_NS);
  });

  it("honours a well-formed namespace that is NOT in the list", () => {
    // The configured list is a convenience. The fence is the GCP project, so a
    // human may address any namespace inside it without a redeploy.
    expect(selectNamespace("/strad/test/other/", managed)).toBe(
      "/strad/test/other/",
    );
    expect(selectNamespace("/anything/at/all/", managed)).toBe(
      "/anything/at/all/",
    );
  });

  it("normalises slashes", () => {
    expect(selectNamespace("strad/test/mcp", managed)).toBe(MCP_NS);
    expect(selectNamespace("//strad/test/mcp//", managed)).toBe(MCP_NS);
  });

  it("falls back for anything MALFORMED, so a stale link still lands", () => {
    expect(selectNamespace("/has space/", managed)).toBe(MCP_NS);
    expect(selectNamespace("/../escape/", managed)).toBe(MCP_NS);
    expect(selectNamespace("/UPPER/", managed)).toBe(MCP_NS);
    expect(selectNamespace("/", managed)).toBe(MCP_NS);
    expect(selectNamespace(undefined, managed)).toBe(MCP_NS);
    expect(selectNamespace(["/strad/test/mcp/"], managed)).toBe(MCP_NS);
  });

  it("strict mode restores the list as a LIMIT, and is off by default", () => {
    // Off (the default): an unlisted-but-well-formed namespace is honoured.
    expect(selectNamespace("/strad/test/adhoc/", managed)).toBe(
      "/strad/test/adhoc/",
    );
    // On: the same value falls back, because the list bounds the console again.
    expect(selectNamespace("/strad/test/adhoc/", managed, true)).toBe(MCP_NS);
    // A LISTED namespace still works in strict mode.
    expect(selectNamespace(GATEWAY_NS, managed, true)).toBe(GATEWAY_NS);
  });

  it("refuses a namespace that would cover the whole project", () => {
    expect(validateNamespace("/")).not.toBeNull();
    expect(validateNamespace("")).not.toBeNull();
    expect(validateNamespace("/strad/test/mcp/")).toBeNull();
  });
});

describe("routing is computed from the config, not asserted", () => {
  it("a params: true server's canonical path is delivered, at deploy time", () => {
    const r = classifyPath(CONFIG, `${MCP_NS}wired/static/TOKEN`, true);
    expect(r.state).toBe("delivered");
    expect(r.when).toBe("deploy");
    expect(r.slug).toBe("wired");
  });

  it("a server WITHOUT params: true is stored and delivered nowhere", () => {
    const r = classifyPath(CONFIG, `${MCP_NS}unwired/static/TOKEN`, true);
    expect(r.state).toBe("not-wired");
    expect(r.detail).toContain("params: true");
  });

  it("a path with no {slug}/static/ prefix routes to nothing", () => {
    expect(classifyPath(CONFIG, `${MCP_NS}TOKEN`, true).state).toBe("unrouted");
    expect(classifyPath(CONFIG, `${MCP_NS}wired/oauth/TOKEN`, true).state).toBe(
      "unrouted",
    );
  });

  it("names a slug that is not configured", () => {
    const r = classifyPath(CONFIG, `${MCP_NS}nosuch/static/TOKEN`, true);
    expect(r.state).toBe("unrouted");
    expect(r.detail).toContain("nosuch");
  });

  it("the gateway namespace is not runtime-read under provider: env", () => {
    const r = classifyPath(CONFIG, `${GATEWAY_NS}TOKEN`, true);
    expect(r.state).toBe("not-wired");
    expect(r.detail).toContain("env");
  });

  it("paramsConsumers lists exactly the opted-in servers", () => {
    expect(paramsConsumers(CONFIG).map((c) => c.slug)).toEqual(["wired"]);
  });

  it("`params: true` with NO resolver credential is not delivery", () => {
    // The second half of the condition, and the one a config-only check misses:
    // render-spec warns and ships the component without these values, so the
    // page must not claim otherwise.
    const r = classifyPath(CONFIG, `${MCP_NS}wired/static/TOKEN`, false);
    expect(r.state).toBe("not-wired");
    expect(r.label).toBe("no resolver");
    expect(r.detail).toContain("STRAD_PARAMS");
  });

  it("reads the resolver credential out of the environment", () => {
    expect(resolverConfigured({})).toBe(false);
    expect(resolverConfigured({ STRAD_PARAMS_PROJECT_ID: "p" })).toBe(false);
    expect(
      resolverConfigured({
        STRAD_PARAMS_PROJECT_ID: "p",
        STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON: "{}",
      }),
    ).toBe(true);
  });

  it("a path DEEPER than {slug}/static/{VAR} is still delivered, by its last segment", async () => {
    // resolve() lists everything under `{slug}/static/` and keys on the last
    // segment, so this path IS injected — as TOKEN. Calling it "unrouted" would
    // tell a human a live credential is inert, which is the worse error.
    const r = classifyPath(CONFIG, `${MCP_NS}wired/static/extra/TOKEN`, true);
    expect(r.state).toBe("delivered");
    expect(r.detail).toContain("TOKEN");
    expect(r.detail).toContain("collides");

    // And prove the claim against the store rather than asserting it.
    const probe = createFakeGcp();
    await probe.store.create({
      path: `${MCP_NS}wired/static/extra/TOKEN`,
      secret: false,
      value: "v",
    });
    expect(await probe.store.resolve(`${MCP_NS}wired/static/`)).toEqual({
      TOKEN: "v",
    });
  });

  it("a remote-http slug can never be wired, and says so", () => {
    const r = classifyPath(
      REMOTE_CONFIG,
      "/strad/test/mcp/remote/static/T",
      true,
    );
    expect(r.state).toBe("unrouted");
    expect(r.detail).toContain("remote-http");
  });
});

/** A gateway with NO parameter consumer at all — prod's shape today. */
const NO_CONSUMER_CONFIG = parseConfig(`
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
    consoleEnv:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${MCP_NS}"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
  - slug: unwired
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /unwired
    entitlements: [admin]
`);

const REMOTE_CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
bundles: []
servers:
  - slug: remote
    kind: remote-http
    url: https://example.com/mcp
`);

// --- through the real Express app -------------------------------------------

let fake: FakeGcp;
let server: Server;
let baseUrl: string;

/**
 * Two more apps, because the page's verdict depends on two things the DEFAULT
 * app deliberately lacks.
 *
 *   resolverApp — same config, but STRAD_PARAMS_* present. The only fixture in
 *                 which "delivered" may legitimately appear.
 *   bareApp     — a config with no `params: true` server at all. Prod's shape.
 */
let resolverFake: FakeGcp;
let resolverServer: Server;
let resolverUrl: string;
let bareServer: Server;
let bareUrl: string;

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

  resolverFake = createFakeGcp();
  const resolverEnv: NodeJS.ProcessEnv = {
    ...env,
    STRAD_PARAMS_PROJECT_ID: "demo-project",
    STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON: ADMIN_KEY,
  };
  const resolverApp = createApp({
    config: CONFIG,
    registry: await Registry.build({
      config: CONFIG,
      secrets: new EnvSecretProvider(SECRETS),
      mode: "core",
      env: resolverEnv,
    }),
    tokenStore: tokenStoreFromConfig(CONFIG, resolverEnv),
    mode: "core",
    env: resolverEnv,
    secrets: SECRETS,
    parametersStore: () => resolverFake.store,
  });
  await new Promise<void>((resolve) => {
    resolverServer = resolverApp.listen(0, () => resolve());
  });
  resolverUrl = addressOf(resolverServer);

  const bareFake = createFakeGcp();
  const bareApp = createApp({
    config: NO_CONSUMER_CONFIG,
    registry: await Registry.build({
      config: NO_CONSUMER_CONFIG,
      secrets: new EnvSecretProvider(SECRETS),
      mode: "core",
      env,
    }),
    tokenStore: tokenStoreFromConfig(NO_CONSUMER_CONFIG, env),
    mode: "core",
    env,
    secrets: SECRETS,
    parametersStore: () => bareFake.store,
  });
  await new Promise<void>((resolve) => {
    bareServer = bareApp.listen(0, () => resolve());
  });
  bareUrl = addressOf(bareServer);
});

function addressOf(s: Server): string {
  const addr = s.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

afterAll(() => {
  server?.close();
  resolverServer?.close();
  bareServer?.close();
});

describe("the console addresses every managed namespace", () => {
  it("offers each one in the picker", async () => {
    const html = await get("/ui/secrets");
    expect(html).toContain('id="ns-input"');
    expect(html).toContain(`value="${MCP_NS}"`);
    // The configured list is offered as suggestions, not as the only options.
    expect(html).toContain(`<option value="${GATEWAY_NS}"></option>`);
  });

  it("renders the picker as a dropdown: every namespace is in the popup", async () => {
    const html = await get("/ui/secrets");
    // Discoverable without typing — and never a <select>, which would take the
    // free text with it. A namespace outside the list stays typable.
    expect(html).toContain('<ul class="combo-menu" id="ns-input-listbox"');
    expect(html).not.toContain("<select");
    for (const ns of [MCP_NS, GATEWAY_NS]) {
      expect(html).toMatch(
        new RegExp(
          `<li class="combo-opt" role="option" id="ns-input-o\\d+" data-value="${ns}">`,
        ),
      );
    }
  });

  it("submits on choosing a namespace, and never on choosing a prefix", async () => {
    // The namespace form is a GET navigation, so taking a suggestion may as well
    // go there. The create form is a write: choosing a prefix fills the field and
    // leaves the submit to the human.
    const html = await get("/ui/secrets");
    const nsBox = html.slice(html.indexOf('class="combo combo-ns"'));
    expect(nsBox.slice(0, 80)).toContain("data-combo-submit");
    const pfxBox = html.slice(html.indexOf('<div class="combo" data-combo'));
    expect(pfxBox.slice(0, 80)).not.toContain("data-combo-submit");
  });

  it("keeps the no-JS baseline: an input, a datalist, no dead ARIA", async () => {
    // The script removes `list=` and puts the combobox ARIA on as it takes over.
    // Without it the field is a plain free-text input with the native typeahead,
    // rather than a role=combobox whose aria-expanded nothing can ever flip.
    const html = await get("/ui/secrets");
    expect(html).toContain('list="ns-input-options"');
    expect(html).toContain('<datalist id="ns-input-options">');
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain('aria-expanded="');
    expect(html).toContain(
      "<noscript><style>.combo-caret{display:none}</style>",
    );
  });

  it("gives the path-prefix field the same popup, labelled by wiring", async () => {
    const html = await get("/ui/secrets");
    expect(html).toContain('id="pfx-listbox"');
    expect(html).toContain(
      `<span class="combo-val">wired/static/</span><span class="combo-lbl">wired — params: true</span>`,
    );
    expect(html).toContain('<datalist id="pfx-options">');
    // The help text under the field describes it, and a wrapping <label> can no
    // longer do that job — a click on an option inside one would refocus the input.
    expect(html).toContain('aria-describedby="pfx-help"');
    expect(html).toContain('id="pfx-help"');
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
    expect(second).toContain(`value="${GATEWAY_NS}"`);
  });

  it("a well-formed ?ns= outside the configured list IS honoured", async () => {
    const html = await get("/ui/secrets?ns=%2Fstrad%2Ftest%2Fadhoc%2F");
    expect(html).toContain('value="/strad/test/adhoc/"');
  });

  it("a MALFORMED ?ns= falls back rather than being honoured", async () => {
    const html = await get("/ui/secrets?ns=%2F..%2Fescape%2F");
    expect(html).toContain(`value="${MCP_NS}"`);
    expect(html).not.toContain("escape");
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
    expect(html).toContain(`value="${GATEWAY_NS}"`);
    expect(await fake.store.list(GATEWAY_NS)).toHaveLength(1);
    expect(await fake.store.list(MCP_NS)).toHaveLength(0);
  });

  it("a MALFORMED ns on a POST is an error, not a silent write elsewhere", async () => {
    fake.parameters.clear();
    fake.secrets.clear();

    const res = await post("/ui/secrets/create", {
      ns: "/../escape/",
      prefix: "wired/static/",
      variable: "SNEAKY",
      value: "v",
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("namespace");
    expect(await fake.store.list("/")).toHaveLength(0);
  });

  it("a well-formed ns outside the list writes there, as typed", async () => {
    fake.parameters.clear();
    fake.secrets.clear();

    await post("/ui/secrets/create", {
      ns: "/strad/test/adhoc/",
      prefix: "wired/static/",
      variable: "ADHOC",
      value: "v",
    });

    expect(
      (await fake.store.list("/strad/test/adhoc/")).map((p) => p.path),
    ).toEqual(["/strad/test/adhoc/wired/static/ADHOC"]);
  });
});

describe("a malformed ns cannot steer a non-create action", () => {
  it("rotate/note/delete address `path` only, so `ns` cannot redirect them", async () => {
    fake.parameters.clear();
    fake.secrets.clear();
    await fake.store.create({
      path: `${MCP_NS}wired/static/PINNED`,
      secret: false,
      value: "before",
    });

    // A junk `ns` on each: the action still targets the path it was given, and
    // nothing is written anywhere else.
    await post("/ui/secrets/rotate", {
      ns: "/../junk/",
      path: `${MCP_NS}wired/static/PINNED`,
      value: "after",
    });
    await post("/ui/secrets/note", {
      ns: "/../junk/",
      path: `${MCP_NS}wired/static/PINNED`,
      note: "n",
    });

    const all = await fake.store.list("/");
    expect(all.map((p) => p.path)).toEqual([`${MCP_NS}wired/static/PINNED`]);
    expect(await fake.store.reveal(`${MCP_NS}wired/static/PINNED`)).toBe(
      "after",
    );
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
  it("flags each row from the live config, when a resolver exists", async () => {
    resolverFake.parameters.clear();
    resolverFake.secrets.clear();
    await resolverFake.store.create({
      path: `${MCP_NS}wired/static/DELIVERED`,
      secret: false,
      value: "a",
    });
    await resolverFake.store.create({
      path: `${MCP_NS}unwired/static/STRANDED`,
      secret: false,
      value: "b",
    });

    const res = await fetch(`${resolverUrl}/ui/secrets`, { headers: auth });
    const html = await res.text();
    expect(html).toContain("delivered · deploy");
    expect(html).toContain("not wired");
    expect(html).toContain("<strong>1 of 3</strong>");
  });

  it("a gateway with no params: true server is described as a registry", async () => {
    const res = await fetch(`${bareUrl}/ui/secrets`, { headers: auth });
    const html = await res.text();
    expect(html).toContain(
      "No server on this gateway sets <code>params: true</code>",
    );
    expect(html).toContain("this is a registry");
    // The word "delivered" appears in negations ("stored, delivered nowhere").
    // What must never appear is a POSITIVE claim, which is only ever a chip.
    expect(html).not.toContain("delivered · deploy");
    expect(html).not.toContain("delivered · runtime");
    expect(html).not.toContain("reaches the");
  });

  it("does NOT claim delivery when the deployment has no resolver", async () => {
    // The app under test runs without STRAD_PARAMS_*, which is the shape of
    // staging and prod today. `wired` sets `params: true` and still must not
    // render as delivered.
    fake.parameters.clear();
    fake.secrets.clear();
    await fake.store.create({
      path: `${MCP_NS}wired/static/TOKEN`,
      secret: false,
      value: "a",
    });

    const html = await get("/ui/secrets");
    expect(html).toContain("no resolver");
    expect(html).toContain("carries no resolver credential");
    expect(html).not.toContain("delivered · deploy");
  });

  it("every explanation lives in the Help dialog, not the page body", async () => {
    const html = await get("/ui/secrets");

    // The guide exists, behind a control, in a dialog.
    expect(html).toContain("data-help-open");
    expect(html).toContain('<dialog class="helpdlg"');
    expect(html).toContain("This deployment, right now");
    expect(html).toContain("How a parameter here routes into strad");
    expect(html).toContain("Examples, from this gateway's own servers");
    expect(html).toContain("Secret vs non-secret, and what an agent can see");
    expect(html).toContain("Namespaces, and where the fence actually is");

    // …and every one of those sits INSIDE the dialog, so the working surface
    // above it stays a working surface.
    const body = html.slice(0, html.indexOf('<dialog class="helpdlg"'));
    expect(body).not.toContain("How a parameter here routes into strad");
    expect(body).not.toContain(
      "Secret vs non-secret, and what an agent can see",
    );
    expect(body).not.toContain('details class="acc"');
  });

  it("grounds its examples in this gateway's own servers", async () => {
    const html = await get("/ui/secrets");
    expect(html).toContain("/strad/test/mcp/wired/static/EXAMPLE_TOKEN");
    expect(html).toContain("/strad/test/mcp/unwired/static/EXAMPLE_TOKEN");
    expect(html).toContain("/strad/test/gateway/static/EXAMPLE_TOKEN");
  });
});
