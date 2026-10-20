import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { tokensParameterPath } from "../src/auth/token-admin.ts";
import {
  parseTokenRecords,
  serializeTokenRecords,
  mintToken,
} from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  createFakeGcp,
  PARAMETER_VIEWER_PERMISSIONS,
  RESOLVER_PERMISSIONS,
  WRITE_ONLY_CONSOLE_PERMISSIONS,
  type FakeGcp,
} from "../src/secrets/parameters/fake.ts";
import type { ParameterStore } from "../src/secrets/parameters/index.ts";
import {
  buildSecretProviders,
  type ServerSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * `/tokens` — the console mint/revoke surface, end to end.
 *
 * Through the REAL Express app, over a REAL socket, against an in-memory
 * Parameter Manager + Secret Manager, with `/mcp` mounted beside it. The claim
 * under test is the one the feature exists to make and the one a unit test
 * cannot: a credential minted in a browser authenticates an agent's very next
 * `/mcp` request, and a revocation in a browser stops it — with no restart, no
 * redeploy, and no TTL to wait out.
 *
 * And under PROD'S IAM, which is the other half of that claim. The console's
 * client holds `WRITE_ONLY_CONSOLE_PERMISSIONS` — docs/operate/secrets-iam.md
 * §1, no read path of any kind — and the resolver holds `RESOLVER_PERMISSIONS`.
 * An all-powerful client on both sides would hide that split: a console read
 * passes here and is a 403 on prod.
 */

const BOOTSTRAP = "bootstrap-secret-xyz";
const GATEWAY_NS = "/strad/test/gateway/static/";

const YAML = `
version: 1
gateway:
  name: strad
  env: test
  secrets:
    provider: gcp-parameter-store
auth:
  staticTokens: { enabled: true, store: parameter-store }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
  reader: { servers: [echo] }
bundles:
  - name: bundle
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin, reader]
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    consoleEnv:
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
    consoleStores:
      - project: demo-project
        namespaces: ["/strad/test/"]
        adminKeyVar: SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
`;

/**
 * The console's admin credential, resolved from `consoleEnv:` — the scope
 * appspec.ts puts on the core component alone. The store client itself is
 * substituted below, so the key never signs anything; it is here because the
 * VIEW refuses to name a store it has no admin credential for, and that refusal
 * is part of what this file exercises.
 */
const ADMIN_KEY = JSON.stringify({
  client_email: "strad-secrets-admin@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
});
const SECRETS = { ADMIN_KEY };

const CONFIG = parseConfig(YAML);
const TOKENS_PATH = tokensParameterPath(CONFIG);

const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_PARAMS_PROJECT_ID: "demo-project",
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
};

let fake: FakeGcp;
let providers: ServerSecretProviders;
let server: Server;
let baseUrl: string;

const auth = { authorization: `Bearer ${BOOTSTRAP}` };

/** Who holds what. Prod's split by default; a test may narrow either side. */
interface Credentials {
  console?: (fake: FakeGcp) => ParameterStore;
  resolver?: ((fake: FakeGcp) => ParameterStore) | null;
}

async function boot(
  seedEnvTokens?: string,
  creds: Credentials = {},
): Promise<void> {
  fake = createFakeGcp();
  const consoleStore = (
    creds.console ?? ((f) => f.storeAs(WRITE_ONLY_CONSOLE_PERMISSIONS))
  )(fake);
  const resolver =
    creds.resolver === null
      ? undefined
      : (creds.resolver ?? ((f) => f.storeAs(RESOLVER_PERMISSIONS)))(fake);
  // The SHARED provider over the gateway namespace, built exactly as
  // src/index.ts builds it — including the hour-long TTL, so nothing in this
  // file passes by waiting.
  providers = buildSecretProviders({
    config: CONFIG,
    env: seedEnvTokens ? { ...env, STRAD_TOKENS: seedEnvTokens } : env,
    // The same client the console's read goes through, as in src/index.ts.
    resolver: resolver ?? fake.store,
  });
  const registry = await Registry.build({
    config: CONFIG,
    secrets: providers,
    mode: "core",
    env,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, env, providers),
    mode: "core",
    env,
    secrets: SECRETS,
    secretProvider: providers,
    parametersStore: () => consoleStore,
    resolver,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

beforeEach(async () => {
  await boot();
});

afterEach(() => {
  server?.close();
});

function post(
  path: string,
  body: Record<string, string | string[]>,
): Promise<Response> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    for (const one of Array.isArray(v) ? v : [v]) form.append(k, one);
  }
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual",
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tokens-test", version: "1" },
  },
});

/** An agent's request, with a token in hand. */
function mcp(token: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: INITIALIZE,
  });
}

/** The plaintext out of a mint response's one-shot panel. */
function plaintextIn(html: string): string {
  const match = /<input class="copy-url" readonly value="(strad_[^"]+)"/.exec(
    html,
  );
  if (!match?.[1]) throw new Error("no minted token in the response");
  return match[1];
}

/** The records as they are actually stored, read back through the store. */
async function stored(): Promise<ReturnType<typeof parseTokenRecords>> {
  return parseTokenRecords(await fake.store.reveal(TOKENS_PATH));
}

describe("the gate", () => {
  it.each(["/tokens"])("401s an anonymous GET %s", async (path) => {
    const res = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
    expect(res.status).toBe(401);
  });

  it.each(["mint", "revoke", "forget"])(
    "401s an anonymous POST /tokens/%s and changes nothing",
    async (action) => {
      const res = await fetch(`${baseUrl}/tokens/${action}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "label=sneaky&roles=admin",
        redirect: "manual",
      });
      expect(res.status).toBe(401);
      expect(fake.parameters.size).toBe(0);
    },
  );
});

describe("mint", () => {
  it("mints a token that authenticates /mcp on the very next request", async () => {
    // BEFORE: no records, so /mcp is a wall with no door.
    const roster = await fetch(`${baseUrl}/tokens`, { headers: auth });
    expect(roster.status).toBe(200);
    expect(await roster.text()).toContain("No tokens yet");

    const res = await post("/tokens/mint", {
      label: "zimmer orchestrator",
      roles: "admin",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("shown once");
    expect(html).toContain("zimmer orchestrator");

    const token = plaintextIn(html);
    expect(token.startsWith("strad_test_")).toBe(true);

    // AFTER: the agent's request is admitted. No restart, no redeploy, and no
    // waiting out gateway.secrets.ttlSeconds — the write dropped the reading.
    const admitted = await mcp(token);
    expect(admitted.status).toBe(200);
  });

  it("stores only the hash, and never the plaintext", async () => {
    const html = await (
      await post("/tokens/mint", { label: "probe", roles: "admin" })
    ).text();
    const token = plaintextIn(html);
    const secret = token.slice(
      token.indexOf("_", token.indexOf("_", 6) + 1) + 1,
    );

    const records = await stored();
    expect(records).toHaveLength(1);
    expect(records[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(records)).not.toContain(secret);

    // The canary the fake exists for: every Parameter Manager payload ever
    // written. A token record must not be in a plaintext PM payload, because
    // that is the one an agent's viewer credential can read.
    for (const payload of fake.pmPayloads()) {
      expect(payload).not.toContain(secret);
      expect(payload).not.toContain(records[0]!.hash);
    }
  });

  it("creates the parameter as SECRET, so the agent viewer credential cannot read the roster", async () => {
    await post("/tokens/mint", { label: "probe", roles: "admin" });
    const [meta] = await fake.store.list(GATEWAY_NS);
    expect(meta?.variable).toBe("STRAD_TOKENS");
    expect(meta?.secret).toBe(true);
  });

  it("shows the plaintext exactly once — a reload of /tokens does not carry it", async () => {
    const token = plaintextIn(
      await (
        await post("/tokens/mint", { label: "probe", roles: "admin" })
      ).text(),
    );
    const again = await (
      await fetch(`${baseUrl}/tokens`, { headers: auth })
    ).text();
    expect(again).not.toContain(token);
    expect(again).toContain("probe");
  });

  it("refuses a mint with no roles, and writes nothing", async () => {
    const res = await post("/tokens/mint", { label: "roleless", roles: [] });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("At least one role is required");
    expect(fake.parameters.size).toBe(0);
  });

  it("refuses a mint with no label, and writes nothing", async () => {
    const res = await post("/tokens/mint", { label: "  ", roles: "admin" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("A label is required");
    expect(fake.parameters.size).toBe(0);
  });

  it("carries the roles onto the record, and entitlement follows them", async () => {
    await post("/tokens/mint", { label: "two", roles: ["admin", "reader"] });
    expect((await stored())[0]?.roles).toEqual(["admin", "reader"]);
  });

  it("dedupes a repeated role rather than recording it twice", async () => {
    await post("/tokens/mint", { label: "dupe", roles: ["admin", "admin"] });
    expect((await stored())[0]?.roles).toEqual(["admin"]);
  });

  it("appends: a second mint does not replace the first", async () => {
    const first = plaintextIn(
      await (
        await post("/tokens/mint", { label: "one", roles: "admin" })
      ).text(),
    );
    const second = plaintextIn(
      await (
        await post("/tokens/mint", { label: "two", roles: "admin" })
      ).text(),
    );
    expect((await stored()).map((r) => r.label)).toEqual(["one", "two"]);
    expect((await mcp(first)).status).toBe(200);
    expect((await mcp(second)).status).toBe(200);
  });
});

describe("revoke", () => {
  it("stops the credential working on the next request", async () => {
    const html = await (
      await post("/tokens/mint", { label: "leaked", roles: "admin" })
    ).text();
    const token = plaintextIn(html);
    expect((await mcp(token)).status).toBe(200);

    const pubid = (await stored())[0]!.pubid;
    const res = await post("/tokens/revoke", { pubid });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Revoked");

    expect((await mcp(token)).status).toBe(401);
  });

  it("is soft: the record stays, so the roster can still say it existed", async () => {
    await post("/tokens/mint", { label: "leaked", roles: "admin" });
    const pubid = (await stored())[0]!.pubid;
    await post("/tokens/revoke", { pubid });

    const records = await stored();
    expect(records).toHaveLength(1);
    expect(records[0]?.revokedAt).toBeTruthy();
    expect(
      await (await fetch(`${baseUrl}/tokens`, { headers: auth })).text(),
    ).toContain("leaked");
  });

  it("keeps the ORIGINAL timestamp when clicked twice", async () => {
    await post("/tokens/mint", { label: "twice", roles: "admin" });
    const pubid = (await stored())[0]!.pubid;
    await post("/tokens/revoke", { pubid });
    const first = (await stored())[0]?.revokedAt;
    await post("/tokens/revoke", { pubid });
    expect((await stored())[0]?.revokedAt).toBe(first);
  });

  it("revokes ONE token and leaves its siblings working", async () => {
    const keep = plaintextIn(
      await (
        await post("/tokens/mint", { label: "keep", roles: "admin" })
      ).text(),
    );
    const kill = plaintextIn(
      await (
        await post("/tokens/mint", { label: "kill", roles: "admin" })
      ).text(),
    );
    const target = (await stored()).find((r) => r.label === "kill")!;
    await post("/tokens/revoke", { pubid: target.pubid });

    expect((await mcp(kill)).status).toBe(401);
    expect((await mcp(keep)).status).toBe(200);
  });

  it("404s an unknown pubid and writes nothing", async () => {
    await post("/tokens/mint", { label: "one", roles: "admin" });
    const before = await stored();
    const res = await post("/tokens/revoke", { pubid: "deadbeef" });
    expect(res.status).toBe(404);
    expect(await stored()).toEqual(before);
  });
});

describe("forget", () => {
  it("refuses to forget an ACTIVE record — that would be a revoke with no trail", async () => {
    const token = plaintextIn(
      await (
        await post("/tokens/mint", { label: "live", roles: "admin" })
      ).text(),
    );
    const pubid = (await stored())[0]!.pubid;

    const res = await post("/tokens/forget", { pubid });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Revoke it first");
    expect(await stored()).toHaveLength(1);
    expect((await mcp(token)).status).toBe(200);
  });

  it("drops a revoked record", async () => {
    await post("/tokens/mint", { label: "gone", roles: "admin" });
    const pubid = (await stored())[0]!.pubid;
    await post("/tokens/revoke", { pubid });
    const res = await post("/tokens/forget", { pubid });
    expect(res.status).toBe(200);
    expect(await stored()).toEqual([]);
  });
});

describe("a gateway whose parameter has not been seeded", () => {
  it("admits nobody from the baked env var, and the first mint starts the roster", async () => {
    // A deployment that set `store: parameter-store` without seeding the
    // parameter. Its deploy preflight already refuses that (STRAD_TOKENS is a
    // REQUIRED boot key), so this is the shape that should not reach production
    // — and when it does, the answer is fail-closed rather than "fall back to
    // whatever the last deploy baked".
    //
    // That matters beyond this one case: `process.env.STRAD_TOKENS` is not an
    // older copy of the roster on a store-backed gateway, it is a copy boot
    // hydration took FROM the store and then froze. Serving it would resurrect
    // every revocation made since the last restart.
    server.close();
    const baked = mintToken({
      env: "test",
      label: "baked into the deploy",
      roles: ["admin"],
    });
    await boot(serializeTokenRecords([baked.record]));

    expect(fake.parameters.size).toBe(0);
    expect((await mcp(baked.plaintext)).status).toBe(401);

    // The first mint CREATES the parameter, and starts it empty rather than
    // from the environment.
    const minted = plaintextIn(
      await (
        await post("/tokens/mint", { label: "first", roles: "admin" })
      ).text(),
    );
    expect((await stored()).map((r) => r.label)).toEqual(["first"]);
    expect((await mcp(minted)).status).toBe(200);
    expect((await mcp(baked.plaintext)).status).toBe(401);
  });
});

describe("what the page does with hostile input", () => {
  it("a label full of quotes cannot escape the confirmation into script", async () => {
    // The obvious spelling of the confirm — `onsubmit="return confirm('…')"` —
    // is a stored-XSS hole that `esc()` does NOT close: it turns `\'` into
    // `&#39;`, and inside a double-quoted attribute the parser decodes that
    // before the JS is compiled. So the sentence must travel as DATA. A console
    // session can mint an admin /mcp token, so script running on a Revoke click
    // is a full compromise of the gateway.
    const HOSTILE = `x'); alert(document.domain); //`;
    await post("/tokens/mint", { label: HOSTILE, roles: "admin" });

    const html = await (
      await fetch(`${baseUrl}/tokens`, { headers: auth })
    ).text();

    // The label renders — it is legitimate text, just nasty.
    expect(html).toContain("alert(document.domain)");
    // …and nowhere does it reach an event attribute or a <script> body.
    expect(html).not.toMatch(/onsubmit=/);
    // `\s` before `on`, or `data-confirm="` matches on its own "onfirm=".
    expect(html).not.toMatch(/\son[a-z]+="[^"]*alert\(document\.domain\)/);
    for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      expect(script[1]).not.toContain("alert(document.domain)");
    }
    // It travels as an attribute VALUE, entity-encoded, which is where `esc` is
    // sufficient because nothing there is ever compiled.
    expect(html).toContain("data-confirm=");
    expect(html).toContain("x&#39;); alert(document.domain); //");
  });

  it("refuses a role this gateway does not declare, and writes nothing", async () => {
    // A hand-crafted POST, or a page left open across a deploy that renamed a
    // role. The record would authenticate and then be refused every server with
    // a 424 pointing at nothing — the silent dud the closed set exists to stop.
    const res = await post("/tokens/mint", {
      label: "typo",
      roles: ["admin", "adnim"],
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("no role named");
    expect(fake.parameters.size).toBe(0);
  });
});

describe("staticTokens.enabled: false", () => {
  it("offers no forms, because a minted token could never work", async () => {
    // `tokenStoreFromConfig` builds an EMPTY store when static tokens are off,
    // so /mcp admits nobody however many records exist. A mint here would write
    // a well-formed record and report success for a credential that is dead on
    // arrival.
    server.close();
    const off = parseConfig(
      YAML.replace(
        "staticTokens: { enabled: true, store: parameter-store }",
        "staticTokens: { enabled: false, store: parameter-store }",
      ),
    );
    fake = createFakeGcp();
    const providers = buildSecretProviders({
      config: off,
      env,
      resolver: fake.store,
    });
    const registry = await Registry.build({
      config: off,
      secrets: providers,
      mode: "core",
      env,
    });
    const app = createApp({
      config: off,
      registry,
      tokenStore: tokenStoreFromConfig(off, env, providers),
      mode: "core",
      env,
      secrets: SECRETS,
      secretProvider: providers,
      parametersStore: () => fake.store,
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no port");
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const html = await (
      await fetch(`${baseUrl}/tokens`, { headers: auth })
    ).text();
    expect(html).toContain("auth.staticTokens.enabled is false");
    expect(html).not.toContain('action="/tokens/mint"');

    const res = await post("/tokens/mint", { label: "dead", roles: "admin" });
    expect(res.status).toBe(503);
    expect(fake.parameters.size).toBe(0);
  });
});

describe("a gateway that cannot write", () => {
  /** The same config with the token store left on the environment variable. */
  const READ_ONLY = parseConfig(
    YAML.replace(
      "staticTokens: { enabled: true, store: parameter-store }",
      "staticTokens: { enabled: true }",
    ).replace("    provider: gcp-parameter-store", "    provider: env"),
  );

  it("renders the roster read-only and offers no form", async () => {
    server.close();
    const existing = mintToken({
      env: "test",
      label: "baked",
      roles: ["admin"],
    });
    const readOnlyEnv = {
      ...env,
      STRAD_TOKENS: serializeTokenRecords([existing.record]),
    };
    const runtime = buildSecretProviders({
      config: READ_ONLY,
      env: readOnlyEnv,
    });
    const registry = await Registry.build({
      config: READ_ONLY,
      secrets: runtime,
      mode: "core",
      env: readOnlyEnv,
    });
    const app = createApp({
      config: READ_ONLY,
      registry,
      tokenStore: tokenStoreFromConfig(READ_ONLY, readOnlyEnv, runtime),
      mode: "core",
      env: readOnlyEnv,
      secrets: SECRETS,
      secretProvider: runtime,
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no port");
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const html = await (
      await fetch(`${baseUrl}/tokens`, { headers: auth })
    ).text();
    // The roster still renders — a read-only page is useful — but it says why
    // it cannot write rather than offering a form that would always 503.
    expect(html).toContain("baked");
    expect(html).toContain("Minting is not available on this gateway");
    expect(html).not.toContain('action="/tokens/mint"');

    // And the write route refuses rather than half-writing.
    const res = await post("/tokens/mint", { label: "nope", roles: "admin" });
    expect(res.status).toBe(503);
  });
});

describe("under prod's IAM: the console writes, the resolver reads", () => {
  /** A roster already in the store, the way a seeded deployment has one. */
  async function seed(secret = true): Promise<ReturnType<typeof mintToken>> {
    const existing = mintToken({
      env: "test",
      label: "seeded",
      roles: ["admin"],
    });
    await fake.store.create({
      path: TOKENS_PATH,
      secret,
      value: serializeTokenRecords([existing.record]),
    });
    providers.invalidate();
    return existing;
  }

  it("revokes a seeded token without the console's credential ever reading it", async () => {
    const existing = await seed();
    expect((await mcp(existing.plaintext)).status).toBe(200);

    const res = await post("/tokens/revoke", { pubid: existing.record.pubid });
    expect(res.status).toBe(200);
    expect((await mcp(existing.plaintext)).status).toBe(401);
    expect((await stored())[0]?.revokedAt).toBeTruthy();

    // And the console's credential is exactly as blind as it was: the fix
    // borrowed the resolver's read rather than granting this one a read.
    await expect(
      fake.storeAs(WRITE_ONLY_CONSOLE_PERMISSIONS).reveal(TOKENS_PATH),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("mints onto a seeded roster, keeping the record already there", async () => {
    const existing = await seed();
    const res = await post("/tokens/mint", { label: "fresh", roles: "admin" });
    expect(res.status).toBe(200);
    const minted = plaintextIn(await res.text());
    expect((await stored()).map((r) => r.label)).toEqual(["seeded", "fresh"]);
    expect((await mcp(minted)).status).toBe(200);
    expect((await mcp(existing.plaintext)).status).toBe(200);
  });

  it("a resolver that may not render says WHICH grant is missing, and writes nothing", async () => {
    server.close();
    await boot(undefined, {
      resolver: (f) => f.storeAs(PARAMETER_VIEWER_PERMISSIONS),
    });
    const existing = await seed();

    const res = await post("/tokens/revoke", { pubid: existing.record.pubid });
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain("resolver credential was refused (403)");
    expect(html).toContain("parametermanager.parameterVersions.render");
    expect(html).toContain("operate/secrets-iam/#token-admin");
    expect((await stored())[0]?.revokedAt).toBeFalsy();
  });

  it("a parameter whose principal may not read its secret names THAT grant", async () => {
    const existing = await seed();
    // The binding `create()` made, removed: the shape of a parameter seeded by
    // hand. The resolver may render; the parameter may not deref.
    for (const id of fake.secretPolicies.keys())
      fake.secretPolicies.set(id, []);

    const res = await post("/tokens/revoke", { pubid: existing.record.pubid });
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain("would not render (400)");
    expect(html).toContain("secretmanager.secretAccessor");
    expect((await stored())[0]?.revokedAt).toBeFalsy();
  });

  it("refuses to write when the resolver reads a different project than the console writes", async () => {
    server.close();
    await boot(undefined, {
      resolver: (f) => {
        const real = f.storeAs(RESOLVER_PERMISSIONS);
        // Same reads, a different store: what a `consoleStores:` entry for
        // another project looks like from here.
        return Object.assign(Object.create(real) as ParameterStore, {
          projectId: "some-other-project",
        });
      },
    });
    const existing = await seed();

    const html = await (
      await fetch(`${baseUrl}/tokens`, { headers: auth })
    ).text();
    expect(html).toContain("some-other-project");
    expect(html).not.toContain('action="/tokens/mint"');

    const res = await post("/tokens/revoke", { pubid: existing.record.pubid });
    expect(res.status).toBe(503);
    expect((await stored())[0]?.revokedAt).toBeFalsy();
  });

  it("a console that may not write says so, naming the console's credential", async () => {
    // The fake checks Parameter Manager verbs, not Secret Manager's
    // `versions.add`, so the refused write is a non-secret parameter's version
    // create, denied to every caller the way a deny policy would.
    const existing = await seed(false);
    fake.denied.add("parametermanager.parameterVersions.create");

    const res = await post("/tokens/revoke", { pubid: existing.record.pubid });
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain("console&#39;s admin credential was refused (403)");
    expect(html).toContain("secretmanager.versions.add");
    expect((await stored())[0]?.revokedAt).toBeFalsy();
  });

  it("with no resolver to read through, offers no form rather than a form that fails", async () => {
    server.close();
    await boot(undefined, { resolver: null });
    const existing = await seed();

    const html = await (
      await fetch(`${baseUrl}/tokens`, { headers: auth })
    ).text();
    expect(html).toContain("Minting is not available on this gateway");
    expect(html).toContain("no resolver that can read");
    expect(html).not.toContain('action="/tokens/mint"');

    const res = await post("/tokens/revoke", { pubid: existing.record.pubid });
    expect(res.status).toBe(503);
    expect((await stored())[0]?.revokedAt).toBeFalsy();
  });
});
