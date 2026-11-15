import {
  createHash,
  createSign,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import type { Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { resetJwksCache } from "../src/auth/google.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import { CONNECTOR_TX_COOKIE } from "../src/connectors/state.ts";
import { connectorFor, connectorServers } from "../src/connectors/index.ts";

/**
 * The whole console flow, end to end, through the REAL Express app over a real
 * socket: the SSO gate, the sealed transaction cookie, a fake Google, and the
 * real parameter store.
 *
 * What it proves, in the order it matters:
 *
 *   1. The two states a human sees. No token -> **Connect Google**. Token
 *      present -> **Reconnect Google**, with the recorded metadata.
 *   2. A full round trip writes a SECRET parameter into this slug's own
 *      namespace — and the value lands in Secret Manager, not in any Parameter
 *      Manager payload.
 *   3. A mismatched account is refused and NOTHING is stored. This is the case
 *      the issue singles out, and the assertion is on the store, not on the page.
 *   4. Reconnect ROTATES, and a failed one leaves the previous value current.
 *   5. The browser cannot choose a target. There is no field, no query
 *      parameter and no cookie edit that redirects the write.
 *   6. A gateway-seeded client id does not make a connector ready, and one
 *      slug's namespace is never read for another's.
 *   7. No secret value appears in any HTML, any URL, any redirect or any log.
 */

const BOOTSTRAP = "bootstrap-secret-for-the-connector-suite";
const SESSION_KEY = "a-console-session-secret-of-adequate-length";
const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const SHEETS_RO = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SHEETS_RW = "https://www.googleapis.com/auth/spreadsheets";

const RO_SLUG = "google-sheets-personal-ro";
const RW_SLUG = "google-sheets-tadas-tadasant-rw";
const RO_ACCOUNT = "personal@example.com";
const RW_ACCOUNT = "tadas@tadasant.com";

const RO_NS = `/strad/test/mcp/${RO_SLUG}/static/`;
const RW_NS = `/strad/test/mcp/${RW_SLUG}/static/`;
// THE TWO KINDS OF ONE SLUG. The OAuth application (client id and secret) is
// seeded by a human and lives under `static/`; the credential the consent flow
// MINTS lands under `oauth/`, which is the kind's whole purpose. A resolver
// reads both, `oauth/` first.
const RO_OAUTH_NS = `/strad/test/mcp/${RO_SLUG}/oauth/`;
const RW_OAUTH_NS = `/strad/test/mcp/${RW_SLUG}/oauth/`;
const TOKEN_VAR = "GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN";
const SECRETS_NS = "/strad/test/mcp/";
const GATEWAY_NS = "/strad/test/gateway/static/";

const CLIENT_ID = "6-strad-sheets.apps.googleusercontent.com";
const CLIENT_SECRET = "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LEAK";
const REFRESH = "1//0e-REFRESH-TOKEN-CANARY-DO-NOT-LEAK";
const REFRESH_2 = "1//0e-SECOND-REFRESH-TOKEN-CANARY";
const AUTH_CODE = "4/0AX-AUTHORIZATION-CODE-CANARY";

const CONFIG_YAML = `
version: 1
gateway:
  name: strad
  env: test
  publicUrl: https://strad.example
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
      SECRETS_NAMESPACES: "${SECRETS_NS},${GATEWAY_NS}"
    consoleEnv:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${SECRETS_NS},${GATEWAY_NS}"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
  - slug: ${RO_SLUG}
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /${RO_SLUG}
    entitlements: [admin]
    oauth:
      provider: google
      account: ${RO_ACCOUNT}
      scopes: [${SHEETS_RO}]
  - slug: ${RW_SLUG}
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /${RW_SLUG}
    entitlements: [admin]
    oauth:
      provider: google
      account: ${RW_ACCOUNT}
      scopes: [${SHEETS_RW}]
`;
const CONFIG = parseConfig(CONFIG_YAML);

const ADMIN_KEY = JSON.stringify({
  client_email: "strad-secrets-admin@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
});
const SECRETS: Record<string, string> = { ADMIN_KEY };

// --- a locally-signed Google -------------------------------------------------

interface TestKey {
  kid: string;
  jwk: JsonWebKey & { kid: string };
  privateKey: KeyObject;
}
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const GOOGLE_KEY: TestKey = {
  kid: "connector-flow-kid",
  jwk: {
    ...publicKey.export({ format: "jwk" }),
    kid: "connector-flow-kid",
    alg: "RS256",
  },
  privateKey,
};

const b64url = (v: unknown): string =>
  Buffer.from(JSON.stringify(v)).toString("base64url");

function idToken(email: string): string {
  const input = `${b64url({ alg: "RS256", kid: GOOGLE_KEY.kid, typ: "JWT" })}.${b64url(
    {
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: "109283746501928374650",
      exp: Math.floor(Date.now() / 1000) + 3600,
      email,
      email_verified: true,
    },
  )}`;
  const signature = createSign("RSA-SHA256")
    .update(input)
    .sign(GOOGLE_KEY.privateKey)
    .toString("base64url");
  return `${input}.${signature}`;
}

/** What the fake token endpoint answers with next. */
interface TokenAnswer {
  status?: number;
  body?: unknown;
}
let tokenAnswer: TokenAnswer = {};
let tokenRequests: URLSearchParams[] = [];

const connectorFetch: typeof fetch = (async (
  input: unknown,
  init?: RequestInit,
) => {
  if (String(input) !== TOKEN_ENDPOINT) {
    throw new Error(`unexpected connector fetch: ${String(input)}`);
  }
  tokenRequests.push(new URLSearchParams(String(init?.body)));
  return new Response(
    JSON.stringify(
      tokenAnswer.body ?? {
        access_token: "ya29.ACCESS-TOKEN-CANARY",
        refresh_token: REFRESH,
        id_token: idToken(RO_ACCOUNT),
        scope: `openid email ${SHEETS_RO}`,
      },
    ),
    {
      status: tokenAnswer.status ?? 200,
      headers: { "content-type": "application/json" },
    },
  );
}) as typeof fetch;

// --- the app -----------------------------------------------------------------

const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  CONSOLE_SESSION_SECRET: SESSION_KEY,
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

let fake: FakeGcp;
let server: Server;
let baseUrl: string;
/** Every line the app wrote to stderr during a case, for the redaction sweep. */
let stderr: string[] = [];

beforeAll(async () => {
  fake = createFakeGcp();
  const registry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(new EnvSecretProvider(SECRETS)),
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
    connectorFetch,
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

/** The real `fetch` for driving the app; JWKS is answered locally. */
const realFetch = globalThis.fetch;

beforeEach(async () => {
  resetJwksCache();
  tokenAnswer = {};
  tokenRequests = [];
  stderr = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    if (String(input) === JWKS_URI) {
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [GOOGLE_KEY.jwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return realFetch(input as Parameters<typeof fetch>[0], init);
  });

  fake.parameters.clear();
  fake.secrets.clear();
  await seedOauthApp(RO_NS);
  await seedOauthApp(RW_NS);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetJwksCache();
});

async function seedOauthApp(namespace: string): Promise<void> {
  await fake.store.create({
    path: `${namespace}GOOGLE_SHEETS_OAUTH_CLIENT_ID`,
    secret: false,
    value: CLIENT_ID,
  });
  await fake.store.create({
    path: `${namespace}GOOGLE_SHEETS_OAUTH_CLIENT_SECRET`,
    secret: true,
    value: CLIENT_SECRET,
  });
}

const auth = { authorization: `Bearer ${BOOTSTRAP}` };

const get = (path: string, headers: Record<string, string> = auth) =>
  realFetch(`${baseUrl}${path}`, { headers, redirect: "manual" });

const post = (path: string, headers: Record<string, string> = auth) =>
  realFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: "",
    redirect: "manual",
  });

/** Begin a flow and hand back the sealed cookie plus the state Google would echo. */
async function begin(
  slug: string,
): Promise<{ cookie: string; state: string; res: Response }> {
  const res = await post(`/ui/${slug}/connect`);
  const setCookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${CONNECTOR_TX_COOKIE}=`));
  if (!setCookie) throw new Error("no transaction cookie was issued");
  const value = setCookie.split(";")[0]!;
  const location = res.headers.get("location") ?? "";
  const state = new URL(location).searchParams.get("state") ?? "";
  return { cookie: value, state, res };
}

const callback = (cookie: string, query: string) =>
  get(`/ui/oauth/callback?${query}`, { ...auth, cookie });

async function listed(namespace: string): Promise<string[]> {
  return (await fake.store.list(namespace)).map((p) => p.variable).sort();
}

// ---------------------------------------------------------------------------

describe("the two states a human sees", () => {
  it("offers Connect Google when no refresh token is stored", async () => {
    const res = await get(`/ui/${RO_SLUG}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Connect Google");
    expect(html).not.toContain("Reconnect Google");
    expect(html).toContain("Not connected");
    // The terms, stated before the redirect.
    expect(html).toContain(RO_ACCOUNT);
    expect(html).toContain("read-only");
    expect(html).toContain(SHEETS_RO);
    expect(html).toContain(`${RO_OAUTH_NS}${TOKEN_VAR}`);
    expect(html).toContain("https://strad.example/ui/oauth/callback");
  });

  it("offers Reconnect Google once one is, with the recorded metadata", async () => {
    const { cookie, state } = await begin(RO_SLUG);
    await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    const html = await (await get(`/ui/${RO_SLUG}`)).text();
    expect(html).toContain("Reconnect Google");
    expect(html).not.toContain(">Connect Google<");
    expect(html).toContain("A credential is stored");
    expect(html).toContain(`connected as ${RO_ACCOUNT}`);
    // Honest about what a stored value is NOT evidence of.
    expect(html).toMatch(/cannot tell you whether Google still accepts it/);
  });

  it("states the read-write tier and scope on a -rw slug", async () => {
    const html = await (await get(`/ui/${RW_SLUG}`)).text();
    expect(html).toContain("read-write");
    expect(html).toContain(RW_ACCOUNT);
    expect(html).toContain(SHEETS_RW);
  });

  it("is behind the SSO gate, like every other console surface", async () => {
    expect((await get(`/ui/${RO_SLUG}`, {})).status).toBe(401);
    expect((await post(`/ui/${RO_SLUG}/connect`, {})).status).toBe(401);
    expect((await get(`/ui/oauth/callback?state=x&code=y`, {})).status).toBe(
      401,
    );
  });
});

describe("a full round trip", () => {
  it("writes a SECRET parameter into this slug's own namespace", async () => {
    const { cookie, state } = await begin(RO_SLUG);
    const res = await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/ui/${RO_SLUG}?connected=1`);

    // The application namespace is UNTOUCHED — the flow writes one parameter,
    // and it writes it to the `oauth` kind.
    expect(await listed(RO_NS)).toEqual([
      "GOOGLE_SHEETS_OAUTH_CLIENT_ID",
      "GOOGLE_SHEETS_OAUTH_CLIENT_SECRET",
    ]);
    expect(await listed(RO_OAUTH_NS)).toEqual([TOKEN_VAR]);
    expect(await fake.store.reveal(`${RO_OAUTH_NS}${TOKEN_VAR}`)).toBe(REFRESH);
  });

  it("puts the value in Secret Manager and NOT in any Parameter Manager payload", async () => {
    const { cookie, state } = await begin(RO_SLUG);
    await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    // Secret Manager holds the value base64url-encoded (the parameter wire's
    // envelope encoding — see src/secrets/parameters/wire.ts), so the assertion
    // is against the encoded form. Parameter Manager holds a `__REF__` pointer
    // and must contain neither spelling.
    const encoded = Buffer.from(REFRESH, "utf8").toString("base64url");
    const payloads = JSON.stringify([...fake.parameters.values()]);
    expect(payloads).not.toContain(REFRESH);
    expect(payloads).not.toContain(encoded);
    expect(JSON.stringify([...fake.secrets.values()])).toContain(encoded);
  });

  it("records only safe metadata: the email, the granted scopes and the time", async () => {
    const { cookie, state } = await begin(RO_SLUG);
    await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    const meta = (await fake.store.list(RO_OAUTH_NS)).find(
      (p) => p.variable === TOKEN_VAR,
    );
    expect(meta?.note).toContain(`connected as ${RO_ACCOUNT}`);
    expect(meta?.note).toContain(SHEETS_RO);
    expect(meta?.note).not.toContain(REFRESH);
    expect(meta?.note).not.toContain(CLIENT_SECRET);
  });

  it("sends the exact redirect URI and the sealed PKCE verifier to Google", async () => {
    const { cookie, state, res } = await begin(RO_SLUG);
    const authorize = new URL(res.headers.get("location")!);
    await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    const sent = tokenRequests[0]!;
    expect(sent.get("redirect_uri")).toBe(
      "https://strad.example/ui/oauth/callback",
    );
    expect(sent.get("code")).toBe(AUTH_CODE);
    expect(sent.get("client_id")).toBe(CLIENT_ID);
    // The verifier never appeared in the URL the browser was sent to.
    expect(authorize.searchParams.get("code_verifier")).toBeNull();
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("reconnect", () => {
  it("rotates the stored token rather than creating a second parameter", async () => {
    const first = await begin(RO_SLUG);
    await callback(
      first.cookie,
      `state=${encodeURIComponent(first.state)}&code=${AUTH_CODE}`,
    );

    tokenAnswer = {
      body: {
        refresh_token: REFRESH_2,
        id_token: idToken(RO_ACCOUNT),
        scope: `openid email ${SHEETS_RO}`,
      },
    };
    const second = await begin(RO_SLUG);
    await callback(
      second.cookie,
      `state=${encodeURIComponent(second.state)}&code=${AUTH_CODE}`,
    );

    expect(await listed(RO_OAUTH_NS)).toEqual([TOKEN_VAR]);
    expect(await fake.store.reveal(`${RO_OAUTH_NS}${TOKEN_VAR}`)).toBe(
      REFRESH_2,
    );
  });

  it("leaves the previous credential current when the new consent is refused", async () => {
    const first = await begin(RO_SLUG);
    await callback(
      first.cookie,
      `state=${encodeURIComponent(first.state)}&code=${AUTH_CODE}`,
    );

    // A revoked/expired token being re-consented, and Google refuses.
    tokenAnswer = { status: 400, body: { error: "invalid_grant" } };
    const second = await begin(RO_SLUG);
    const res = await callback(
      second.cookie,
      `state=${encodeURIComponent(second.state)}&code=${AUTH_CODE}`,
    );

    expect(res.headers.get("location")).toBe(
      `/ui/${RO_SLUG}?error=exchange_failed`,
    );
    expect(await fake.store.reveal(`${RO_OAUTH_NS}${TOKEN_VAR}`)).toBe(REFRESH);
  });
});

describe("a mismatched account is refused, and nothing is stored", () => {
  it("refuses a token minted for another Google account", async () => {
    tokenAnswer = {
      body: {
        refresh_token: REFRESH,
        id_token: idToken("someone-else@gmail.com"),
        scope: `openid email ${SHEETS_RO}`,
      },
    };
    const { cookie, state } = await begin(RO_SLUG);
    const res = await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    expect(res.headers.get("location")).toBe(
      `/ui/${RO_SLUG}?error=account_mismatch`,
    );
    // THE ASSERTION THAT MATTERS: the store never saw it.
    expect(await listed(RO_NS)).toEqual([
      "GOOGLE_SHEETS_OAUTH_CLIENT_ID",
      "GOOGLE_SHEETS_OAUTH_CLIENT_SECRET",
    ]);
    expect(await listed(RO_OAUTH_NS)).toEqual([]);
    expect(JSON.stringify([...fake.secrets.values()])).not.toContain(REFRESH);

    const html = await (
      await get(`/ui/${RO_SLUG}?error=account_mismatch`)
    ).text();
    expect(html).toContain("a different Google account");
    expect(html).toContain(RO_ACCOUNT);
    // The other account's address is not carried through the URL onto the page.
    expect(html).not.toContain("someone-else@gmail.com");
  });

  it("cannot install one account's token into the other account's slug", async () => {
    // The RO slug's account consents while the RW slug's flow is in progress.
    tokenAnswer = {
      body: {
        refresh_token: REFRESH,
        id_token: idToken(RO_ACCOUNT),
        scope: `openid email ${SHEETS_RW}`,
      },
    };
    const { cookie, state } = await begin(RW_SLUG);
    await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    expect(await listed(RW_OAUTH_NS)).toEqual([]);
  });

  it("refuses a read-only consent for a read-write slug", async () => {
    tokenAnswer = {
      body: {
        refresh_token: REFRESH,
        id_token: idToken(RW_ACCOUNT),
        scope: `openid email ${SHEETS_RO}`,
      },
    };
    const { cookie, state } = await begin(RW_SLUG);
    const res = await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );
    expect(res.headers.get("location")).toBe(
      `/ui/${RW_SLUG}?error=scope_not_granted`,
    );
    expect(await listed(RW_OAUTH_NS)).toEqual([]);
  });

  it("refuses a consent that returned no refresh token", async () => {
    tokenAnswer = {
      body: {
        access_token: "ya29.only-an-hour",
        id_token: idToken(RO_ACCOUNT),
        scope: `openid email ${SHEETS_RO}`,
      },
    };
    const { cookie, state } = await begin(RO_SLUG);
    const res = await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );
    expect(res.headers.get("location")).toBe(
      `/ui/${RO_SLUG}?error=no_refresh_token`,
    );
    expect(await listed(RO_OAUTH_NS)).toEqual([]);
  });
});

describe("the state, and what a callback cannot do", () => {
  it("refuses a callback with no transaction at all", async () => {
    const res = await get(
      `/ui/oauth/callback?state=anything&code=${AUTH_CODE}`,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("No authorization in progress");
    expect(tokenRequests).toHaveLength(0);
  });

  it("refuses a mismatched state", async () => {
    const { cookie } = await begin(RO_SLUG);
    const res = await callback(cookie, `state=not-the-one&code=${AUTH_CODE}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("does not match");
    expect(tokenRequests).toHaveLength(0);
  });

  it("refuses a REPLAYED callback: the transaction is spent on first use", async () => {
    const { cookie, state } = await begin(RO_SLUG);
    const query = `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`;

    const first = await callback(cookie, query);
    expect(first.status).toBe(302);
    // The browser was told to drop the cookie, so a real replay has none. This
    // asserts the other half: the response clears it.
    const cleared = first.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${CONNECTOR_TX_COOKIE}=`));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it("refuses a transaction begun by a DIFFERENT console session", async () => {
    // The bypass principal's id is fixed, so a second identity is modelled by
    // sealing a transaction whose `sid` names a Google session this browser is
    // not holding.
    const { connector } = (
      await import("../src/auth/session.ts")
    ).consoleSessionsFromEnv({ CONSOLE_SESSION_SECRET: SESSION_KEY })!;
    const sealed = connector.seal({
      v: 1,
      state: "a-state-value-of-adequate-length",
      verifier: "a-verifier-value-of-adequate-length",
      slug: RO_SLUG,
      env: "test",
      account: RO_ACCOUNT,
      scopes: ["openid", "email", SHEETS_RO],
      variable: "GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN",
      sid: "google:somebody-else",
      next: `/ui/${RO_SLUG}`,
      exp: Date.now() + 60_000,
    });
    const res = await callback(
      `${CONNECTOR_TX_COOKIE}=${encodeURIComponent(sealed)}`,
      `state=a-state-value-of-adequate-length&code=${AUTH_CODE}`,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("belongs to another session");
    expect(tokenRequests).toHaveLength(0);
  });

  it("refuses a transaction sealed against another deployment", async () => {
    const { connector } = (
      await import("../src/auth/session.ts")
    ).consoleSessionsFromEnv({ CONSOLE_SESSION_SECRET: SESSION_KEY })!;
    const sealed = connector.seal({
      v: 1,
      state: "a-state-value-of-adequate-length",
      verifier: "a-verifier-value-of-adequate-length",
      slug: RO_SLUG,
      env: "prod",
      account: RO_ACCOUNT,
      scopes: ["openid", "email", SHEETS_RO],
      variable: "GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN",
      sid: "console-bypass:dev-bypass",
      next: `/ui/${RO_SLUG}`,
      exp: Date.now() + 60_000,
    });
    const res = await callback(
      `${CONNECTOR_TX_COOKIE}=${encodeURIComponent(sealed)}`,
      `state=a-state-value-of-adequate-length&code=${AUTH_CODE}`,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("another deployment");
  });

  it("ignores every query parameter that is not `state` or `code`", async () => {
    const { cookie, state } = await begin(RO_SLUG);
    // A browser proposing a target path, a variable, an account and a scope.
    const res = await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}` +
        `&slug=secrets&path=${encodeURIComponent(`${GATEWAY_NS}STRAD_TOKENS`)}` +
        `&variable=STRAD_TOKENS&account=attacker@example.com` +
        `&scope=${encodeURIComponent(SHEETS_RW)}`,
    );

    expect(res.headers.get("location")).toBe(`/ui/${RO_SLUG}?connected=1`);
    // The write landed where the CONFIG said, and nowhere else.
    expect(await listed(RO_OAUTH_NS)).toContain(TOKEN_VAR);
    expect(await listed(GATEWAY_NS)).toEqual([]);
  });

  it("refuses a DISABLED server, which no render would ever read", async () => {
    // A disabled server is skipped by renderAppSpec entirely, so a consent run
    // against one would mint a real Google credential into a namespace nothing
    // injects — the console half of the "credential in a drawer" the config gate
    // refuses for a kind nothing injects for.
    const disabled = parseConfig(
      CONFIG_YAML.replace(
        `  - slug: ${RO_SLUG}\n    kind: supplementary-image`,
        `  - slug: ${RO_SLUG}\n    enabled: false\n    kind: supplementary-image`,
      ),
    );
    expect(connectorFor(disabled, RO_SLUG)).toBeNull();
    expect(connectorServers(disabled).map((c) => c.server.slug)).toEqual([
      RW_SLUG,
    ]);
  });

  it("refuses to begin a flow for a server with no connector", async () => {
    const res = await post(`/ui/secrets/connect`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("No connector on this server");
  });
});

describe("the credential is the SLUG's, and only the slug's", () => {
  it("is not made ready by a client id under the gateway namespace", async () => {
    fake.parameters.clear();
    fake.secrets.clear();
    await fake.store.create({
      path: `${GATEWAY_NS}GOOGLE_SHEETS_OAUTH_CLIENT_ID`,
      secret: false,
      value: CLIENT_ID,
    });
    await fake.store.create({
      path: `${GATEWAY_NS}GOOGLE_SHEETS_OAUTH_CLIENT_SECRET`,
      secret: true,
      value: CLIENT_SECRET,
    });

    const html = await (await get(`/ui/${RO_SLUG}`)).text();
    expect(html).toContain(
      "The OAuth application is not seeded for this server",
    );
    expect(html).not.toContain("Connect Google");

    // And the button refuses too — the page's state is not the gate.
    const res = await post(`/ui/${RO_SLUG}/connect`);
    expect(res.status).toBe(409);
    expect(res.headers.get("location")).toBeNull();
  });

  it("is not made ready by a sibling slug's values", async () => {
    fake.parameters.clear();
    fake.secrets.clear();
    await seedOauthApp(RW_NS);

    const html = await (await get(`/ui/${RO_SLUG}`)).text();
    expect(html).toContain(
      "The OAuth application is not seeded for this server",
    );
    expect((await post(`/ui/${RO_SLUG}/connect`)).status).toBe(409);
  });

  it("writes into the slug's own namespace even when a sibling is connected", async () => {
    const ro = await begin(RO_SLUG);
    await callback(
      ro.cookie,
      `state=${encodeURIComponent(ro.state)}&code=${AUTH_CODE}`,
    );

    tokenAnswer = {
      body: {
        refresh_token: REFRESH_2,
        id_token: idToken(RW_ACCOUNT),
        scope: `openid email ${SHEETS_RW}`,
      },
    };
    const rw = await begin(RW_SLUG);
    await callback(
      rw.cookie,
      `state=${encodeURIComponent(rw.state)}&code=${AUTH_CODE}`,
    );

    expect(await fake.store.reveal(`${RO_OAUTH_NS}${TOKEN_VAR}`)).toBe(REFRESH);
    expect(await fake.store.reveal(`${RW_OAUTH_NS}${TOKEN_VAR}`)).toBe(
      REFRESH_2,
    );
  });
});

describe("nothing secret is ever exposed", () => {
  it("keeps the token, the code and the client secret out of every surface", async () => {
    const { cookie, state, res: began } = await begin(RO_SLUG);
    const authorizeUrl = began.headers.get("location")!;
    const done = await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );
    const page = await (await get(`/ui/${RO_SLUG}?connected=1`)).text();

    const surfaces = [
      authorizeUrl,
      done.headers.get("location") ?? "",
      page,
      stderr.join("\n"),
      // The sealed cookie itself: the payload is signed, not encrypted, so what
      // it carries is readable by whoever holds it. The verifier is in there by
      // necessity; the credential must not be.
      Buffer.from(cookie.split("=")[1]!.split(".")[0]!, "base64url").toString(),
    ];

    for (const surface of surfaces) {
      expect(surface).not.toContain(REFRESH);
      expect(surface).not.toContain(CLIENT_SECRET);
      expect(surface).not.toContain("ya29.");
    }
    // The authorization code reaches Google and the token endpoint, and nothing
    // else: not the success redirect, not the page, not the logs.
    expect(done.headers.get("location")).not.toContain(AUTH_CODE);
    expect(page).not.toContain(AUTH_CODE);
    expect(stderr.join("\n")).not.toContain(AUTH_CODE);
  });

  it("does not leak a length hint or a fingerprint onto the page", async () => {
    const { cookie, state } = await begin(RO_SLUG);
    await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );
    const page = await (await get(`/ui/${RO_SLUG}`)).text();
    // No prefix, no suffix, no base64 of it, no SHA-256 of it. A "safe" hint
    // (first four characters, a digest, a character count rendered as
    // `38 characters`) is the shape this guards against.
    expect(page).not.toContain(REFRESH.slice(0, 8));
    expect(page).not.toContain(REFRESH.slice(-8));
    expect(page).not.toContain(Buffer.from(REFRESH).toString("base64url"));
    expect(page).not.toContain(
      createHash("sha256").update(REFRESH).digest("hex"),
    );
    expect(page).not.toMatch(
      new RegExp(`\\b${REFRESH.length}\\s*(characters|chars|bytes)`),
    );
  });
});
