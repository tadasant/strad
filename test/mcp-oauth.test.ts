import { createHash, randomBytes } from "node:crypto";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticateMcp, Unauthenticated } from "../src/auth/index.ts";
import {
  clientFingerprint,
  readClient,
  redirectUriProblem,
  registerClient,
  resolveRedirectUri,
} from "../src/auth/mcp-oauth/clients.ts";
import {
  mintAccessToken,
  readAccessToken,
  SpentCodes,
  verifierMatches,
} from "../src/auth/mcp-oauth/grants.ts";
import {
  enforceDomain,
  HostedDomainRefused,
} from "../src/auth/mcp-oauth/google.ts";
import {
  resolveMcpOAuth,
  verifyAccessToken,
} from "../src/auth/mcp-oauth/index.ts";
import {
  canonicalResource,
  normalizeResource,
} from "../src/auth/mcp-oauth/metadata.ts";
import { Cipher, mcpOAuthKeysFromEnv } from "../src/auth/mcp-oauth/keys.ts";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { StradConfig } from "../src/config/schema.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import {
  fakeGoogleGrant,
  type FakeGoogleGrant,
} from "./helpers/fake-google-grant.ts";

/**
 * What strad's authorization server REFUSES, which is most of what it does.
 *
 * The happy path is in `mcp-oauth.e2e.test.ts`; everything here is a way the
 * flow must not go. They fall into four groups, and each group has a defect it
 * is guarding against:
 *
 *   - **The domain gate.** The one constraint Tadas stated. It has to hold on
 *     the authorization AND on every refresh, and a wrong-domain human has to
 *     get words rather than an error code.
 *   - **PKCE.** Missing, `plain`, and a verifier that does not match. Each of
 *     them is the interception attack the mechanism exists for.
 *   - **Replay and binding.** A code spent twice, a code redeemed by another
 *     client, a refresh token presented as an access token.
 *   - **The static door.** It is load-bearing for every machine client and this
 *     change must not reshape it.
 */

const YAML = `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  mcpOAuth:
    enabled: true
    hostedDomain: tadasant.com
    roles: [admin]
roles:
  admin: { servers: ["*"] }
servers:
  - slug: granola
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`;

const CONFIG = parseConfig(YAML);
const KEY = "an-oauth-signing-key-of-sufficient-length";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

let server: Server;
let base: string;
let google: FakeGoogleGrant;
let staticToken: string;

beforeAll(async () => {
  const minted = mintToken({ env: "test", label: "zimmer", roles: ["admin"] });
  staticToken = minted.plaintext;
  const env = {
    NODE_ENV: "test",
    STRAD_OAUTH_KEY: KEY,
    STRAD_TOKENS: JSON.stringify([minted.record]),
  } as NodeJS.ProcessEnv;

  google = fakeGoogleGrant("tadasant.com");
  const registry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    mcpOAuthGoogle: google,
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// --- driving helpers ---------------------------------------------------------

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url"),
  };
}

async function newClient(uris = [CLAUDE_CALLBACK]): Promise<string> {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: uris }),
  });
  return ((await res.json()) as { client_id: string }).client_id;
}

async function authorize(params: Record<string, string>): Promise<Response> {
  const url = new URL(`${base}/oauth/authorize`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url, { redirect: "manual" });
}

async function signIn(
  clientId: string,
  challenge: string,
): Promise<{ consent: Response; cookie: string }> {
  const started = await authorize({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
  });
  const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const callback = new URL(`${base}/oauth/callback/google`);
  callback.searchParams.set("code", "google-code");
  callback.searchParams.set("state", google.lastState);
  return { consent: await fetch(callback, { headers: { cookie } }), cookie };
}

async function grant(): Promise<{
  clientId: string;
  verifier: string;
  code: string;
}> {
  const clientId = await newClient();
  const { verifier, challenge } = pkce();
  const { consent } = await signIn(clientId, challenge);
  const approval = /name="approval" value="([^"]+)"/.exec(
    await consent.text(),
  )?.[1];
  const approved = await fetch(`${base}/oauth/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ approval: approval ?? "", decision: "allow" }),
    redirect: "manual",
  });
  const landed = new URL(approved.headers.get("location") ?? "");
  return { clientId, verifier, code: landed.searchParams.get("code") ?? "" };
}

/** The token endpoint's answer, in the two shapes it takes. */
interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  error?: string;
  error_description?: string;
}

async function token(
  body: Record<string, string>,
): Promise<{ status: number; json: TokenResponse }> {
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return { status: res.status, json: (await res.json()) as TokenResponse };
}

async function tokens(): Promise<TokenResponse & { client_id: string }> {
  const g = await grant();
  const { json } = await token({
    grant_type: "authorization_code",
    code: g.code,
    client_id: g.clientId,
    code_verifier: g.verifier,
  });
  return { ...json, client_id: g.clientId };
}

/**
 * A request carrying a `Host` of our choosing.
 *
 * `fetch` refuses to send one — it is a forbidden header — and `Host` is
 * exactly what the origin is derived from (`requestOrigin` in
 * `src/auth/protected-resource.ts` reads `req.get("host")`, not the forwarded
 * one). Same shape as `test/protected-resource.test.ts`.
 */
function withHost(
  path: string,
  method: string,
  host: string,
  body?: string,
): Promise<{ status: number; location?: string; body: string }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          host,
          ...(body
            ? {
                "content-type": "application/x-www-form-urlencoded",
                "content-length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            body: text,
          }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function mcp(
  bearer: string,
  query = "?servers=granola",
): Promise<number> {
  const res = await fetch(`${base}/mcp${query}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return res.status;
}

// ---------------------------------------------------------------------------

describe("the tadasant.com constraint", () => {
  it("refuses a non-member in words, on a page, without redirecting", async () => {
    const clientId = await newClient();
    const { challenge } = pkce();
    google.account = {
      sub: "outsider",
      email: "someone@gmail.com",
      hd: "gmail.com",
    };
    try {
      const { consent } = await signIn(clientId, challenge);
      // 403 and an HTML page. NOT a 302 carrying `error=access_denied`: the
      // client would render that as "connection failed" and the human would
      // never learn which account to use.
      expect(consent.status).toBe(403);
      expect(consent.headers.get("content-type")).toContain("text/html");
      const html = await consent.text();
      expect(html).toContain("restricted to tadasant.com accounts");
      expect(html).toContain("someone@gmail.com");
      expect(html).toContain("No token has been issued");
    } finally {
      google.account = {
        sub: "google-sub-1",
        email: "tadas@tadasant.com",
        hd: "tadasant.com",
      };
    }
  });

  it("refuses to be framed, on the page with the Approve button on it", async () => {
    const clientId = await newClient();
    const { challenge } = pkce();
    const { consent } = await signIn(clientId, challenge);
    expect(consent.status).toBe(200);
    // An "Approve" button an attacker can frame invisibly is a grant nobody
    // meant to give. Both headers, because one of them is what an older
    // browser reads.
    expect(consent.headers.get("x-frame-options")).toBe("DENY");
    expect(consent.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(consent.headers.get("cache-control")).toBe("no-store");
  });

  it("checks the `hd` claim and the email suffix, not one or the other", () => {
    // The attack the console's comment names: a personal account whose profile
    // email is spelled like a member's. `hd` is absent on it, so it fails.
    expect(() =>
      enforceDomain(undefined, "tadas@tadasant.com", "tadasant.com"),
    ).toThrow(HostedDomainRefused);
    // And the mirror image, which cannot happen at Google but is refused
    // rather than reconciled: an `hd` that does not match the address.
    expect(() =>
      enforceDomain("tadasant.com", "tadas@elsewhere.example", "tadasant.com"),
    ).toThrow(HostedDomainRefused);
    expect(() =>
      enforceDomain("tadasant.com", "tadas@tadasant.com", "tadasant.com"),
    ).not.toThrow();
  });

  it("re-checks it on refresh, against Google rather than against the token", async () => {
    const issued = await tokens();
    // The account leaves the Workspace. Nothing about strad's refresh token
    // changes — its sealed `hd` still says tadasant.com — so a server that
    // read its own copy would keep refreshing forever.
    google.moveOutOfWorkspace(google.lastRefreshToken);
    const refused = await token({
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      client_id: issued.client_id,
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe("invalid_grant");
    expect(refused.json.error_description).toContain("no longer a member");
  });
});

describe("PKCE is mandatory and S256 only", () => {
  it("refuses an authorization with no code_challenge", async () => {
    const clientId = await newClient();
    const res = await authorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      state: "s",
    });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location") ?? "");
    expect(back.origin + back.pathname).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("error_description")).toContain("PKCE");
    expect(back.searchParams.get("state")).toBe("s");
  });

  it("refuses `plain`, and refuses an absent method rather than assuming it", async () => {
    const clientId = await newClient();
    const { challenge } = pkce();
    const methods: Record<string, string>[] = [
      { code_challenge_method: "plain" },
      {},
    ];
    for (const method of methods) {
      const res = await authorize({
        response_type: "code",
        client_id: clientId,
        redirect_uri: CLAUDE_CALLBACK,
        code_challenge: challenge,
        ...method,
      });
      const back = new URL(res.headers.get("location") ?? "");
      expect(back.searchParams.get("error")).toBe("invalid_request");
      expect(back.searchParams.get("error_description")).toContain("S256");
    }
  });

  it("refuses a code redeemed with the wrong verifier", async () => {
    const g = await grant();
    const wrong = await token({
      grant_type: "authorization_code",
      code: g.code,
      client_id: g.clientId,
      code_verifier: pkce().verifier,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe("invalid_grant");
    expect(wrong.json.error_description).toContain("code_verifier");
  });

  it("only accepts a verifier of the RFC 7636 shape", () => {
    const { verifier, challenge } = pkce();
    expect(verifierMatches(verifier, challenge)).toBe(true);
    // 42 characters: one short of the floor, and a shape check that let it
    // through would let a low-entropy verifier through with it.
    expect(verifierMatches("a".repeat(42), challenge)).toBe(false);
    expect(verifierMatches(`${verifier}+`, challenge)).toBe(false);
  });
});

describe("replay and binding", () => {
  it("refuses a code the second time it is presented", async () => {
    const g = await grant();
    const first = await token({
      grant_type: "authorization_code",
      code: g.code,
      client_id: g.clientId,
      code_verifier: g.verifier,
    });
    expect(first.status).toBe(200);

    const replay = await token({
      grant_type: "authorization_code",
      code: g.code,
      client_id: g.clientId,
      code_verifier: g.verifier,
    });
    expect(replay.status).toBe(400);
    expect(replay.json.error).toBe("invalid_grant");
    expect(replay.json.error_description).toContain("already been used");
  });

  it("refuses a code redeemed by a client it was not issued to", async () => {
    const g = await grant();
    const other = await newClient();
    const res = await token({
      grant_type: "authorization_code",
      code: g.code,
      client_id: other,
      code_verifier: g.verifier,
    });
    expect(res.status).toBe(400);
    expect(res.json.error_description).toContain("another client");
  });

  it("refuses a refresh token presented as an access token, and the reverse", async () => {
    const issued = await tokens();
    // Different derived keys, so each is unreadable garbage to the other's
    // reader. This is the domain separation in keys.ts, asserted.
    expect(await mcp(issued.refresh_token)).toBe(401);
    const asRefresh = await token({
      grant_type: "refresh_token",
      refresh_token: issued.access_token,
      client_id: issued.client_id,
    });
    expect(asRefresh.status).toBe(400);
  });

  it("refuses an authorization whose redirect_uri was never registered", async () => {
    const clientId = await newClient();
    const res = await authorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://attacker.example/steal",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    // A PAGE, not a redirect. Bouncing the error to an unverified URI is the
    // open redirect the exact match exists to prevent.
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("Redirect address not registered");
  });

  it("refuses a client_id this gateway did not issue", async () => {
    const res = await authorize({
      response_type: "code",
      client_id: "not-a-client",
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Unknown client");
  });

  it("names the issuer the authorization began against, not this request's Host", async () => {
    const clientId = await newClient();
    const { challenge } = pkce();
    const started = await authorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const cookie =
      (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const callback = new URL(`${base}/oauth/callback/google`);
    callback.searchParams.set("code", "google-code");
    callback.searchParams.set("state", google.lastState);
    const consent = await fetch(callback, { headers: { cookie } });
    const approval =
      /name="approval" value="([^"]+)"/.exec(await consent.text())?.[1] ?? "";

    // A raw `Host`, because that is the header the origin is derived from and
    // `fetch` will not send one. Asserted on the metadata document first, or
    // the case below would pass whether or not the grant carried its issuer.
    const moved = await withHost(
      "/.well-known/oauth-authorization-server",
      "GET",
      "elsewhere.example",
    );
    expect((JSON.parse(moved.body) as { issuer: string }).issuer).toBe(
      "http://elsewhere.example",
    );

    // Now POST the decision on that moved origin. The `iss` on the
    // authorization response (RFC 9207) is sealed into the grant, so it still
    // names the origin the client was actually talking to at /authorize.
    const approved = await withHost(
      "/oauth/approve",
      "POST",
      "elsewhere.example",
      new URLSearchParams({ approval, decision: "allow" }).toString(),
    );
    expect(approved.status).toBe(302);
    const landed = new URL(approved.location ?? "");
    expect(landed.searchParams.get("iss")).toBe(base);
  });

  it("refuses a callback with no transaction cookie", async () => {
    const res = await fetch(
      `${base}/oauth/callback/google?code=x&state=${google.lastState}`,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("expired");
  });
});

describe("revocation", () => {
  it("kills the grant at Google, so the next refresh fails for good", async () => {
    const issued = await tokens();
    expect(
      (
        await token({
          grant_type: "refresh_token",
          refresh_token: issued.refresh_token,
          client_id: issued.client_id,
        })
      ).status,
    ).toBe(200);

    const revoked = await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: issued.refresh_token }),
    });
    expect(revoked.status).toBe(200);

    const after = await token({
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      client_id: issued.client_id,
    });
    expect(after.status).toBe(400);
    expect(after.json.error).toBe("invalid_grant");
  });

  it("answers 200 for a token it has never seen (RFC 7009 §2.2)", async () => {
    const res = await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "strad_ort_nonsense" }),
    });
    // Never a 400: a revocation endpoint that told you whether a token existed
    // would be an oracle for which tokens exist.
    expect(res.status).toBe(200);
  });
});

describe("scope", () => {
  it("ignores a scope it does not issue, and says what it issued instead", async () => {
    // Refusing would be the stricter reading and the wrong trade: scope grants
    // nothing here — `roles` and the two-way entitlement decide everything —
    // so an `invalid_scope` would only be a connector that fails to set up
    // over a word that was never going to matter. RFC 6749 §3.3 wants the
    // substitution declared, and this is that.
    const clientId = await newClient();
    const { verifier, challenge } = pkce();
    const started = await authorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "openid email offline_access",
    });
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).not.toContain("error=");

    const cookie =
      (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const callback = new URL(`${base}/oauth/callback/google`);
    callback.searchParams.set("code", "google-code");
    callback.searchParams.set("state", google.lastState);
    const consent = await fetch(callback, { headers: { cookie } });
    const approval =
      /name="approval" value="([^"]+)"/.exec(await consent.text())?.[1] ?? "";
    const approved = await fetch(`${base}/oauth/approve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ approval, decision: "allow" }),
      redirect: "manual",
    });
    const code =
      new URL(approved.headers.get("location") ?? "").searchParams.get(
        "code",
      ) ?? "";

    const issued = await token({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(issued.status).toBe(200);
    expect(issued.json.scope).toBe("mcp");
  });
});

describe("the audience is the endpoint, never the URL", () => {
  const ORIGIN = "https://strad.tadasant.com";

  it("normalises `?servers=` and a trailing slash out of a resource indicator", () => {
    expect(normalizeResource(`${ORIGIN}/mcp?servers=granola`)).toBe(
      canonicalResource(ORIGIN),
    );
    expect(normalizeResource(`${ORIGIN}/mcp/`)).toBe(canonicalResource(ORIGIN));
    expect(normalizeResource(`${ORIGIN}/mcp#frag`)).toBe(
      canonicalResource(ORIGIN),
    );
    expect(normalizeResource("not a uri")).toBeNull();
    // A DIFFERENT endpoint is a different resource, and normalising must not
    // collapse it into this one.
    expect(normalizeResource(`${ORIGIN}/other`)).not.toBe(
      canonicalResource(ORIGIN),
    );
  });

  it("accepts a token at the `?servers=` URL it was minted for the endpoint of", async () => {
    const issued = await tokens();
    // The same token, at four spellings of one resource.
    for (const query of [
      "",
      "?servers=granola",
      "?servers=granola,granola",
      "?servers=granola&anything=else",
    ]) {
      expect(await mcp(issued.access_token, query), query).not.toBe(401);
    }
  });

  it("refuses a token minted for another gateway's /mcp", () => {
    const keys = mcpOAuthKeysFromEnv({ STRAD_OAUTH_KEY: KEY });
    if (!keys) throw new Error("no keys");
    const oauth = resolveMcpOAuth({
      config: CONFIG,
      env: { STRAD_OAUTH_KEY: KEY } as NodeJS.ProcessEnv,
      google,
      log: () => {},
    });
    if (!oauth) throw new Error("no oauth");

    const foreign = mintAccessToken(oauth.keys.access, {
      cid: "x",
      aud: "https://other.example/mcp",
      identity: { sub: "s", email: "t@tadasant.com", hd: "tadasant.com" },
      ttlMs: 60_000,
    });
    expect(verifyAccessToken(foreign, oauth, `${ORIGIN}/mcp`)).toEqual({
      ok: false,
      reason: "oauth_audience_mismatch",
    });
    // And with no origin to compare against, the answer is a refusal rather
    // than a check that quietly did not happen.
    expect(verifyAccessToken(foreign, oauth, null)).toEqual({
      ok: false,
      reason: "oauth_no_resource_identifier",
    });
  });

  it("refuses a token whose Workspace the config no longer admits", () => {
    const env = { STRAD_OAUTH_KEY: KEY } as NodeJS.ProcessEnv;
    const oauth = resolveMcpOAuth({
      config: CONFIG,
      env,
      google,
      log: () => {},
    });
    if (!oauth) throw new Error("no oauth");
    const issued = mintAccessToken(oauth.keys.access, {
      cid: "x",
      aud: `${ORIGIN}/mcp`,
      identity: { sub: "s", email: "t@tadasant.com", hd: "tadasant.com" },
      ttlMs: 60_000,
    });
    // Re-pointing the deployment takes effect on tokens already issued.
    const moved = { ...oauth, hostedDomain: "elsewhere.example" };
    expect(verifyAccessToken(issued, moved, `${ORIGIN}/mcp`)).toEqual({
      ok: false,
      reason: "oauth_domain_changed",
    });
  });

  it("reads roles from the config at verification time, never from the token", () => {
    const env = { STRAD_OAUTH_KEY: KEY } as NodeJS.ProcessEnv;
    const oauth = resolveMcpOAuth({
      config: CONFIG,
      env,
      google,
      log: () => {},
    });
    if (!oauth) throw new Error("no oauth");
    const issued = mintAccessToken(oauth.keys.access, {
      cid: "x",
      aud: `${ORIGIN}/mcp`,
      identity: { sub: "s", email: "t@tadasant.com", hd: "tadasant.com" },
      ttlMs: 60_000,
    });
    const narrowed = { ...oauth, roles: [] as string[] };
    const verdict = verifyAccessToken(issued, narrowed, `${ORIGIN}/mcp`);
    expect(verdict.ok && verdict.principal.roles).toEqual([]);
    const wide = verifyAccessToken(issued, oauth, `${ORIGIN}/mcp`);
    expect(wide.ok && wide.principal).toEqual({
      kind: "mcp-oauth",
      id: "s",
      label: "t@tadasant.com",
      roles: ["admin"],
    });
  });
});

describe("the static door is unchanged", () => {
  it("still authenticates a static token, and still refuses a bad one", async () => {
    expect(await mcp(staticToken)).toBe(200);
    expect(await mcp(`${staticToken}x`)).toBe(401);
    expect(await mcp("not-a-token")).toBe(401);
  });

  it("refuses an `strad_oat_` token on a deployment that runs no OAuth server", async () => {
    const store = tokenStoreFromConfig(CONFIG, {
      STRAD_TOKENS: "[]",
    } as NodeJS.ProcessEnv);
    // No verifier supplied — a deployment with `auth.mcpOAuth` off. The reason
    // says so rather than complaining about a `pubid` that was never there.
    await expect(
      authenticateMcp("Bearer strad_oat_anything", store, "test"),
    ).rejects.toMatchObject({ reason: "oauth_not_configured" });
    await expect(
      authenticateMcp("Bearer strad_oat_anything", store, "test"),
    ).rejects.toBeInstanceOf(Unauthenticated);
  });
});

describe("dynamic registration refuses what it should", () => {
  const sealer = mcpOAuthKeysFromEnv({ STRAD_OAUTH_KEY: KEY })!.client;

  it("refuses a redirect URI that would put a code on the wire in the clear", () => {
    expect(redirectUriProblem("http://evil.example/cb")).toContain("https");
    expect(redirectUriProblem("http://localhost:9000/cb")).toBeNull();
    expect(redirectUriProblem("http://127.0.0.1:9000/cb")).toBeNull();
    expect(redirectUriProblem("https://ok.example/cb#x")).toContain("fragment");
    expect(redirectUriProblem("https://a@b.example/cb")).toContain("userinfo");
    expect(redirectUriProblem("/relative")).toContain("absolute");
  });

  it("refuses a confidential-client registration by name", () => {
    const out = registerClient(
      {
        redirect_uris: [CLAUDE_CALLBACK],
        token_endpoint_auth_method: "client_secret_basic",
      },
      sealer,
      "mcp",
    );
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toBe("invalid_client_metadata");
  });

  it("refuses a grant type it does not serve", () => {
    const out = registerClient(
      { redirect_uris: [CLAUDE_CALLBACK], grant_types: ["implicit"] },
      sealer,
      "mcp",
    );
    expect(out.ok).toBe(false);
  });

  it("makes the registration unforgeable and the redirect list unchangeable", () => {
    const out = registerClient(
      { redirect_uris: [CLAUDE_CALLBACK] },
      sealer,
      "mcp",
    );
    if (!out.ok) throw new Error("registration refused");
    const clientId = out.response.client_id;
    const record = readClient(clientId, sealer);
    expect(record?.uris).toEqual([CLAUDE_CALLBACK]);

    // A tampered client id is not a client. This is the whole security
    // property of a client table that does not exist.
    expect(readClient(`${clientId}x`, sealer)).toBeNull();
    const other = mcpOAuthKeysFromEnv({
      STRAD_OAUTH_KEY: "a-completely-different-signing-key-x",
    })!.client;
    expect(readClient(clientId, other)).toBeNull();

    // An omitted redirect_uri resolves only when exactly one is registered.
    expect(resolveRedirectUri(record!, undefined)).toBe(CLAUDE_CALLBACK);
    const two = registerClient(
      { redirect_uris: [CLAUDE_CALLBACK, "https://claude.com/cb"] },
      sealer,
      "mcp",
    );
    if (!two.ok) throw new Error("registration refused");
    expect(resolveRedirectUri(two.record, undefined)).toBeNull();
    expect(resolveRedirectUri(two.record, "https://claude.com/cb")).toBe(
      "https://claude.com/cb",
    );
    // Not a prefix, not a host match.
    expect(
      resolveRedirectUri(two.record, "https://claude.com/cb/extra"),
    ).toBeNull();
  });
});

describe("the primitives", () => {
  it("encrypts rather than signs, so a code does not read out in a URL", () => {
    const cipher = new Cipher(KEY, "test.info");
    const sealed = cipher.seal({ v: 1, secret: "google-refresh-token" });
    // The base64url body decodes to ciphertext, not to the payload. A `Sealer`
    // value would show the JSON to anyone who looked at the address bar.
    expect(Buffer.from(sealed, "base64url").toString("utf8")).not.toContain(
      "google-refresh-token",
    );
    expect(cipher.open<{ v: 1; secret: string }>(sealed)?.secret).toBe(
      "google-refresh-token",
    );
  });

  it("returns null for a value sealed under another key or tampered with", () => {
    const cipher = new Cipher(KEY, "test.info");
    const sealed = cipher.seal({ v: 1, a: 1 });
    expect(new Cipher(KEY, "other.info").open(sealed)).toBeNull();
    expect(new Cipher(`${KEY}x`, "test.info").open(sealed)).toBeNull();
    expect(cipher.open(`${sealed}AA`)).toBeNull();
    expect(cipher.open("")).toBeNull();
    expect(cipher.open(undefined)).toBeNull();
  });

  it("refuses key material too short to be worth deriving from", () => {
    expect(mcpOAuthKeysFromEnv({ STRAD_OAUTH_KEY: "dev" })).toBeNull();
    expect(mcpOAuthKeysFromEnv({})).toBeNull();
    // The fallback chain: the console's key, then the OAuth client secret.
    expect(mcpOAuthKeysFromEnv({ CONSOLE_SESSION_SECRET: KEY })).not.toBeNull();
    expect(mcpOAuthKeysFromEnv({ GOOGLE_CLIENT_SECRET: KEY })).not.toBeNull();
  });

  it("spends a code once and forgets it when it expires", () => {
    const spent = new SpentCodes();
    expect(spent.spend("a", 1000)).toBe(true);
    expect(spent.spend("a", 1000)).toBe(false);
    expect(spent.spend("b", 1000)).toBe(true);
    expect(spent.size).toBe(2);
    // The set is bounded by the code TTL, not by traffic.
    expect(spent.spend("c", 1000 + 60_001)).toBe(true);
    expect(spent.size).toBe(1);
  });

  it("expires an access token on its own `exp`", () => {
    const cipher = new Cipher(KEY, "access");
    const at = mintAccessToken(
      cipher,
      {
        cid: "c",
        aud: "https://h/mcp",
        identity: { sub: "s", email: "e@d", hd: "d" },
        ttlMs: 1000,
      },
      10_000,
    );
    expect(readAccessToken(cipher, at, 10_500)).not.toBeNull();
    expect(readAccessToken(cipher, at, 11_001)).toBeNull();
  });

  it("binds a grant to a client with a digest of the whole registration", () => {
    expect(clientFingerprint("a")).toBe(clientFingerprint("a"));
    expect(clientFingerprint("a")).not.toBe(clientFingerprint("b"));
  });
});

describe("the deployment has to be able to run the flow", () => {
  const env = { STRAD_OAUTH_KEY: KEY } as NodeJS.ProcessEnv;

  it("is null when the flag is off", () => {
    const off = StradConfig.parse({
      version: 1,
      gateway: { name: "strad", env: "test" },
      auth: {},
      servers: [],
    });
    expect(resolveMcpOAuth({ config: off, env, log: () => {} })).toBeNull();
  });

  it("is null when the flag is on but nothing is seeded, and says why", () => {
    const said: string[] = [];
    expect(
      resolveMcpOAuth({
        config: CONFIG,
        env: {} as NodeJS.ProcessEnv,
        log: (m) => said.push(m),
      }),
    ).toBeNull();
    expect(said.join("\n")).toContain("GOOGLE_CLIENT_ID");
    expect(said.join("\n")).toContain("static tokens only");
  });

  it("warns when the flow would grant no servers at all", () => {
    const said: string[] = [];
    const noRoles = parseConfig(YAML.replace("roles: [admin]", "roles: []"));
    resolveMcpOAuth({
      config: noRoles,
      env,
      google,
      log: (m) => said.push(m),
    });
    expect(said.join("\n")).toContain("entitled to no servers");
  });

  it("falls back to auth.google.hostedDomain, and refuses a config with neither", () => {
    const shared = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  google: { enabled: true, hostedDomain: tadasant.com, roles: [admin] }
  mcpOAuth: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
servers: []
`);
    expect(
      resolveMcpOAuth({ config: shared, env, google, log: () => {} })
        ?.hostedDomain,
    ).toBe("tadasant.com");

    // Neither. A flow with no domain to enforce admits whoever arrives, so it
    // is a config error rather than a runtime shrug.
    expect(() =>
      parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  mcpOAuth: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
servers: []
`),
    ).toThrow(/no hosted domain is declared/);
  });

  it("refuses a role no roles: block defines", () => {
    expect(() =>
      parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  mcpOAuth: { enabled: true, hostedDomain: tadasant.com, roles: [ghost] }
roles:
  admin: { servers: ["*"] }
servers: []
`),
    ).toThrow(/unknown role "ghost"/);
  });

  it("publishes no authorization server when it cannot run one", async () => {
    const bare = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: granola
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`);
    const env2 = { STRAD_TOKENS: "[]" } as NodeJS.ProcessEnv;
    const registry = await Registry.build({
      config: bare,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: env2,
    });
    const app = createApp({
      config: bare,
      registry,
      tokenStore: tokenStoreFromConfig(bare, env2),
      mode: "core",
      env: env2,
    });
    const srv = await new Promise<Server>((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    const at = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      // The RFC 9728 document still serves — it always did — and names nobody.
      const doc = (await (
        await fetch(`${at}/.well-known/oauth-protected-resource/mcp`)
      ).json()) as Record<string, unknown>;
      expect(doc.resource).toBe(`${at}/mcp`);
      expect(doc.authorization_servers).toBeUndefined();
      // And every route of a flow that cannot complete is a 404, rather than a
      // dead end a client walks half of.
      for (const path of [
        "/.well-known/oauth-authorization-server",
        "/oauth/authorize",
        "/oauth/register",
        "/oauth/token",
      ]) {
        expect((await fetch(`${at}${path}`)).status, path).toBe(404);
      }
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
