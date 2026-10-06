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
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
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
`);

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
  const providers = buildSecretProviders({ config, env, resolver: fake.store });
  const registry = await Registry.build({
    config,
    secrets: providers,
    mode: "core",
    env,
    writeBack: createParameterWriteBack({
      config,
      env,
      secrets,
      parametersStore: () => fake.store,
      secretProvider: providers,
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
    parametersStore: () => fake.store,
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

async function connect(h: Harness): Promise<Response> {
  return fetch(`${h.base}/ui/${SLUG}/connect`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...auth },
    body: "",
    redirect: "manual",
  });
}

/** Connect, consent at the fake, and land the callback. Returns the callback answer. */
async function roundTrip(h: Harness): Promise<{
  begin: Response;
  authorizeUrl: URL;
  callback: Response;
}> {
  const begin = await connect(h);
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
