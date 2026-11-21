import type { Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { CONNECTOR_TX_COOKIE } from "../src/connectors/state.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createParameterWriteBack } from "../src/http/params.ts";
import {
  createFakeGcp,
  RESOLVER_PERMISSIONS,
  WRITE_ONLY_CONSOLE_PERMISSIONS,
  type FakeGcp,
} from "../src/secrets/parameters/fake.ts";
import { buildSecretProviders } from "../src/secrets/provider/index.ts";
import {
  startFakeOAuth,
  type FakeOAuth,
  type FakeOAuthOptions,
} from "./helpers/fake-oauth.ts";

/**
 * **Connect** for a `remote-http` server with `oauthRefresh:`, end to end.
 *
 * Nothing at the seams is mocked. strad's real Express app, its SSO gate, its
 * sealed transaction cookie and its real `/mcp` route; the in-memory Parameter
 * Manager + Secret Manager double as BOTH the console's admin store AND the
 * running gateway's resolver; and on the other side an MCP upstream that is
 * also its own authorization server — protected-resource metadata, RFC 8414
 * metadata, dynamic registration, an authorization endpoint and a token
 * endpoint that checks PKCE, the client, the redirect URI and the resource
 * (test/helpers/fake-oauth.ts).
 *
 * The claim it exists to make: a slug whose every `oauthRefresh` value is a
 * `mayBeUnseeded` `${NAME}` deploys inactive, a human clicks Connect, and the
 * VERY NEXT `/mcp` call is served with a token minted from what the flow
 * stored — no redeploy, no restart, nothing seeded by hand. The resolver's
 * snapshot TTL is a day here, so a pass cannot be the cache aging out.
 *
 * There is no real Rippling here. The only browser step — a human at the
 * consent screen — is the fake's `/authorize` answering at once.
 */

const BOOTSTRAP = "bootstrap-secret-for-the-upstream-connector-suite";
const SESSION_KEY = "a-console-session-secret-of-adequate-length";
const SLUG = "rippling";
const OAUTH_NS = `/strad/test/mcp/${SLUG}/oauth/`;
const STATIC_NS = `/strad/test/mcp/${SLUG}/static/`;

const ADMIN_KEY = JSON.stringify({
  client_email: "strad-secrets-admin@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Harness {
  oauth: FakeOAuth;
  fake: FakeGcp;
  base: string;
  mcp: () => Promise<Client>;
}

async function harness(
  opts: FakeOAuthOptions = {},
  oauthRefresh = `
      tokenUrl: "\${RIPPLING_TOKEN_URL}"
      clientId: "\${RIPPLING_CLIENT_ID}"
      refreshToken: "\${RIPPLING_REFRESH_TOKEN}"
      resource: "\${RIPPLING_RESOURCE}"
    mayBeUnseeded:
      [RIPPLING_TOKEN_URL, RIPPLING_CLIENT_ID, RIPPLING_REFRESH_TOKEN, RIPPLING_RESOURCE]`,
  more: {
    servers?: string;
    connectorFetch?: typeof fetch;
    /**
     * Run with production's IAM split instead of one all-powerful client: the
     * console writes through `WRITE_ONLY_CONSOLE_PERMISSIONS` and the gateway
     * reads through `RESOLVER_PERMISSIONS`, two clients over the same store.
     */
    prodIam?: boolean;
  } = {},
): Promise<Harness> {
  const oauth = await startFakeOAuth({
    mcpAuth: { scopes: ["mcp:read"] },
    ...opts,
  });
  cleanup.push(() => oauth.close());
  // The account the human signs in as — and the one the upstream URL serves.
  oauth.consentAs("tadas");

  const config = parseConfig(`
version: 1
gateway:
  name: strad
  env: test
  publicUrl: https://strad.example
  secrets: { provider: gcp-parameter-store, ttlSeconds: 86400 }
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
    kind: remote-http
    url: ${oauth.mcpUrl("tadas")}
    entitlements: [admin]
    oauthRefresh:${oauthRefresh}
${more.servers ?? ""}`);

  // A DAY. The gateway's resolver will not re-read the store on its own inside
  // this test, so a slug that starts serving does so because Connect dropped
  // the cached reading.
  const fake = createFakeGcp({ snapshotTtlMs: 86_400_000 });
  const token = mintToken({ env: "test", label: "admin", roles: ["admin"] });
  const env: NodeJS.ProcessEnv = {
    ALLOW_DEV_AUTH: "true",
    ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
    CONSOLE_SESSION_SECRET: SESSION_KEY,
    STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
    STRAD_TOKENS: JSON.stringify([token.record]),
  };
  const secrets = { ADMIN_KEY };
  const admin = more.prodIam
    ? fake.storeAs(WRITE_ONLY_CONSOLE_PERMISSIONS)
    : fake.store;
  const resolver = more.prodIam
    ? fake.storeAs(RESOLVER_PERMISSIONS)
    : fake.store;
  const providers = buildSecretProviders({ config, env, resolver });
  const registry = await Registry.build({
    config,
    secrets: providers,
    mode: "core",
    env,
    writeBack: createParameterWriteBack({
      config,
      env,
      secrets,
      parametersStore: () => admin,
      secretProvider: providers,
      reader: resolver,
    }),
  });
  cleanup.push(() => registry.close());
  const app = createApp({
    config,
    registry,
    tokenStore: tokenStoreFromConfig(config, env),
    mode: "core",
    env,
    secrets,
    secretProvider: providers,
    parametersStore: () => admin,
    ...(more.connectorFetch ? { connectorFetch: more.connectorFetch } : {}),
  });
  const strad: HttpServer = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        strad.closeAllConnections();
        strad.close(() => r());
      }),
  );
  const base = `http://127.0.0.1:${(strad.address() as { port: number }).port}`;

  const mcp = async (): Promise<Client> => {
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`${base}/mcp?servers=${SLUG}`),
        {
          requestInit: {
            headers: { authorization: `Bearer ${token.plaintext}` },
          },
        },
      ),
    );
    cleanup.push(() => client.close().catch(() => {}));
    return client;
  };

  return { oauth, fake, base, mcp };
}

const auth = { authorization: `Bearer ${BOOTSTRAP}` };

async function connect(
  h: Harness,
  fields: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${h.base}/ui/${SLUG}/connect`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...auth },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

/** Connect, consent at the fake, and land the callback. Returns the callback answer. */
async function roundTrip(
  h: Harness,
  fields: Record<string, string> = {},
): Promise<{
  begin: Response;
  authorizeUrl: URL;
  callback: Response;
}> {
  const begin = await connect(h, fields);
  expect(begin.status).toBe(302);
  const cookie = begin.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${CONNECTOR_TX_COOKIE}=`))!
    .split(";")[0]!;
  const authorizeUrl = new URL(begin.headers.get("location")!);

  // The human at the consent screen: the fake answers at once with a redirect
  // to strad's registered callback.
  const consent = await fetch(authorizeUrl, { redirect: "manual" });
  expect(consent.status).toBe(302);
  const back = new URL(consent.headers.get("location")!);
  expect(`${back.origin}${back.pathname}`).toBe(
    "https://strad.example/ui/oauth/callback",
  );

  const callback = await fetch(`${h.base}/ui/oauth/callback${back.search}`, {
    headers: { ...auth, cookie },
    redirect: "manual",
  });
  return { begin, authorizeUrl, callback };
}

const listed = async (fake: FakeGcp, ns: string) =>
  (await fake.store.list(ns)).map((p) => p.variable).sort();

async function whoami(client: Client): Promise<string> {
  const res = await client.callTool({ name: `${SLUG}__whoami` });
  return (res.content as { text: string }[])[0]!.text;
}

// ---------------------------------------------------------------------------

describe("Connect on an unseeded remote-http slug", () => {
  it("discovers, registers, consents, stores — and the next /mcp call is served, with no redeploy", async () => {
    const h = await harness({ rotate: true });

    // BEFORE: the slug is configured, entitled, routed, and inactive.
    const before = await h.mcp();
    await expect(whoami(before)).rejects.toThrow(/not configured yet/);

    // The page offers the button, and names what it will write where.
    const page = await (
      await fetch(`${h.base}/ui/${SLUG}`, { headers: auth })
    ).text();
    expect(page).toContain("Not connected");
    expect(page).toContain("Connect 127.0.0.1");
    expect(page).toContain(OAUTH_NS);
    expect(page).toContain("${RIPPLING_REFRESH_TOKEN}");

    const { authorizeUrl, callback } = await roundTrip(h);

    // The consent URL: discovered endpoint, a client strad registered, PKCE,
    // the resource, and the advertised scope plus offline_access.
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
      `${h.oauth.base}/authorize`,
    );
    expect(h.oauth.registrations).toHaveLength(1);
    expect(h.oauth.registrations[0]).toMatchObject({
      redirect_uris: ["https://strad.example/ui/oauth/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      client_name: "strad (test) rippling",
    });
    const q = authorizeUrl.searchParams;
    expect(q.get("client_id")).toBe("client-1");
    expect(q.get("resource")).toBe(h.oauth.mcpUrl("tadas"));
    expect(q.get("scope")).toBe("mcp:read offline_access");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.toString()).not.toContain("code_verifier");

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);

    // The exchange carried the verifier, the public client and the resource.
    const exchange = h.oauth.tokenRequests.find(
      (r) => r.grantType === "authorization_code",
    )!;
    expect(exchange).toMatchObject({
      clientId: "client-1",
      clientSecret: undefined,
      authorization: undefined,
      resource: h.oauth.mcpUrl("tadas"),
      redirectUri: "https://strad.example/ui/oauth/callback",
    });

    // WHAT WAS STORED: all four names, under the slug's own oauth/ kind; the
    // refresh token as a secret, and nowhere in a Parameter Manager payload.
    expect(await listed(h.fake, OAUTH_NS)).toEqual([
      "RIPPLING_CLIENT_ID",
      "RIPPLING_REFRESH_TOKEN",
      "RIPPLING_RESOURCE",
      "RIPPLING_TOKEN_URL",
    ]);
    expect(await listed(h.fake, STATIC_NS)).toEqual([]);
    expect(await h.fake.store.reveal(`${OAUTH_NS}RIPPLING_TOKEN_URL`)).toBe(
      h.oauth.tokenUrl,
    );
    expect(await h.fake.store.reveal(`${OAUTH_NS}RIPPLING_CLIENT_ID`)).toBe(
      "client-1",
    );
    const stored = await h.fake.store.reveal(
      `${OAUTH_NS}RIPPLING_REFRESH_TOKEN`,
    );
    expect(stored).toMatch(/^rt-tadas-code-/);
    expect(JSON.stringify([...h.fake.parameters.values()])).not.toContain(
      stored,
    );

    // AFTER: the same running gateway serves the slug, as the account that
    // consented. Nothing was redeployed, and the resolver TTL is a day.
    const after = await h.mcp();
    expect(await whoami(after)).toBe("tadas");

    // The refresh that minted it spent the stored token (the fake rotates on
    // use) and the rotation was written back to the oauth/ path the resolver
    // reads first — not to static/, which holds nothing.
    const refresh = h.oauth.tokenRequests.find(
      (r) => r.grantType === "refresh_token",
    )!;
    expect(refresh).toMatchObject({
      refreshToken: stored,
      clientId: "client-1",
      resource: h.oauth.mcpUrl("tadas"),
    });
    await vi.waitFor(async () => {
      const now = await h.fake.store.reveal(
        `${OAUTH_NS}RIPPLING_REFRESH_TOKEN`,
      );
      expect(now).not.toBe(stored);
      expect(h.oauth.liveRefreshTokens()).toContain(now);
    });

    // The page now says connected, and never shows the token.
    const connected = await (
      await fetch(`${h.base}/ui/${SLUG}?connected=1`, { headers: auth })
    ).text();
    expect(connected).toContain("A refresh token is stored");
    expect(connected).toContain("Reconnect 127.0.0.1");
    expect(connected).toContain("a client strad registered");
    expect(connected).not.toContain(stored);
    expect(connected).not.toContain("rt-tadas");
  });

  it("with prod's IAM split, the first rotation after Connect is written back (strad#398)", async () => {
    // The console credential cannot read the refresh token it just stored —
    // `oauth/` is never granted to it — so the write-back's "is this still
    // ours" read has to go through the resolver, the identity the minter's own
    // value came from. Reading it through the console 403'd, and every first
    // rotation after a Connect was refused and held in memory only.
    const h = await harness({ rotate: true }, undefined, { prodIam: true });
    const { callback } = await roundTrip(h);
    expect(callback.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);
    const stored = await h.fake.store.reveal(
      `${OAUTH_NS}RIPPLING_REFRESH_TOKEN`,
    );

    const client = await h.mcp();
    expect(await whoami(client)).toBe("tadas");

    await vi.waitFor(async () => {
      const now = await h.fake.store.reveal(
        `${OAUTH_NS}RIPPLING_REFRESH_TOKEN`,
      );
      expect(now).not.toBe(stored);
      expect(h.oauth.liveRefreshTokens()).toContain(now);
    });
  });

  it("Reconnect rotates every stored value in place", async () => {
    const h = await harness();
    await roundTrip(h);
    const first = await h.fake.store.reveal(
      `${OAUTH_NS}RIPPLING_REFRESH_TOKEN`,
    );

    const { callback } = await roundTrip(h);
    expect(callback.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);
    expect(h.oauth.registrations).toHaveLength(2);
    expect(await h.fake.store.reveal(`${OAUTH_NS}RIPPLING_CLIENT_ID`)).toBe(
      "client-2",
    );
    const second = await h.fake.store.reveal(
      `${OAUTH_NS}RIPPLING_REFRESH_TOKEN`,
    );
    expect(second).not.toBe(first);

    // The new refresh token is bound to the new client, and the gateway uses
    // the pair together.
    expect(await whoami(await h.mcp())).toBe("tadas");
  });
});

describe("refusals before anything is registered or written", () => {
  it("a firewall 403 on the metadata is said plainly, and nothing is registered, sealed or written", async () => {
    const h = await harness({ mcpAuth: { prmStatus: 403 } });
    const res = await connect(h);
    expect(res.status).toBe(409);
    expect(
      res.headers
        .getSetCookie()
        .some((c) => c.startsWith(`${CONNECTOR_TX_COOKIE}=`)),
    ).toBe(false);
    const html = await res.text();
    expect(html).toContain(
      `${h.oauth.base}/.well-known/oauth-protected-resource/mcp/tadas answered HTTP 403`,
    );
    expect(html).toContain("web application firewall");
    // The upstream's body is not quoted.
    expect(html).not.toContain("blocked</html>");
    expect(h.oauth.registrations).toHaveLength(0);
    expect(await listed(h.fake, OAUTH_NS)).toEqual([]);
    // The way forward is on the page, opened, linking the refused document.
    expect(html).toContain("<details open>");
    expect(html).toContain('name="resource_metadata"');
    expect(html).toContain(
      `href="${h.oauth.base}/.well-known/oauth-protected-resource/mcp/tadas"`,
    );
  });

  it("a firewall in front of the token endpoint refuses before anyone signs in, pasted metadata or not", async () => {
    const h = await harness({
      mcpAuth: { scopes: ["mcp:read"], tokenBlocked: true },
    });
    const res = await connect(h);
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain(
      `The token endpoint ${h.oauth.base}/token answered HTTP 403`,
    );
    expect(html).toContain("Pasting metadata does not get around this");
    expect(h.oauth.registrations).toHaveLength(0);
    expect(h.oauth.authorizations).toHaveLength(0);
    expect(await listed(h.fake, OAUTH_NS)).toEqual([]);
  });

  it("no registration endpoint and no seeded client id: says what to register and where to seed it", async () => {
    const h = await harness({
      mcpAuth: { registration: false, scopes: ["mcp:read"] },
    });
    const res = await connect(h);
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain("offers no dynamic client registration");
    expect(html).toContain("https://strad.example/ui/oauth/callback");
    expect(html).toContain(STATIC_NS);

    // Seeded by hand, the same Connect uses it — and does not register.
    await h.fake.store.create({
      path: `${STATIC_NS}RIPPLING_CLIENT_ID`,
      secret: false,
      value: "hand-registered-client",
    });
    const { authorizeUrl, callback } = await roundTrip(h);
    expect(authorizeUrl.searchParams.get("client_id")).toBe(
      "hand-registered-client",
    );
    expect(callback.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);
    // The client id was not strad's to write, so it stays where it was seeded.
    expect(await listed(h.fake, OAUTH_NS)).toEqual([
      "RIPPLING_REFRESH_TOKEN",
      "RIPPLING_RESOURCE",
      "RIPPLING_TOKEN_URL",
    ]);
    expect(await whoami(await h.mcp())).toBe("tadas");
  });

  it("refuses a registration that comes back confidential", async () => {
    const h = await harness({
      mcpAuth: { confidential: true, scopes: ["mcp:read"] },
    });
    const res = await connect(h);
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain("issued a confidential client");
    expect(html).not.toContain("dcr-SECRET-CANARY");
    expect(await listed(h.fake, OAUTH_NS)).toEqual([]);
  });

  it("refuses a literal tokenUrl that is not the discovered one", async () => {
    const h = await harness(
      {},
      `
      tokenUrl: https://elsewhere.example/token
      clientId: "\${RIPPLING_CLIENT_ID}"
      refreshToken: "\${RIPPLING_REFRESH_TOKEN}"
    mayBeUnseeded: [RIPPLING_CLIENT_ID, RIPPLING_REFRESH_TOKEN]`,
    );
    const res = await connect(h);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(
      "but the upstream&#39;s authorization server advertises",
    );
    expect(h.oauth.registrations).toHaveLength(0);
  });

  it("a callback whose transaction was sealed for this flow cannot be replayed by another session", async () => {
    const h = await harness();
    const begin = await connect(h);
    const cookie = begin.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${CONNECTOR_TX_COOKIE}=`))!
      .split(";")[0]!;
    const consent = await fetch(begin.headers.get("location")!, {
      redirect: "manual",
    });
    const back = new URL(consent.headers.get("location")!);
    // A wrong state: the shared callback checks run before this flow's.
    back.searchParams.set("state", "forged");
    const res = await fetch(`${h.base}/ui/oauth/callback${back.search}`, {
      headers: { ...auth, cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(400);
    expect(await listed(h.fake, OAUTH_NS)).toEqual([]);
  });
});

/** Connect and consent, then land the callback on `on` (default: the same app). */
async function consentTo(
  h: Harness,
  on: Harness = h,
): Promise<{ callback: Response; begin: Response }> {
  const begin = await connect(h);
  expect(begin.status).toBe(302);
  const cookie = begin.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${CONNECTOR_TX_COOKIE}=`))!
    .split(";")[0]!;
  const consent = await fetch(begin.headers.get("location")!, {
    redirect: "manual",
  });
  const back = new URL(consent.headers.get("location")!);
  const callback = await fetch(`${on.base}/ui/oauth/callback${back.search}`, {
    headers: { ...auth, cookie },
    redirect: "manual",
  });
  return { callback, begin };
}

describe("the callback's own refusals", () => {
  it("refuses a transaction whose upstream config changed mid-flow, and writes nothing", async () => {
    const before = await harness();
    // The same deployment after a deploy that re-pointed the upstream: same
    // session key, same env, same store shape — different oauthRefresh terms.
    const after = await harness();
    const { callback } = await consentTo(before, after);
    expect(callback.status).toBe(409);
    expect(await callback.text()).toContain("configuration changed mid-flow");
    expect(await listed(after.fake, OAUTH_NS)).toEqual([]);
    expect(await listed(before.fake, OAUTH_NS)).toEqual([]);
  });

  it("no refresh token in the exchange: refused, nothing written, and the page says what to try", async () => {
    const h = await harness({
      mcpAuth: { scopes: ["mcp:read"], omitRefreshToken: true },
    });
    const { callback } = await consentTo(h);
    expect(callback.headers.get("location")).toBe(
      `/ui/${SLUG}?error=no_refresh_token`,
    );
    expect(await listed(h.fake, OAUTH_NS)).toEqual([]);
    const page = await (
      await fetch(`${h.base}/ui/${SLUG}?error=no_refresh_token`, {
        headers: auth,
      })
    ).text();
    expect(page).toContain("issued no refresh token");
  });

  it("a token endpoint that drops the connection is exchange_failed, not a store failure", async () => {
    const h = await harness({
      mcpAuth: { scopes: ["mcp:read"], dropExchange: true },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { callback } = await consentTo(h);
    expect(callback.headers.get("location")).toBe(
      `/ui/${SLUG}?error=exchange_failed`,
    );
    expect(await listed(h.fake, OAUTH_NS)).toEqual([]);
  });
});

describe("configured clients", () => {
  it("a literal clientId with a seeded secret: no registration, Basic auth, the secret read from the store", async () => {
    const h = await harness(
      {},
      `
      tokenUrl: "\${RIPPLING_TOKEN_URL}"
      clientId: hand-registered
      clientSecret: "\${RIPPLING_CLIENT_SECRET}"
      refreshToken: "\${RIPPLING_REFRESH_TOKEN}"
      resource: https://override.example/resource
    mayBeUnseeded: [RIPPLING_TOKEN_URL, RIPPLING_CLIENT_SECRET, RIPPLING_REFRESH_TOKEN]`,
    );
    await h.fake.store.create({
      path: `${STATIC_NS}RIPPLING_CLIENT_SECRET`,
      secret: true,
      value: "configured-SECRET-CANARY",
    });
    const { begin, callback } = await consentTo(h);
    const q = new URL(begin.headers.get("location")!).searchParams;
    expect(q.get("client_id")).toBe("hand-registered");
    // A literal resource is the config's word, on the consent as on every refresh.
    expect(q.get("resource")).toBe("https://override.example/resource");
    expect(h.oauth.registrations).toHaveLength(0);
    expect(callback.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);

    const exchange = h.oauth.tokenRequests.find(
      (r) => r.grantType === "authorization_code",
    )!;
    expect(exchange.clientSecret).toBeUndefined();
    expect(
      Buffer.from(
        exchange.authorization!.replace(/^Basic /, ""),
        "base64",
      ).toString(),
    ).toBe("hand-registered:configured-SECRET-CANARY");
    // Only the ${NAME}s were strad's to write.
    expect(await listed(h.fake, OAUTH_NS)).toEqual([
      "RIPPLING_REFRESH_TOKEN",
      "RIPPLING_TOKEN_URL",
    ]);
    // The secret never reached the cookie, the redirect or the page.
    expect(begin.headers.get("location")).not.toContain("CANARY");
    expect(begin.headers.getSetCookie().join("")).not.toContain("CANARY");
  });

  it("a registration endpoint that refuses falls back to a seeded client id", async () => {
    const h = await harness({
      mcpAuth: { scopes: ["mcp:read"], registrationStatus: 403 },
    });
    const refused = await connect(h);
    expect(refused.status).toBe(409);
    const html = await refused.text();
    expect(html).toContain("refused to register a client (HTTP 403)");
    expect(html).not.toContain("UPSTREAM-REGISTRATION-TEXT");

    await h.fake.store.create({
      path: `${STATIC_NS}RIPPLING_CLIENT_ID`,
      secret: false,
      value: "hand-registered-client",
    });
    const { begin, callback } = await consentTo(h);
    expect(
      new URL(begin.headers.get("location")!).searchParams.get("client_id"),
    ).toBe("hand-registered-client");
    expect(callback.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);
    expect(await whoami(await h.mcp())).toBe("tadas");
  });
});

// ---------------------------------------------------------------------------

describe("metadata a human pasted, for an upstream that blocks strad's egress", () => {
  const prmFor = (h: Harness) =>
    JSON.stringify({
      resource: h.oauth.mcpUrl("tadas"),
      authorization_servers: [h.oauth.base],
      scopes_supported: ["mcp:read"],
    });

  it("a pasted protected-resource document completes the Connect the 403 stopped, and /mcp is served", async () => {
    const h = await harness({
      mcpAuth: { prmStatus: 403, scopes: ["mcp:read"] },
    });
    expect((await connect(h)).status).toBe(409);

    const { authorizeUrl, callback } = await roundTrip(h, {
      resource_metadata: prmFor(h),
    });
    // Everything after the document is strad's own: it registered, sent the
    // human to the discovered endpoint with the pasted resource, and exchanged.
    expect(h.oauth.registrations).toHaveLength(1);
    expect(authorizeUrl.searchParams.get("resource")).toBe(
      h.oauth.mcpUrl("tadas"),
    );
    expect(authorizeUrl.searchParams.get("scope")).toBe(
      "mcp:read offline_access",
    );
    expect(callback.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);
    expect(await whoami(await h.mcp())).toBe("tadas");
  });

  it("an authorization server document refused too is named, and both pasted complete it", async () => {
    const h = await harness({
      mcpAuth: { prmStatus: 403, asMetaStatus: 403, scopes: ["mcp:read"] },
    });
    const first = await connect(h, { resource_metadata: prmFor(h) });
    expect(first.status).toBe(409);
    const html = await first.text();
    expect(html).toContain(
      `${h.oauth.base}/.well-known/oauth-authorization-server answered HTTP 403`,
    );
    expect(html).toContain(
      `href="${h.oauth.base}/.well-known/oauth-authorization-server"`,
    );
    // What was pasted is handed back, escaped, so it need not be pasted again.
    expect(html).toContain("&quot;authorization_servers&quot;");

    const asDoc = JSON.stringify({
      issuer: h.oauth.base,
      authorization_endpoint: `${h.oauth.base}/authorize`,
      token_endpoint: `${h.oauth.base}/token`,
      registration_endpoint: `${h.oauth.base}/register`,
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp:read", "offline_access"],
    });
    const { callback } = await roundTrip(h, {
      resource_metadata: prmFor(h),
      authorization_server_metadata: asDoc,
    });
    expect(callback.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);
    expect(await whoami(await h.mcp())).toBe("tadas");
  });

  it("a pasted document is checked like a fetched one, and junk is refused without being quoted", async () => {
    const h = await harness({ mcpAuth: { prmStatus: 403 } });
    const other = await connect(h, {
      resource_metadata: JSON.stringify({
        resource: "https://elsewhere.example/mcp",
        authorization_servers: [h.oauth.base],
      }),
    });
    expect(other.status).toBe(409);
    expect(await other.text()).toContain("will not bind a credential");

    const junk = await connect(h, { resource_metadata: "<b>not json</b>" });
    expect(junk.status).toBe(409);
    const html = await junk.text();
    expect(html).toContain("is not a JSON object");
    expect(html).not.toContain("<b>not json</b>");
    expect(html).toContain("&lt;b&gt;not json&lt;/b&gt;");

    // A paste that tries to close the textarea is handed back inert.
    const hostile = await connect(h, {
      resource_metadata: "</textarea><script>alert(1)</script>",
    });
    const back = await hostile.text();
    expect(back).not.toContain("<script>alert(1)</script>");
    expect(back).toContain("&lt;/textarea&gt;&lt;script&gt;");
    expect(h.oauth.registrations).toHaveLength(0);
    expect(await listed(h.fake, OAUTH_NS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("discoveryProxy: the metadata a firewall refuses strad, read through BrightData", () => {
  const PROXY_REFRESH = `
      tokenUrl: "\${RIPPLING_TOKEN_URL}"
      clientId: "\${RIPPLING_CLIENT_ID}"
      refreshToken: "\${RIPPLING_REFRESH_TOKEN}"
      resource: "\${RIPPLING_RESOURCE}"
      discoveryProxy:
        via: brightdata
        apiKeyFrom: strad-fetch
    mayBeUnseeded:
      [RIPPLING_TOKEN_URL, RIPPLING_CLIENT_ID, RIPPLING_REFRESH_TOKEN, RIPPLING_RESOURCE]`;
  const STRAD_FETCH = `
  - slug: strad-fetch
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`;
  const KEY_PATH = "/strad/test/mcp/strad-fetch/static/BRIGHTDATA_API_KEY";

  /**
   * strad's egress, with BrightData's request API stood in for: a POST there
   * is answered by fetching the target from "an address the firewall lets
   * through" and wrapping the answer in the Web Unlocker's JSON envelope.
   */
  function withFakeBrightData() {
    const proxied: { url: string; zone: string; authorization: string }[] = [];
    const f = (async (input: unknown, init?: RequestInit) => {
      if (String(input) !== "https://api.brightdata.com/request") {
        return fetch(input as string, init);
      }
      const body = JSON.parse(String(init?.body)) as {
        url: string;
        zone: string;
        format: string;
      };
      expect(body.format).toBe("json");
      proxied.push({
        url: body.url,
        zone: body.zone,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
      });
      const target = await fetch(body.url, {
        headers: { "x-unblocked": "1" },
      });
      return Response.json({
        status_code: target.status,
        headers: {},
        body: await target.text(),
      });
    }) as typeof fetch;
    return { f, proxied };
  }

  it("click Connect, sign in, done: only the refused document goes through the proxy, with strad-fetch's key", async () => {
    const bd = withFakeBrightData();
    const h = await harness(
      { mcpAuth: { prmStatus: 403, scopes: ["mcp:read"] } },
      PROXY_REFRESH,
      { servers: STRAD_FETCH, connectorFetch: bd.f },
    );
    await h.fake.store.create({
      path: KEY_PATH,
      secret: true,
      value: "bd-KEY-CANARY",
    });
    const page = await (
      await fetch(`${h.base}/ui/${SLUG}`, { headers: auth })
    ).text();
    expect(page).toContain("read again through BrightData");

    const { begin, callback } = await roundTrip(h);
    expect(callback.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);
    expect(await whoami(await h.mcp())).toBe("tadas");

    // ONE document went through it: the protected-resource metadata that
    // answered 403. The authorization server's answered strad directly, and
    // the probe, the registration and the exchange never touch the proxy.
    expect(bd.proxied).toEqual([
      {
        url: `${h.oauth.base}/.well-known/oauth-protected-resource/mcp/tadas`,
        zone: "mcp_server_unlocker",
        authorization: "Bearer bd-KEY-CANARY",
      },
    ]);
    expect(h.oauth.registrations).toHaveLength(1);
    // The key reached nothing but the proxy's Authorization header.
    expect(begin.headers.get("location")).not.toContain("CANARY");
    expect(begin.headers.getSetCookie().join("")).not.toContain("CANARY");
  });

  it("an upstream that serves strad sends nothing to the proxy, and its key is never read", async () => {
    const bd = withFakeBrightData();
    const h = await harness({}, PROXY_REFRESH, {
      servers: STRAD_FETCH,
      connectorFetch: bd.f,
    });
    const { callback } = await roundTrip(h);
    expect(callback.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);
    expect(bd.proxied).toEqual([]);
  });

  it("no key seeded where apiKeyFrom points: says where to seed it, and nothing is registered", async () => {
    const bd = withFakeBrightData();
    const h = await harness({ mcpAuth: { prmStatus: 403 } }, PROXY_REFRESH, {
      servers: STRAD_FETCH,
      connectorFetch: bd.f,
    });
    const res = await connect(h);
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain(
      "Seed BRIGHTDATA_API_KEY under /strad/test/mcp/strad-fetch/static/",
    );
    expect(bd.proxied).toEqual([]);
    expect(h.oauth.registrations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

/**
 * `oauthRefresh.registration:` — Figma's client allowlist, against a fake that
 * enforces what Figma's registration endpoint was observed to enforce: a 403
 * unless `client_name` starts with "Claude Code", a `client_secret` issued to
 * every client whatever method it asked for, and a token endpoint that refuses
 * a grant without that secret.
 */
describe("registration: — an upstream that registers only clients it recognises", () => {
  const FIGMA_LIKE = {
    mcpAuth: {
      scopes: ["mcp:connect"],
      clientNamePrefix: "Claude Code",
      issueSecret: true,
    },
  };
  const WITH_REGISTRATION = `
      tokenUrl: "\${RIPPLING_TOKEN_URL}"
      clientId: "\${RIPPLING_CLIENT_ID}"
      clientSecret: "\${RIPPLING_CLIENT_SECRET}"
      clientAuth: post
      refreshToken: "\${RIPPLING_REFRESH_TOKEN}"
      resource: "\${RIPPLING_RESOURCE}"
      registration:
        clientName: Claude Code (strad)
    mayBeUnseeded:
      [RIPPLING_TOKEN_URL, RIPPLING_CLIENT_ID, RIPPLING_CLIENT_SECRET, RIPPLING_REFRESH_TOKEN, RIPPLING_RESOURCE]`;

  it("without it, strad registers under its own name and the allowlist refuses it", async () => {
    const h = await harness(FIGMA_LIKE);
    const res = await connect(h);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("refused to register a client");
    expect(h.oauth.registrations).toHaveLength(1);
    expect(h.oauth.registrations[0]).toMatchObject({
      client_name: "strad (test) rippling",
      token_endpoint_auth_method: "none",
    });
    expect(await listed(h.fake, OAUTH_NS)).toEqual([]);
  });

  it("without it, a declared clientSecret still means a seeded client: nothing is registered", async () => {
    const h = await harness(
      FIGMA_LIKE,
      `
      tokenUrl: "\${RIPPLING_TOKEN_URL}"
      clientId: "\${RIPPLING_CLIENT_ID}"
      clientSecret: "\${RIPPLING_CLIENT_SECRET}"
      clientAuth: post
      refreshToken: "\${RIPPLING_REFRESH_TOKEN}"
    mayBeUnseeded:
      [RIPPLING_TOKEN_URL, RIPPLING_CLIENT_ID, RIPPLING_CLIENT_SECRET, RIPPLING_REFRESH_TOKEN]`,
    );
    const res = await connect(h);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("cannot register a client for it");
    expect(h.oauth.registrations).toHaveLength(0);
  });

  it("with it, Connect registers as the named client, keeps the issued secret encrypted, and /mcp is served", async () => {
    const h = await harness(FIGMA_LIKE, WITH_REGISTRATION);

    const page = await (
      await fetch(`${h.base}/ui/${SLUG}`, { headers: auth })
    ).text();
    expect(page).toContain("Claude Code (strad)");
    expect(page).toContain("a confidential client strad registers");

    const { begin, authorizeUrl, callback } = await roundTrip(h);
    expect(h.oauth.registrations).toHaveLength(1);
    expect(h.oauth.registrations[0]).toMatchObject({
      client_name: "Claude Code (strad)",
      token_endpoint_auth_method: "client_secret_post",
      redirect_uris: ["https://strad.example/ui/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      scope: "mcp:connect offline_access",
    });
    expect(authorizeUrl.searchParams.get("client_id")).toBe("client-1");

    // The issued secret crossed the browser only encrypted: not in the
    // signed transaction cookie, not in the redirect.
    expect(begin.headers.getSetCookie().join("")).not.toContain(
      "dcr-issued-SECRET",
    );
    const cookie = decodeURIComponent(
      begin.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${CONNECTOR_TX_COOKIE}=`))!,
    );
    const body = cookie.split("=")[1]!.split(".")[0]!;
    expect(Buffer.from(body, "base64url").toString()).not.toContain(
      "dcr-issued-SECRET",
    );
    expect(begin.headers.get("location")).not.toContain("SECRET");

    expect(callback.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);
    const exchange = h.oauth.tokenRequests.find(
      (r) => r.grantType === "authorization_code",
    )!;
    expect(exchange).toMatchObject({
      clientId: "client-1",
      clientSecret: "dcr-issued-SECRET-1",
      authorization: undefined,
    });

    // The secret is written beside the id, as a SECRET parameter.
    expect(await listed(h.fake, OAUTH_NS)).toEqual([
      "RIPPLING_CLIENT_ID",
      "RIPPLING_CLIENT_SECRET",
      "RIPPLING_REFRESH_TOKEN",
      "RIPPLING_RESOURCE",
      "RIPPLING_TOKEN_URL",
    ]);
    expect(await h.fake.store.reveal(`${OAUTH_NS}RIPPLING_CLIENT_SECRET`)).toBe(
      "dcr-issued-SECRET-1",
    );
    expect(JSON.stringify([...h.fake.parameters.values()])).not.toContain(
      "dcr-issued-SECRET-1",
    );

    // The refresh that mints the bearer presents the secret — the fake, like
    // Figma, refuses one that does not — and the slug serves.
    expect(await whoami(await h.mcp())).toBe("tadas");
    const refresh = h.oauth.tokenRequests.find(
      (r) => r.grantType === "refresh_token",
    )!;
    expect(refresh).toMatchObject({
      clientId: "client-1",
      clientSecret: "dcr-issued-SECRET-1",
    });

    const connected = await (
      await fetch(`${h.base}/ui/${SLUG}`, { headers: auth })
    ).text();
    expect(connected).toContain("a confidential client strad registered");
    expect(connected).not.toContain("dcr-issued-SECRET");
  });

  it("Reconnect registers a fresh client and rotates its secret in place", async () => {
    const h = await harness(FIGMA_LIKE, WITH_REGISTRATION);
    await roundTrip(h);
    const { callback } = await roundTrip(h);
    expect(callback.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);
    expect(h.oauth.registrations).toHaveLength(2);
    expect(await h.fake.store.reveal(`${OAUTH_NS}RIPPLING_CLIENT_ID`)).toBe(
      "client-2",
    );
    expect(await h.fake.store.reveal(`${OAUTH_NS}RIPPLING_CLIENT_SECRET`)).toBe(
      "dcr-issued-SECRET-2",
    );
    expect(await whoami(await h.mcp())).toBe("tadas");
  });

  it("a refused registration falls back to a seeded client only when its secret is seeded too", async () => {
    const h = await harness(
      { mcpAuth: { scopes: ["mcp:read"], registrationStatus: 403 } },
      WITH_REGISTRATION,
    );
    await h.fake.store.create({
      path: `${STATIC_NS}RIPPLING_CLIENT_ID`,
      secret: false,
      value: "hand-registered-client",
    });
    // The id alone: refused before anyone is sent to sign in.
    const refused = await connect(h);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain(
      "is seeded but ${RIPPLING_CLIENT_SECRET} is not",
    );
    expect(h.oauth.authorizations).toHaveLength(0);

    await h.fake.store.create({
      path: `${STATIC_NS}RIPPLING_CLIENT_SECRET`,
      secret: true,
      value: "seeded-SECRET",
    });
    const { callback } = await roundTrip(h);
    expect(callback.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);
    const exchange = h.oauth.tokenRequests.find(
      (r) => r.grantType === "authorization_code",
    )!;
    expect(exchange).toMatchObject({
      clientId: "hand-registered-client",
      clientSecret: "seeded-SECRET",
    });
    // Neither was strad's to write: both stay where they were seeded.
    expect(await listed(h.fake, OAUTH_NS)).toEqual([
      "RIPPLING_REFRESH_TOKEN",
      "RIPPLING_RESOURCE",
      "RIPPLING_TOKEN_URL",
    ]);
  });

  it("a name alone, with no clientSecret, registers a public client under that name", async () => {
    const h = await harness(
      { mcpAuth: { scopes: ["mcp:read"], clientNamePrefix: "Claude Code" } },
      `
      tokenUrl: "\${RIPPLING_TOKEN_URL}"
      clientId: "\${RIPPLING_CLIENT_ID}"
      refreshToken: "\${RIPPLING_REFRESH_TOKEN}"
      resource: "\${RIPPLING_RESOURCE}"
      registration:
        clientName: Claude Code (strad)
    mayBeUnseeded:
      [RIPPLING_TOKEN_URL, RIPPLING_CLIENT_ID, RIPPLING_REFRESH_TOKEN, RIPPLING_RESOURCE]`,
    );
    const { callback } = await roundTrip(h);
    expect(callback.headers.get("location")).toBe(`/ui/${SLUG}?connected=1`);
    expect(h.oauth.registrations[0]).toMatchObject({
      client_name: "Claude Code (strad)",
      token_endpoint_auth_method: "none",
    });
    expect(await whoami(await h.mcp())).toBe("tadas");
  });
});
