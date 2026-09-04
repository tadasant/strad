import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";
import { resolveServerView } from "../src/ui/resolve.ts";
import { storeForPath } from "../src/http/params.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * ONE console page, TWO GCP parameter stores.
 *
 * strad's prod console served four pages, one per project — `/ui/secrets`,
 * `/ui/staging-secrets`, `/ui/zimmer-secrets`, `/ui/zimmer-staging-secrets` —
 * and the config called that a hard constraint. It was not: it was a property of
 * one TypeScript type, which now carries a LIST of stores instead of one
 * project. `?project=<gcp id>` selects among them.
 *
 * What is proven here, through the REAL Express app over a REAL socket:
 *
 *   1. Two stores resolve off ONE slug, each with its OWN project, namespaces
 *      and admin identity. NEVER one credential granted on both projects — that
 *      is the simplification this design exists to refuse, and the reason is a
 *      real leaked key (#215) that has never been rotated.
 *   2. The switcher works: `?project=` changes which store's parameters the page
 *      lists, and a write lands in the store the form named.
 *   3. `namespacesStrict` is PER STORE. A namespace that is legitimate in store B
 *      is refused while store A is selected — a union list would wave it through,
 *      which is a bound that does not bind.
 *   4. `reveal` is per store too, for the same reason: a page-level flag would
 *      either offer reveal on a production store or withhold it from a staging
 *      one.
 *   5. A form naming an UNKNOWN store is refused, not silently redirected to the
 *      first one. A write to the wrong project under the wrong service account
 *      that reports success is the one failure here nobody would diagnose.
 *   6. THE /mcp HALF IS UNTOUCHED. The bundle carries ONE store's project and
 *      the viewer key, and NEITHER admin key reaches any bundle.
 */

const BOOTSTRAP = "bootstrap-secret-xyz";

const STRAD_PROJECT = "strad-secrets-prod";
const ZIMMER_PROJECT = "zimmer-secrets-prod";
const STRAD_NS = "/strad/prod/mcp/";
const ZIMMER_NS = "/zimmer/production/mcp/";

const CONFIG_YAML = `
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
      SECRETS_PROJECT_ID: "${STRAD_PROJECT}"
      SECRETS_NAMESPACES: "${STRAD_NS}"
      SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${VIEWER_KEY}"
    consoleEnv:
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${STRAD_ADMIN_KEY}"
      ZIMMER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ZIMMER_ADMIN_KEY}"
    consoleStores:
      - project: "${STRAD_PROJECT}"
        label: strad prod
        namespaces: ["${STRAD_NS}"]
        adminKeyVar: SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
        namespacesStrict: true
      - project: "${ZIMMER_PROJECT}"
        label: zimmer prod
        namespaces: ["${ZIMMER_NS}"]
        adminKeyVar: ZIMMER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
        reveal: true
`;

const CONFIG = parseConfig(CONFIG_YAML);

function key(email: string): string {
  return JSON.stringify({
    client_email: email,
    private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  });
}

const STRAD_ADMIN_KEY = key(
  "strad-secrets-admin@strad.iam.gserviceaccount.com",
);
const ZIMMER_ADMIN_KEY = key(
  "zimmer-secrets-admin@zimmer.iam.gserviceaccount.com",
);
const VIEWER_KEY = key("strad-secrets-viewer@strad.iam.gserviceaccount.com");

const SECRETS = { STRAD_ADMIN_KEY, ZIMMER_ADMIN_KEY, VIEWER_KEY };

const ADMIN_CAPABILITIES = {
  readSecretValues: true,
  writeParameters: true,
  writeSecretValues: true,
  deleteParameters: true,
  probed: true,
};

// --- unit: resolution --------------------------------------------------------

describe("multi-store resolution", () => {
  it("resolves TWO stores off one slug, each with its own project", () => {
    const view = resolveServerView(CONFIG, "secrets", SECRETS);
    expect(view.kind).toBe("secrets");
    if (view.kind !== "secrets") throw new Error("unreachable");

    expect(view.stores.map((s) => s.projectId)).toEqual([
      STRAD_PROJECT,
      ZIMMER_PROJECT,
    ]);
    expect(view.stores.map((s) => s.label)).toEqual([
      "strad prod",
      "zimmer prod",
    ]);
    expect(view.stores[0]!.namespaces).toEqual([STRAD_NS]);
    expect(view.stores[1]!.namespaces).toEqual([ZIMMER_NS]);
  });

  it("gives each store its OWN admin identity, never one key on both projects", () => {
    // NON-NEGOTIABLE. The strad admin key was leaked in cleartext by the #215
    // sync run and has never been rotated; granting it on Zimmer's production
    // store would hand write/delete over Zimmer's prod parameters to everyone
    // who read that log. Two stores is two identities, and the schema requires
    // an adminKeyVar per entry so there is no way to express the collapse.
    const view = resolveServerView(CONFIG, "secrets", SECRETS);
    if (view.kind !== "secrets") throw new Error("unreachable");

    expect(view.stores[0]!.account?.client_email).toBe(
      "strad-secrets-admin@strad.iam.gserviceaccount.com",
    );
    expect(view.stores[1]!.account?.client_email).toBe(
      "zimmer-secrets-admin@zimmer.iam.gserviceaccount.com",
    );
    expect(view.stores[0]!.account?.client_email).not.toBe(
      view.stores[1]!.account?.client_email,
    );
  });

  it("keeps namespacesStrict and reveal PER STORE, not per page", () => {
    const view = resolveServerView(CONFIG, "secrets", SECRETS);
    if (view.kind !== "secrets") throw new Error("unreachable");

    expect(view.stores[0]!.namespacesStrict).toBe(true);
    expect(view.stores[1]!.namespacesStrict).toBe(false);
    expect(view.stores[0]!.revealEnabled).toBe(false);
    expect(view.stores[1]!.revealEnabled).toBe(true);
  });

  it("degrades one store gracefully when only its key is missing", () => {
    // The other store keeps working. A page-level credential would have taken
    // both down, and a fallback to the sibling's key would be the collapse.
    const view = resolveServerView(CONFIG, "secrets", {
      STRAD_ADMIN_KEY,
      VIEWER_KEY,
    });
    if (view.kind !== "secrets") throw new Error("unreachable");

    expect(view.stores[0]!.account).not.toBeNull();
    expect(view.stores[1]!.account).toBeNull();
    expect(view.stores[1]!.accountReason).toMatch(
      /ZIMMER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON/,
    );
    expect(view.stores[1]!.accountReason).toMatch(/not injected/);
  });

  it("still resolves ONE store for a config that declares no consoleStores:", () => {
    // The back-compat half. Prod migrates its four slugs in its own PR, so every
    // config written before this field has to keep rendering the page it did.
    const legacy = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles: [{ name: bundle }]
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    env: { SECRETS_PROJECT_ID: "${STRAD_PROJECT}" }
    consoleEnv:
      SECRETS_PROJECT_ID: "${STRAD_PROJECT}"
      SECRETS_NAMESPACES: "${STRAD_NS}"
      SECRETS_NAMESPACES_STRICT: "true"
      SECRETS_REVEAL_ENABLED: "true"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${STRAD_ADMIN_KEY}"
`);
    const view = resolveServerView(legacy, "secrets", SECRETS);
    if (view.kind !== "secrets") throw new Error("unreachable");

    expect(view.stores).toHaveLength(1);
    const only = view.stores[0]!;
    expect(only.projectId).toBe(STRAD_PROJECT);
    expect(only.label).toBe(STRAD_PROJECT);
    expect(only.namespaces).toEqual([STRAD_NS]);
    expect(only.namespacesStrict).toBe(true);
    expect(only.revealEnabled).toBe(true);
    expect(only.account?.client_email).toBe(
      "strad-secrets-admin@strad.iam.gserviceaccount.com",
    );
  });
});

// --- unit: the config gate ---------------------------------------------------

describe("the schema's fences on consoleStores:", () => {
  const base = (stores: string, extra = "") => `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles: [{ name: bundle }]
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "${STRAD_PROJECT}"${extra}
    consoleEnv:
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${STRAD_ADMIN_KEY}"
    consoleStores:
${stores}
`;

  it("refuses an adminKeyVar that is not declared under consoleEnv:", () => {
    // The load-bearing rule. consoleEnv: is the one scope appspec.ts lands on
    // core and stops; a credential arriving any other way has no such guarantee.
    expect(() =>
      parseConfig(
        base(`      - project: "${ZIMMER_PROJECT}"
        namespaces: ["${ZIMMER_NS}"]
        adminKeyVar: NOT_DECLARED_ANYWHERE`),
      ),
    ).toThrow(/not declared under this server's consoleEnv:/);
  });

  it("refuses an adminKeyVar that is ALSO an env: key on any server", () => {
    // env: is baked onto a bundle — the component that answers /mcp. The same
    // name in both places is the console's store-admin credential on an
    // agent-facing container, which is the entire IAM split undone.
    expect(() =>
      parseConfig(
        base(
          `      - project: "${STRAD_PROJECT}"
        namespaces: ["${STRAD_NS}"]
        adminKeyVar: SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON`,
          `\n      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${STRAD_ADMIN_KEY}"`,
        ),
      ),
    ).toThrow(/would reach an agent-facing container/);
  });

  it("refuses two stores claiming the same project id", () => {
    // ?project= addresses a store by its id, so a duplicate is one store the
    // page can never reach and a write whose destination depends on order.
    expect(() =>
      parseConfig(
        base(`      - project: "${STRAD_PROJECT}"
        namespaces: ["${STRAD_NS}"]
        adminKeyVar: SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
      - project: "${STRAD_PROJECT}"
        namespaces: ["${ZIMMER_NS}"]
        adminKeyVar: SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON`),
      ),
    ).toThrow(/declares the project .* twice/);
  });

  it("refuses a store with no namespace at all", () => {
    // Same reasoning as the MCP half's loadConfig: an empty prefix matches every
    // parameter the credential can see.
    expect(() =>
      parseConfig(
        base(`      - project: "${ZIMMER_PROJECT}"
        namespaces: []
        adminKeyVar: SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON`),
      ),
    ).toThrow();
  });
});

// --- unit: the /mcp half is untouched ---------------------------------------

describe("the /mcp half of a multi-store slug", () => {
  it("carries ONE store's project and the viewer key, never an admin key", () => {
    // THE LOAD-BEARING SAFETY PROPERTY of this change. A multi-project MCP
    // secrets server would necessarily be one entitlement spanning every project
    // it reaches — entitlements name SLUGS and the tools: policy names TOOL
    // NAMES, so there is nowhere in strad to say "role zimmer may call
    // list_parameters, but only for /strad/prod/mcp/". The console gets N
    // stores; /mcp keeps exactly one.
    const spec = renderAppSpec({
      config: CONFIG,
      image: "ghcr.io/tadasant/strad:abc1234",
      env: [],
      secrets: SECRETS,
    });

    const bundles = spec.services.filter((s) => s.name !== "core");
    expect(bundles.length).toBeGreaterThan(0);

    for (const bundle of bundles) {
      const envs = Object.fromEntries(
        bundle.envs.map((e) => [e.key, e.value]),
      ) as Record<string, string>;

      // The single store the MCP half fronts, unchanged by consoleStores:.
      expect(envs.SECRETS_PROJECT_ID).toBe(STRAD_PROJECT);
      expect(envs.SECRETS_NAMESPACES).toBe(STRAD_NS);
      expect(envs.SECRETS_SERVICE_ACCOUNT_KEY_JSON).toBe(VIEWER_KEY);

      // NEITHER admin key, under any name, by value.
      const values = Object.values(envs);
      expect(values).not.toContain(STRAD_ADMIN_KEY);
      expect(values).not.toContain(ZIMMER_ADMIN_KEY);
      expect(
        envs.ZIMMER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON,
      ).toBeUndefined();
      expect(envs.SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON).toBeUndefined();
    }

    // And BOTH admin keys are on core, which is where the console runs.
    const core = Object.fromEntries(
      spec.services
        .find((s) => s.name === "core")!
        .envs.map((e) => [e.key, e.value]),
    );
    expect(core.SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON).toBe(STRAD_ADMIN_KEY);
    expect(core.ZIMMER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON).toBe(
      ZIMMER_ADMIN_KEY,
    );
  });

  it("routes a write-back path to the store whose namespace covers it", () => {
    // src/http/params.ts flattens across BOTH dimensions — several secrets
    // slugs, and several stores on one slug — and the namespace still decides.
    const strad = storeForPath(CONFIG, SECRETS, `${STRAD_NS}A_VAR`, {
      parametersStore: (_view, store) =>
        ({ id: store.projectId }) as never as never,
    });
    const zimmer = storeForPath(CONFIG, SECRETS, `${ZIMMER_NS}A_VAR`, {
      parametersStore: (_view, store) =>
        ({ id: store.projectId }) as never as never,
    });

    expect((strad.store as unknown as { id: string }).id).toBe(STRAD_PROJECT);
    expect((zimmer.store as unknown as { id: string }).id).toBe(ZIMMER_PROJECT);
  });
});

// --- end to end: the switcher ------------------------------------------------

describe("the switcher, end to end", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let stradFake: FakeGcp;
  let zimmerFake: FakeGcp;

  const env: NodeJS.ProcessEnv = {
    ALLOW_DEV_AUTH: "true",
    STRAD_TOKENS: "[]",
    ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
    // The bundle is never dialled — the console renders from config and the
    // store seam — but Registry.build refuses to mount a supplementary server
    // without one, which is the right refusal.
    STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
    ...SECRETS,
  };
  const auth = { authorization: `Bearer ${BOOTSTRAP}` };

  beforeAll(async () => {
    stradFake = createFakeGcp();
    zimmerFake = createFakeGcp();

    await stradFake.store.create({
      path: `${STRAD_NS}STRAD_ONLY_VAR`,
      secret: false,
      value: "strad-value",
      note: "Lives in the strad store.",
    });
    await zimmerFake.store.create({
      path: `${ZIMMER_NS}ZIMMER_ONLY_VAR`,
      secret: false,
      value: "zimmer-value",
      note: "Lives in the zimmer store.",
    });

    const runtime = new EnvSecretProvider(SECRETS);
    const runtimeProviders = sharedSecretProviders({
      name: runtime.name,
      get: (name: string) => runtime.get(name),
      invalidate: () => {},
    });

    const registry = await Registry.build({
      config: CONFIG,
      secrets: runtimeProviders,
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
      secretProvider: runtimeProviders,
      // The seam is handed the STORE, so a fake per project is what proves the
      // page reads the store it says it is reading.
      parametersStore: (_view, store) =>
        store.projectId === ZIMMER_PROJECT ? zimmerFake.store : stradFake.store,
      capabilities: () => Promise.resolve(ADMIN_CAPABILITIES),
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

  it("renders a picker naming BOTH stores, defaulting to the first", async () => {
    const res = await fetch(`${baseUrl}/ui/secrets`, { headers: auth });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('name="project"');
    expect(html).toContain(`value="${STRAD_PROJECT}"`);
    expect(html).toContain(`value="${ZIMMER_PROJECT}"`);
    expect(html).toContain("strad prod");
    expect(html).toContain("zimmer prod");
    // The first store is selected with no query string.
    expect(html).toContain(`value="${STRAD_PROJECT}" selected`);
    expect(html).toContain("STRAD_ONLY_VAR");
    expect(html).not.toContain("ZIMMER_ONLY_VAR");
  });

  it("?project= switches which store's parameters are listed", async () => {
    const res = await fetch(`${baseUrl}/ui/secrets?project=${ZIMMER_PROJECT}`, {
      headers: auth,
    });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(`value="${ZIMMER_PROJECT}" selected`);
    expect(html).toContain("ZIMMER_ONLY_VAR");
    expect(html).toContain("Lives in the zimmer store.");
    expect(html).not.toContain("STRAD_ONLY_VAR");
    // And it lands on the SELECTED store's namespace, not the other's.
    expect(html).toContain(ZIMMER_NS);
  });

  it("writes to the store the form named, and not to its sibling", async () => {
    const res = await post("/ui/secrets/create", {
      project: ZIMMER_PROJECT,
      ns: ZIMMER_NS,
      variable: "WRITTEN_TO_ZIMMER",
      value: "z",
      note: "created against the zimmer store",
    });
    expect(res.status).toBe(200);

    const inZimmer = await zimmerFake.store.list(ZIMMER_NS);
    const inStrad = await stradFake.store.list(STRAD_NS);
    expect(inZimmer.map((p) => p.variable)).toContain("WRITTEN_TO_ZIMMER");
    expect(inStrad.map((p) => p.variable)).not.toContain("WRITTEN_TO_ZIMMER");
  });

  it("checks namespacesStrict against the SELECTED store, not a union", async () => {
    // THE NON-NEGOTIABLE. `strad prod` is strict and manages only STRAD_NS.
    // ZIMMER_NS is a perfectly real namespace on this page — it just belongs to
    // the other store. A per-VIEW strict list would be the union of both and
    // would wave this through, writing a zimmer-shaped path into strad's project.
    const res = await post("/ui/secrets/create", {
      project: STRAD_PROJECT,
      ns: ZIMMER_NS,
      variable: "SHOULD_NOT_LAND",
      value: "x",
    });
    const html = await res.text();

    expect(res.status).toBe(400);
    expect(html).toContain("is not one of the configured namespaces");
    expect(html).toContain("strad prod");

    const listed = await stradFake.store.list(STRAD_NS);
    expect(listed.map((p) => p.variable)).not.toContain("SHOULD_NOT_LAND");
  });

  it("lets the NON-strict store use a namespace outside its configured list", async () => {
    // The other half of per-store: `zimmer prod` is not strict, so free text is
    // still free text there. Per-store means per store in BOTH directions — this
    // change must not silently widen or narrow the existing semantics.
    const res = await post("/ui/secrets/create", {
      project: ZIMMER_PROJECT,
      ns: "/zimmer/production/gateway/",
      variable: "FREE_TEXT_OK",
      value: "z",
    });
    expect(res.status).toBe(200);
    const listed = await zimmerFake.store.list("/zimmer/production/gateway/");
    expect(listed.map((p) => p.variable)).toContain("FREE_TEXT_OK");
  });

  it("bounds CREATE and not rotate/note/delete, exactly as before", async () => {
    // Pre-existing semantics, preserved verbatim: nsError is consulted only in
    // case "create". A rotate addresses an existing parameter by its canonical
    // path, and the store it was listed out of is already the fence.
    await stradFake.store.create({
      path: `${STRAD_NS}ROTATE_ME`,
      secret: false,
      value: "before",
    });
    const res = await post("/ui/secrets/rotate", {
      project: STRAD_PROJECT,
      ns: ZIMMER_NS, // strict would reject this on a create
      path: `${STRAD_NS}ROTATE_ME`,
      value: "after",
    });
    expect(res.status).toBe(200);
    expect(await stradFake.store.reveal(`${STRAD_NS}ROTATE_ME`)).toBe("after");
  });

  it("REFUSES a form naming a store this console does not front", async () => {
    // Not a silent fallback to the first store. A create that succeeds against
    // the wrong GCP project under the wrong service account, and reports
    // success, is unrecoverable by inspection.
    const before = (await stradFake.store.list(STRAD_NS)).length;
    const res = await post("/ui/secrets/create", {
      project: "some-other-peoples-project",
      ns: STRAD_NS,
      variable: "MISROUTED",
      value: "x",
    });
    const html = await res.text();

    expect(res.status).toBe(400);
    expect(html).toContain("not configured on this console");
    expect((await stradFake.store.list(STRAD_NS)).length).toBe(before);
  });

  it("carries the project back on every form, so an action returns where it was", async () => {
    const res = await fetch(`${baseUrl}/ui/secrets?project=${ZIMMER_PROJECT}`, {
      headers: auth,
    });
    const html = await res.text();
    // The hidden field the mutating forms post back.
    expect(html).toContain(
      `<input type="hidden" name="project" value="${ZIMMER_PROJECT}" />`,
    );
  });

  it("offers reveal on the store that enables it and not on the one that does not", async () => {
    // Per-store reveal, with an identical admin capability probe for both. A
    // page-level flag would have to pick one answer for two projects.
    const stradHtml = await (
      await fetch(`${baseUrl}/ui/secrets?project=${STRAD_PROJECT}`, {
        headers: auth,
      })
    ).text();
    const zimmerHtml = await (
      await fetch(`${baseUrl}/ui/secrets?project=${ZIMMER_PROJECT}`, {
        headers: auth,
      })
    ).text();

    expect(zimmerHtml).toContain("/ui/secrets/reveal");
    expect(stradHtml).not.toContain("/ui/secrets/reveal");
  });

  it("refuses a POST reveal against the store that does not offer it", async () => {
    // The hidden button is presentation; this is the gate, and it is now asked
    // per store rather than per page.
    const res = await post("/ui/secrets/reveal", {
      project: STRAD_PROJECT,
      ns: STRAD_NS,
      path: `${STRAD_NS}STRAD_ONLY_VAR`,
    });
    const html = await res.text();
    expect(res.status).toBe(403);
    expect(html).toContain("Reveal is not available");
  });
});
