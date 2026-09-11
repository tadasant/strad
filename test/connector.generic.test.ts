import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import { CONNECTOR_TX_COOKIE } from "../src/connectors/state.ts";

/**
 * The GENERIC provider's console flow, end to end, through the REAL Express app
 * over a real socket: the SSO gate, the sealed transaction cookie, a stubbed
 * OAuth provider, and the real parameter store.
 *
 * **Real-provider verification is not possible from here and was not performed.**
 * There is no registered OAuth client and no human at a consent screen, so the
 * third party is a stub. What that stub is allowed to be is the point: it is a
 * plain RFC 6749 token endpoint, and every assertion below is about what strad
 * SENDS it and what strad does with what comes back — never about a behaviour
 * only the real provider could exhibit.
 *
 * What it proves:
 *
 *   1. The authorize URL is built from the CONFIG's endpoint, carries PKCE, and
 *      carries the provider-specific extras the config named.
 *   2. A round trip stores the durable credential as a SECRET parameter under
 *      the slug's `oauth` KIND — the value in Secret Manager, never in Parameter
 *      Manager.
 *   3. `credential: access_token` stores the access token, for the providers
 *      that issue no refresh token at all.
 *   4. A response missing the configured field is REFUSED and nothing is written.
 *   5. `clientAuth: basic` moves the secret to the Authorization header and out
 *      of the body.
 *   6. No secret reaches any HTML, URL, redirect or log.
 */

const BOOTSTRAP = "bootstrap-secret-for-the-generic-connector-suite";
const SESSION_KEY = "a-console-session-secret-of-adequate-length";

const SLUG = "linear-ro";
const BASIC_SLUG = "notion-rw";
const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";

const NS = `/strad/test/mcp/${SLUG}/static/`;
const OAUTH_NS = `/strad/test/mcp/${SLUG}/oauth/`;
const BASIC_NS = `/strad/test/mcp/${BASIC_SLUG}/static/`;
const BASIC_OAUTH_NS = `/strad/test/mcp/${BASIC_SLUG}/oauth/`;

const CLIENT_ID = "linear-client-id";
const CLIENT_SECRET = "linear-CLIENT-SECRET-CANARY-DO-NOT-LEAK+/=";
const REFRESH = "lin_refresh-TOKEN-CANARY-DO-NOT-LEAK";
const ACCESS = "lin_access-TOKEN-CANARY-DO-NOT-LEAK";
const AUTH_CODE = "lin-AUTHORIZATION-CODE-CANARY";

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
    consoleEnv:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "/strad/test/mcp/"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
  - slug: ${SLUG}
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /${SLUG}
    entitlements: [admin]
    oauth:
      provider: generic
      label: Linear
      authorizeUrl: ${AUTHORIZE_URL}
      tokenUrl: ${TOKEN_URL}
      scopes: [read]
      authorizeParams:
        access_type: offline
        prompt: consent
      clientIdVariable: LINEAR_OAUTH_CLIENT_ID
      clientSecretVariable: LINEAR_OAUTH_CLIENT_SECRET
      refreshTokenVariable: LINEAR_OAUTH_TOKEN
  - slug: ${BASIC_SLUG}
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /${BASIC_SLUG}
    entitlements: [admin]
    oauth:
      provider: generic
      authorizeUrl: https://api.notion.com/v1/oauth/authorize
      tokenUrl: https://api.notion.com/v1/oauth/token
      clientAuth: basic
      credential: access_token
      clientIdVariable: NOTION_OAUTH_CLIENT_ID
      clientSecretVariable: NOTION_OAUTH_CLIENT_SECRET
      refreshTokenVariable: NOTION_OAUTH_TOKEN
`;
const CONFIG = parseConfig(CONFIG_YAML);

const ADMIN_KEY = JSON.stringify({
  client_email: "strad-secrets-admin@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
});
const SECRETS: Record<string, string> = { ADMIN_KEY };

// --- the stubbed provider ----------------------------------------------------

interface TokenAnswer {
  status?: number;
  body?: unknown;
}
let tokenAnswer: TokenAnswer = {};
let tokenRequests: { url: string; body: URLSearchParams; headers: Headers }[] =
  [];

const connectorFetch: typeof fetch = (async (
  input: unknown,
  init?: RequestInit,
) => {
  tokenRequests.push({
    url: String(input),
    body: new URLSearchParams(String(init?.body)),
    headers: new Headers(init?.headers as Record<string, string>),
  });
  return new Response(
    JSON.stringify(
      tokenAnswer.body ?? {
        access_token: ACCESS,
        refresh_token: REFRESH,
        scope: "read",
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

beforeEach(async () => {
  tokenAnswer = {};
  tokenRequests = [];
  fake.parameters.clear();
  fake.secrets.clear();
  await seedApp(NS, "LINEAR");
  await seedApp(BASIC_NS, "NOTION");
});

async function seedApp(namespace: string, prefix: string): Promise<void> {
  await fake.store.create({
    path: `${namespace}${prefix}_OAUTH_CLIENT_ID`,
    secret: false,
    value: CLIENT_ID,
  });
  await fake.store.create({
    path: `${namespace}${prefix}_OAUTH_CLIENT_SECRET`,
    secret: true,
    value: CLIENT_SECRET,
  });
}

const auth = { authorization: `Bearer ${BOOTSTRAP}` };

const get = (path: string, headers: Record<string, string> = auth) =>
  fetch(`${baseUrl}${path}`, { headers, redirect: "manual" });

const post = (path: string, headers: Record<string, string> = auth) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: "",
    redirect: "manual",
  });

async function begin(
  slug: string,
): Promise<{ cookie: string; state: string; res: Response }> {
  const res = await post(`/ui/${slug}/connect`);
  const setCookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${CONNECTOR_TX_COOKIE}=`));
  if (!setCookie) throw new Error("no transaction cookie was issued");
  const location = res.headers.get("location") ?? "";
  return {
    cookie: setCookie.split(";")[0]!,
    state: new URL(location).searchParams.get("state") ?? "",
    res,
  };
}

const callback = (cookie: string, query: string) =>
  get(`/ui/oauth/callback?${query}`, { ...auth, cookie });

async function listed(namespace: string): Promise<string[]> {
  return (await fake.store.list(namespace)).map((p) => p.variable).sort();
}

// ---------------------------------------------------------------------------

describe("the consent URL a generic provider gets", () => {
  it("is built from the config's endpoint, with PKCE and the config's extras", async () => {
    const { res } = await begin(SLUG);
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);

    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://strad.example/ui/oauth/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    // The config's provider-specific extras, applied verbatim.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    // NO identity scopes: strad has no standard proof to ask a generic provider
    // for, so it asks for nothing it cannot check.
    expect(url.searchParams.get("scope")).not.toContain("openid");
    // The PKCE verifier stays in the sealed cookie and never reaches the URL.
    expect(res.headers.get("location")).not.toContain("code_verifier");
  });

  it("states the terms on the page, and says the account is NOT checked", async () => {
    const html = await (await get(`/ui/${SLUG}`)).text();
    expect(html).toContain("Connect Linear");
    expect(html).toContain("Not connected");
    expect(html).toContain("read");
    // The honest sentence: strad cannot prove which account consented.
    expect(html).toContain("not checked");
    expect(html).toContain("strad cannot check which account");
    // The page names the `oauth`-kind path the credential will land at.
    expect(html).toContain(`${OAUTH_NS}LINEAR_OAUTH_TOKEN`);
  });
});

describe("a full generic round trip", () => {
  it("stores the refresh token as a SECRET parameter under the oauth kind", async () => {
    const { cookie, state } = await begin(SLUG);
    const res = await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);

    // The application namespace is untouched; the credential is in `oauth/`.
    expect(await listed(NS)).toEqual([
      "LINEAR_OAUTH_CLIENT_ID",
      "LINEAR_OAUTH_CLIENT_SECRET",
    ]);
    expect(await listed(OAUTH_NS)).toEqual(["LINEAR_OAUTH_TOKEN"]);
    expect(await fake.store.reveal(`${OAUTH_NS}LINEAR_OAUTH_TOKEN`)).toBe(
      REFRESH,
    );

    // The value is in Secret Manager and in NO Parameter Manager payload.
    const encoded = Buffer.from(REFRESH, "utf8").toString("base64url");
    const payloads = JSON.stringify([...fake.parameters.values()]);
    expect(payloads).not.toContain(REFRESH);
    expect(payloads).not.toContain(encoded);
    expect(JSON.stringify([...fake.secrets.values()])).toContain(encoded);
  });

  it("sends the code, the PKCE verifier and the client secret to the config's token URL", async () => {
    const { cookie, state } = await begin(SLUG);
    await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    expect(tokenRequests).toHaveLength(1);
    const req = tokenRequests[0]!;
    expect(req.url).toBe(TOKEN_URL);
    expect(req.body.get("grant_type")).toBe("authorization_code");
    expect(req.body.get("code")).toBe(AUTH_CODE);
    expect(req.body.get("code_verifier")).toBeTruthy();
    expect(req.body.get("redirect_uri")).toBe(
      "https://strad.example/ui/oauth/callback",
    );
    // `clientAuth: post` (the default) puts the secret in the body.
    expect(req.body.get("client_secret")).toBe(CLIENT_SECRET);
    expect(req.headers.get("authorization")).toBeNull();
  });

  it("records a note with no account, because none was proved", async () => {
    const { cookie, state } = await begin(SLUG);
    await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    const meta = (await fake.store.list(OAUTH_NS)).find(
      (p) => p.variable === "LINEAR_OAUTH_TOKEN",
    );
    expect(meta?.note).toContain("connected via the strad console");
    // It must not claim an account it never checked.
    expect(meta?.note).not.toContain("connected as");
    expect(meta?.note).toContain("granted: read");
    expect(meta?.note).not.toContain(REFRESH);
    expect(meta?.note).not.toContain(CLIENT_SECRET);
  });

  it("rotates on reconnect rather than creating a second parameter", async () => {
    const first = await begin(SLUG);
    await callback(
      first.cookie,
      `state=${encodeURIComponent(first.state)}&code=${AUTH_CODE}`,
    );

    tokenAnswer = {
      body: { refresh_token: "lin_refresh-SECOND", scope: "read" },
    };
    const second = await begin(SLUG);
    await callback(
      second.cookie,
      `state=${encodeURIComponent(second.state)}&code=${AUTH_CODE}`,
    );

    expect(await listed(OAUTH_NS)).toEqual(["LINEAR_OAUTH_TOKEN"]);
    expect(await fake.store.reveal(`${OAUTH_NS}LINEAR_OAUTH_TOKEN`)).toBe(
      "lin_refresh-SECOND",
    );
  });
});

describe("credential: access_token, and clientAuth: basic", () => {
  it("stores the ACCESS token when that is the durable one", async () => {
    // Slack, Linear and Notion issue no refresh token at all; demanding one
    // would refuse every correct consent they can produce.
    tokenAnswer = { body: { access_token: ACCESS } };
    const { cookie, state } = await begin(BASIC_SLUG);
    const res = await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    expect(res.headers.get("location")).toBe(`/ui/${BASIC_SLUG}?connected=1`);
    expect(await fake.store.reveal(`${BASIC_OAUTH_NS}NOTION_OAUTH_TOKEN`)).toBe(
      ACCESS,
    );
  });

  it("moves the client secret to the Authorization header, and out of the body", async () => {
    tokenAnswer = { body: { access_token: ACCESS } };
    const { cookie, state } = await begin(BASIC_SLUG);
    await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    const req = tokenRequests[0]!;
    expect(req.body.get("client_secret")).toBeNull();
    const header = req.headers.get("authorization")!;
    expect(header).toMatch(/^Basic /);
    // Form-encoded BEFORE base64, per RFC 6749 §2.3.1 — which is what makes a
    // secret carrying `+` and `/` survive the trip.
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    // Each half is form-encoded, so the two halves decode back to the originals
    // and the `+` in the secret survived as `%2B` rather than as a space.
    const [user, pass] = decoded.split(":");
    expect(new URLSearchParams(`v=${user}`).get("v")).toBe(CLIENT_ID);
    expect(new URLSearchParams(`v=${pass}`).get("v")).toBe(CLIENT_SECRET);
    expect(decoded).toContain("%2B");
  });

  it("REFUSES a response with no access_token, and writes nothing", async () => {
    // The provider answered with a refresh token, which this slug does not treat
    // as durable. Storing it would be a silent downgrade.
    tokenAnswer = { body: { refresh_token: REFRESH } };
    const { cookie, state } = await begin(BASIC_SLUG);
    const res = await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    expect(res.headers.get("location")).toBe(
      `/ui/${BASIC_SLUG}?error=no_credential`,
    );
    expect(await listed(BASIC_OAUTH_NS)).toEqual([]);
    expect(JSON.stringify([...fake.secrets.values()])).not.toContain(REFRESH);
  });
});

describe("what a generic consent is still checked for", () => {
  it("REFUSES a grant narrower than the config asked for", async () => {
    // An EXPLICIT narrower grant: the provider named its scopes and `read` was
    // not among them.
    tokenAnswer = { body: { refresh_token: REFRESH, scope: "profile" } };
    const { cookie, state } = await begin(SLUG);
    const res = await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    expect(res.headers.get("location")).toBe(
      `/ui/${SLUG}?error=scope_not_granted`,
    );
    expect(await listed(OAUTH_NS)).toEqual([]);
  });

  it("accepts a response that names NO scopes, per RFC 6749 §5.1", async () => {
    // `scope` is OPTIONAL in a token response and required only when the grant
    // differs from the request, so silence means "what you asked for". Refusing
    // it would refuse every correct consent from a spec-compliant provider.
    tokenAnswer = { body: { refresh_token: REFRESH } };
    const { cookie, state } = await begin(SLUG);
    const res = await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );

    expect(res.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);
    expect(await fake.store.reveal(`${OAUTH_NS}LINEAR_OAUTH_TOKEN`)).toBe(
      REFRESH,
    );
  });

  it("REFUSES a refused exchange without touching the stored credential", async () => {
    const first = await begin(SLUG);
    await callback(
      first.cookie,
      `state=${encodeURIComponent(first.state)}&code=${AUTH_CODE}`,
    );

    tokenAnswer = { status: 400, body: { error: "invalid_grant" } };
    const second = await begin(SLUG);
    const res = await callback(
      second.cookie,
      `state=${encodeURIComponent(second.state)}&code=${AUTH_CODE}`,
    );

    expect(res.headers.get("location")).toBe(
      `/ui/${SLUG}?error=exchange_failed`,
    );
    expect(await fake.store.reveal(`${OAUTH_NS}LINEAR_OAUTH_TOKEN`)).toBe(
      REFRESH,
    );
  });

  it("never renders the provider's own error text", async () => {
    tokenAnswer = {
      status: 400,
      body: { error: "invalid_grant", error_description: "UPSTREAM-PROSE" },
    };
    const { cookie, state } = await begin(SLUG);
    const res = await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );
    expect(res.headers.get("location")).not.toContain("UPSTREAM-PROSE");
    const html = await (await get(`/ui/${SLUG}?error=exchange_failed`)).text();
    expect(html).not.toContain("UPSTREAM-PROSE");
  });
});

describe("nothing secret is exposed by the generic flow", () => {
  it("keeps the token, the code and the client secret off every surface", async () => {
    const { cookie, state, res: began } = await begin(SLUG);
    const authorizeUrl = began.headers.get("location")!;
    const done = await callback(
      cookie,
      `state=${encodeURIComponent(state)}&code=${AUTH_CODE}`,
    );
    const page = await (await get(`/ui/${SLUG}?connected=1`)).text();

    for (const surface of [
      authorizeUrl,
      done.headers.get("location") ?? "",
      page,
      cookie,
    ]) {
      expect(surface).not.toContain(REFRESH);
      expect(surface).not.toContain(ACCESS);
      expect(surface).not.toContain(CLIENT_SECRET);
      expect(surface).not.toContain(AUTH_CODE);
    }
  });
});
