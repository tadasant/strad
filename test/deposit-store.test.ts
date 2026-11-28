import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import {
  assertCreatable,
  assertEditable,
  ImmutableFieldChanged,
} from "../src/config/overlay.ts";
import { depositStoreIssues } from "../src/config/schema.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  DEPOSIT_PROTOCOL,
  depositRoutePath,
  depositToken,
  isDepositStoreTarget,
  parseDepositReceipt,
  storeDepositRoutePath,
} from "../src/secrets/deposit-wire.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import { createSecretManagerDepositor } from "../src/secrets/secret-manager-deposit.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * `POST /_strad/deposit/_store/{store}/{target}` — a custody deposit into a
 * store that is NOT this strad's own slug namespace, over a real socket.
 *
 * Two fakes, two formats: Zimmer's parameter store (strad's envelope, written
 * through the console's admin client for that project) and a plain Secret
 * Manager project (a deploy workflow's, written with its own deposit key).
 *
 * What it has to hold — the custody properties, store by store:
 *
 *   1. Only a caller that lists the store in `deposit.stores:` reaches it,
 *      and only a store the checked-in config declares exists at all.
 *   2. Only a target under one of the store's prefixes, one segment deep.
 *   3. Create-only, unless BOTH the request says `replace: true` and the
 *      store's entry says `replace: true`.
 *   4. The answer names where and which version, never the value.
 */

const CUSTODY_KEY = "custody-slug-key-0123456789abcdef0123456789";
const OTHER_KEY = "other-slug-key-0123456789abcdef0123456789ab";

const params = createFakeGcp();
const sm = createFakeGcp();

const YAML = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle-secrets
servers:
  - slug: custody-test-mbp
    kind: local-tunnel
    url: https://hostd.example.com/custody/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${HOSTD_CUSTODY_KEY}"
    deposit:
      into: [linear]
      stores: [zimmer-production, zimmer-rotatable, deploy-workflow, deploy-create-only]
  - slug: custody-other-mbp
    kind: local-tunnel
    url: https://hostd.example.com/custody/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${HOSTD_OTHER_KEY}"
    deposit: {}
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-secrets
    path: /secrets
    entitlements: [admin]
    consoleEnv:
      ZIMMER_ADMIN_KEY_JSON: "\${ZIMMER_ADMIN_KEY_JSON}"
      DEPLOY_DEPOSIT_KEY_JSON: "\${DEPLOY_DEPOSIT_KEY_JSON}"
    consoleStores:
      - project: zimmer-secrets-test
        namespaces: ["/zimmer/test/secrets/"]
        adminKeyVar: ZIMMER_ADMIN_KEY_JSON
    depositStores:
      - name: zimmer-production
        format: parameter
        project: zimmer-secrets-test
        prefixes: ["/zimmer/test/secrets/static/"]
      - name: zimmer-rotatable
        format: parameter
        project: zimmer-secrets-test
        prefixes: ["/zimmer/test/secrets/rotatable/"]
        replace: true
      - name: deploy-workflow
        format: secret-manager
        project: ${sm.endpoints.projectId}
        keyVar: DEPLOY_DEPOSIT_KEY_JSON
        prefixes: ["app-"]
        labels: { app: my-app }
        replace: true
      - name: deploy-create-only
        format: secret-manager
        project: ${sm.endpoints.projectId}
        keyVar: DEPLOY_DEPOSIT_KEY_JSON
        prefixes: ["once-"]
`;

const CONFIG = parseConfig(YAML);
const VALUE = "tok_FAKEVALUEnotARealToken0123456789abcdef";
const CUSTODY = depositToken(CUSTODY_KEY);
const OTHER = depositToken(OTHER_KEY);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const keys = new EnvSecretProvider({
    HOSTD_CUSTODY_KEY: CUSTODY_KEY,
    HOSTD_OTHER_KEY: OTHER_KEY,
  });
  const providers = sharedSecretProviders({
    name: keys.name,
    get: (name: string) => keys.get(name),
    invalidate: () => {},
  });
  const env: NodeJS.ProcessEnv = {
    STRAD_MODE: "core",
    STRAD_INTERNAL_TOKEN: "InternalTokenValueNeverShown",
    STRAD_BUNDLE_URL_BUNDLE_SECRETS: "http://bundle-secrets:8080",
  };
  const registry = await Registry.build({
    config: CONFIG,
    secrets: providers,
    mode: "core",
    env,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    secrets: {
      ZIMMER_ADMIN_KEY_JSON: params.endpoints.keyJson,
      DEPLOY_DEPOSIT_KEY_JSON: sm.endpoints.keyJson,
    },
    parametersStore: () => params.store,
    // The REAL client, spoken to the fake over its stub fetch.
    secretManagerDepositor: (cfg) =>
      createSecretManagerDepositor({
        ...cfg,
        fetchImpl: sm.fetchImpl,
        smApiBase: sm.endpoints.smApiBase,
        tokenUrl: sm.endpoints.tokenUrl,
      }),
    secretProvider: providers,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

function post(
  route: string,
  opts: { bearer?: string; body?: unknown; method?: string } = {},
) {
  const method = opts.method ?? "POST";
  return fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.bearer ?? CUSTODY}`,
    },
    ...(method === "POST"
      ? { body: JSON.stringify(opts.body ?? { value: VALUE }) }
      : {}),
  });
}

const into = (store: string, target: string, opts = {}) =>
  post(storeDepositRoutePath(store, target), opts);

async function refusal(res: Response) {
  const body = (await res.json()) as { error: string; message?: string };
  return { status: res.status, error: body.error, message: body.message };
}

describe("a parameter store (Zimmer's envelope)", () => {
  const path =
    "/zimmer/test/secrets/static/TRANSCRIPT_STORAGE_SERVICE_ACCOUNT_KEY_JSON";

  it("creates a SECRET parameter at the exact path, and answers with where, not what", async () => {
    const blob = JSON.stringify({
      type: "service_account",
      private_key:
        "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n",
    });
    const res = await into("zimmer-production", path, {
      body: { value: blob },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const raw = await res.text();
    expect(raw).not.toContain("FAKE");
    expect(parseDepositReceipt(JSON.parse(raw))).toEqual({
      protocol: DEPOSIT_PROTOCOL,
      path,
      version: "v1",
    });
    expect(await params.store.isSecret!(path)).toBe(true);
    // What the store's READER gets: the resolver renders it byte for byte.
    const resolved = await params.store.resolve("/zimmer/test/secrets/static/");
    expect(resolved.TRANSCRIPT_STORAGE_SERVICE_ACCOUNT_KEY_JSON).toBe(blob);
    // And the value lives in Secret Manager, never in a Parameter Manager payload.
    expect(params.pmPayloads().some((p) => p.includes("FAKE"))).toBe(false);
  });

  it("refuses an existing target, and leaves it alone", async () => {
    const res = await into("zimmer-production", path);
    expect(await refusal(res)).toMatchObject({ status: 409, error: "exists" });
    expect(await params.store.reveal(path)).toContain("FAKE");
  });

  it("refuses replace: true where the store's entry does not allow it", async () => {
    const res = await into("zimmer-production", path, {
      body: { value: VALUE, replace: true },
    });
    expect(await refusal(res)).toMatchObject({
      status: 403,
      error: "not_permitted",
    });
    expect(await params.store.reveal(path)).toContain("FAKE");
  });

  it("replaces only when both the request and the store's entry say so", async () => {
    const target = "/zimmer/test/secrets/rotatable/TRANSCRIPT_STORAGE_BUCKET";
    expect((await into("zimmer-rotatable", target)).status).toBe(201);
    const again = await into("zimmer-rotatable", target, {
      body: { value: "second-value-0123456789" },
    });
    expect(await refusal(again)).toMatchObject({
      status: 409,
      error: "exists",
    });
    expect(await params.store.reveal(target)).toBe(VALUE);

    const res = await into("zimmer-rotatable", target, {
      body: { value: "second-value-0123456789", replace: true },
    });
    expect(res.status).toBe(201);
    const receipt = parseDepositReceipt(await res.json());
    // The parameter keeps v1; the bytes are the secret's second version.
    expect(receipt).toEqual({
      protocol: DEPOSIT_PROTOCOL,
      path: target,
      version: "v1",
      replaced: true,
      valueVersion: "2",
    });
    expect(await params.store.reveal(target)).toBe("second-value-0123456789");
  });

  it("will not replace a PLAIN parameter with a secret", async () => {
    const target = "/zimmer/test/secrets/rotatable/PLAIN_SETTING";
    await params.store.create({ path: target, secret: false, value: "plain" });
    const res = await into("zimmer-rotatable", target, {
      body: { value: VALUE, replace: true },
    });
    expect(await refusal(res)).toMatchObject({ status: 409, error: "exists" });
  });

  it.each([
    ["outside every prefix", "/zimmer/test/secrets/other/KEY"],
    ["one segment too deep", "/zimmer/test/secrets/static/nested/KEY"],
    ["the prefix itself", "/zimmer/test/secrets/static"],
    ["a process-control name", "/zimmer/test/secrets/static/NODE_OPTIONS"],
    ["strad's own namespace", "/strad/test/mcp/linear/static/KEY"],
  ])("refuses a target %s", async (_why, target) => {
    const res = await into("zimmer-production", target);
    expect([400, 403]).toContain(res.status);
    expect(await params.store.isSecret!(target)).toBeUndefined();
  });
});

describe("a Secret Manager store (a deploy workflow's)", () => {
  it("creates the secret with the store's labels and adds the bytes as version 1", async () => {
    const res = await into("deploy-workflow", "app-otel-ingest-token");
    expect(res.status).toBe(201);
    const raw = await res.text();
    expect(raw).not.toContain(VALUE);
    expect(parseDepositReceipt(JSON.parse(raw))).toEqual({
      protocol: DEPOSIT_PROTOCOL,
      path: `projects/${sm.endpoints.projectId}/secrets/app-otel-ingest-token`,
      version: "1",
    });
    expect(sm.secrets.get("app-otel-ingest-token")).toEqual([VALUE]);
    expect(sm.secretLabels.get("app-otel-ingest-token")).toEqual({
      app: "my-app",
    });
  });

  it("refuses an existing secret without replace, and adds a version with it", async () => {
    const id = "app-otel-ingest-token";
    const plain = await into("deploy-workflow", id);
    expect(await refusal(plain)).toMatchObject({
      status: 409,
      error: "exists",
    });
    expect(sm.secrets.get(id)).toEqual([VALUE]);

    const res = await into("deploy-workflow", id, {
      body: { value: "rotated-0123456789", replace: true },
    });
    expect(res.status).toBe(201);
    expect(parseDepositReceipt(await res.json())).toMatchObject({
      version: "2",
      replaced: true,
    });
    expect(sm.secrets.get(id)).toEqual([VALUE, "rotated-0123456789"]);
  });

  it("refuses replace on a create-only Secret Manager store", async () => {
    expect((await into("deploy-create-only", "once-token")).status).toBe(201);
    const res = await into("deploy-create-only", "once-token", {
      body: { value: VALUE, replace: true },
    });
    expect(await refusal(res)).toMatchObject({
      status: 403,
      error: "not_permitted",
    });
    expect(sm.secrets.get("once-token")).toEqual([VALUE]);
  });

  it.each([
    ["outside every prefix", "zimmer-token"],
    ["the bare prefix", "app-"],
    ["a path, not an id", "app/token"],
  ])("refuses a secret id %s", async (_why, id) => {
    const res = await into("deploy-workflow", id);
    expect([400, 403]).toContain(res.status);
    expect(sm.secrets.has(id)).toBe(false);
  });
});

describe("who may name a store", () => {
  it("refuses a caller whose deposit.stores does not list it", async () => {
    const res = await into("deploy-workflow", "app-other-caller", {
      bearer: OTHER,
    });
    expect(await refusal(res)).toMatchObject({
      status: 403,
      error: "not_permitted",
    });
    expect(sm.secrets.has("app-other-caller")).toBe(false);
  });

  it("refuses an unauthenticated caller before anything else", async () => {
    const res = await into("deploy-workflow", "app-no-key", { bearer: "nope" });
    expect(res.status).toBe(401);
  });

  it("refuses a store no entry declares", async () => {
    const res = await into("ci-secrets", "/ci/x/static/KEY");
    expect(await refusal(res)).toMatchObject({
      status: 403,
      error: "not_permitted",
    });
  });

  it("refuses replace on strad's own slug route, which stays create-only", async () => {
    const res = await post(depositRoutePath("linear", "LINEAR_API_KEY"), {
      body: { value: VALUE, replace: true },
    });
    expect(await refusal(res)).toMatchObject({
      status: 400,
      error: "bad_body",
    });
  });

  it("never reads: GET is a 405", async () => {
    const res = await into("deploy-workflow", "app-otel-ingest-token", {
      method: "GET",
    });
    expect(res.status).toBe(405);
  });
});

describe("the target shape on the wire", () => {
  it.each([
    ["/zimmer/production/secrets/static/KEY", true],
    ["app-otel-endpoint", true],
    ["/a/../b", false],
    ["/a//b", false],
    ["/a/b/", false],
    ["a.b", false],
    ["", false],
  ])("%s → %s", (target, ok) => {
    expect(isDepositStoreTarget(target)).toBe(ok);
  });
});

describe("the config rules", () => {
  const base = (stores: string, consoleExtra = "", callerStores = "[a]") =>
    parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles: [{ name: b }]
servers:
  - slug: custody-x-mbp
    kind: local-tunnel
    url: https://hostd.example.com/custody/mcp
    entitlements: [admin]
    headers: { Authorization: "Bearer \${K}" }
    deposit: { stores: ${callerStores} }
  - slug: secrets
    kind: supplementary-image
    image: i:1
    bundle: b
    path: /secrets
    entitlements: [admin]
    consoleEnv:
      ADMIN: "\${ADMIN}"
      DEP: "\${DEP}"
    consoleStores:
      - project: p
        namespaces: ["/zimmer/test/secrets/", "/strad/test/mcp/"]
        adminKeyVar: ADMIN
${consoleExtra}
    depositStores:
${stores}
`);

  const issues = (stores: string, callerStores?: string) => {
    try {
      base(stores, "", callerStores);
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  };

  it("accepts a well-formed pair of stores", () => {
    expect(
      issues(`
      - { name: a, format: parameter, project: p, prefixes: ["/zimmer/test/secrets/static/"] }
      - { name: b, format: secret-manager, project: q, keyVar: DEP, prefixes: ["app-"] }`),
    ).toBe("");
  });

  it.each([
    [
      "a parameter project that is no console store",
      `      - { name: a, format: parameter, project: elsewhere, prefixes: ["/zimmer/test/secrets/static/"] }`,
      /not one of this server's consoleStores/,
    ],
    [
      "a prefix outside the console store's namespaces",
      `      - { name: a, format: parameter, project: p, prefixes: ["/zimmer/other/"] }`,
      /none of store "p"'s consoleStores: namespaces/,
    ],
    [
      "a prefix under /strad/",
      `      - { name: a, format: parameter, project: p, prefixes: ["/strad/test/mcp/x/static/"] }`,
      /under \/strad\//,
    ],
    [
      "a prefix without its trailing slash",
      `      - { name: a, format: parameter, project: p, prefixes: ["/zimmer/test/secrets/static"] }`,
      /starts and ends with "\/"/,
    ],
    [
      "a Secret Manager store with no key",
      `      - { name: a, format: secret-manager, project: q, prefixes: ["app-"] }`,
      /names no keyVar/,
    ],
    [
      "a Secret Manager store borrowing a console admin key",
      `      - { name: a, format: secret-manager, project: q, keyVar: ADMIN, prefixes: ["app-"] }`,
      /never a console admin key/,
    ],
    [
      "a Secret Manager key that is not a consoleEnv key",
      `      - { name: a, format: secret-manager, project: q, keyVar: NOPE, prefixes: ["app-"] }`,
      /not a key of this server's consoleEnv/,
    ],
    [
      "two stores under one name",
      `      - { name: a, format: secret-manager, project: q, keyVar: DEP, prefixes: ["x-"] }
      - { name: a, format: secret-manager, project: r, keyVar: DEP, prefixes: ["y-"] }`,
      /reuses a name/,
    ],
  ])("refuses %s", (_why, stores, pattern) => {
    expect(issues(stores)).toMatch(pattern);
  });

  it("refuses a caller that names a store nobody declares", () => {
    expect(
      issues(
        `      - { name: a, format: secret-manager, project: q, keyVar: DEP, prefixes: ["x-"] }`,
        "[a, missing]",
      ),
    ).toMatch(/lists missing in deposit.stores/);
  });

  it("is the same rule set the route's config parse ran", () => {
    expect(depositStoreIssues(CONFIG)).toEqual([]);
  });
});

describe("a runtime roster write", () => {
  const entry = {
    slug: "secrets",
    kind: "supplementary-image",
    image: "i:1",
    bundle: "b",
    path: "/secrets",
  };
  const store = {
    name: "a",
    format: "secret-manager",
    project: "q",
    keyVar: "DEP",
    prefixes: ["x-"],
  };

  it("may not add or move depositStores:", () => {
    expect(() =>
      assertEditable(entry, { ...entry, depositStores: [store] }),
    ).toThrow(ImmutableFieldChanged);
  });

  it("may not create a server that declares one", () => {
    expect(() =>
      assertCreatable({ ...entry, depositStores: [store] }, {
        config: CONFIG,
      } as never),
    ).toThrow();
  });
});
