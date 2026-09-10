import { createHash, randomBytes } from "node:crypto";
import { withRequestDeadline } from "../util/deadline.ts";

/**
 * Google OAuth for the human console path.
 *
 * The only interesting part is `hd`. Google's `email` claim is NOT proof of
 * Workspace membership: a personal gmail.com account can set its profile email
 * to `someone@tadasant.com`, and `email_verified` will be true for it. The `hd`
 * (hosted domain) claim is only ever emitted for accounts that actually belong
 * to that Workspace domain. So we check `hd`, and we do not check the suffix.
 *
 * Both outbound calls — the token exchange and the JWKS fetch — are bounded at
 * ten seconds, and both are on ONE route: `GET /console/oauth/callback`. Node's
 * `fetch` has no overall timeout, so an unbounded call at either site is a
 * sign-in that hangs for undici's 300s header timeout, holding an Express
 * handler and a socket for every attempt a human makes at a login that is never
 * going to arrive. Ten seconds is strad talking to Google — a value, not a
 * config knob, because there is no deployment whose choice this is — and a
 * healthy handshake answers in well under a second, so only something already
 * broken ever reaches it.
 *
 * Fully implemented and ready. It activates the moment GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET are present; until then the console falls back to the
 * bootstrap-token bypass (src/auth/dev.ts).
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const GOOGLE_TIMEOUT_MS = 10_000;

export interface GoogleOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Required Workspace domain, e.g. "tadasant.com". */
  hostedDomain: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  hd: string;
  name?: string;
  picture?: string;
}

export interface PendingAuth {
  state: string;
  codeVerifier: string;
  url: string;
}

export class GoogleOAuthProvider {
  constructor(private readonly opts: GoogleOAuthOptions) {}

  /**
   * Build the consent URL. PKCE is used even though this is a confidential
   * client — it costs nothing and closes the auth-code interception window.
   */
  beginAuth(): PendingAuth {
    const state = randomBytes(16).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_id", this.opts.clientId);
    url.searchParams.set("redirect_uri", this.opts.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    // A hint to Google's account chooser. NOT a security control — the response
    // is still verified against `hd` below.
    url.searchParams.set("hd", this.opts.hostedDomain);

    return { state, codeVerifier, url: url.toString() };
  }

  /** Exchange the code, verify the ID token, enforce `hd`. */
  async completeAuth(
    code: string,
    codeVerifier: string,
  ): Promise<GoogleIdentity> {
    const body = new URLSearchParams({
      code,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      redirect_uri: this.opts.redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    });

    // The deadline covers the body read as well as the response, because a
    // response that trickles its bytes is the stall a header timeout never
    // catches. The expiry arrives as an `AuthError` like every other refusal on
    // this path — `/console/oauth/callback` (src/http/app.ts) handles that class
    // and would send a bare `DOMException` to its catch-all instead.
    const json = await withRequestDeadline(
      GOOGLE_TIMEOUT_MS,
      async (signal) => {
        const res = await fetch(TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal,
        });
        if (!res.ok) {
          throw new AuthError(`google token exchange failed: ${res.status}`);
        }
        return (await res.json()) as { id_token?: string };
      },
      () =>
        new AuthError(
          `google token exchange timed out after ${GOOGLE_TIMEOUT_MS}ms`,
        ),
    );
    if (!json.id_token) throw new AuthError("google returned no id_token");

    return this.verifyIdToken(json.id_token);
  }

  async verifyIdToken(idToken: string): Promise<GoogleIdentity> {
    const claims = await verifyGoogleIdToken(idToken, this.opts.clientId);

    // THE check. Not the email suffix.
    if (claims.hd !== this.opts.hostedDomain) {
      throw new AuthError(
        `account is not a member of the ${this.opts.hostedDomain} Google Workspace`,
      );
    }
    if (!claims.email || claims.email_verified !== true) {
      throw new AuthError("google account has no verified email");
    }

    return {
      sub: claims.sub,
      email: claims.email,
      hd: claims.hd,
      name: claims.name,
      picture: claims.picture,
    };
  }
}

export class AuthError extends Error {}

export interface GoogleClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  hd?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

interface Jwk {
  kid: string;
  n: string;
  e: string;
  alg?: string;
  kty: string;
}

let jwksCache: { keys: Jwk[]; expiresAt: number } | null = null;

/**
 * The fetch a cold cache is already making, joined rather than repeated.
 *
 * A cold cache under concurrent sign-ins is N requests for one answer, and each
 * of them is one of the stalls `GOOGLE_TIMEOUT_MS` exists for. Holding the
 * promise is only safe because it is cleared when it SETTLES, either way: a
 * rejected fetch left here is a login that keeps failing on a network second
 * that has long passed.
 */
let jwksInFlight: Promise<Jwk[]> | null = null;

/**
 * Drop the cached JWKS, forcing the next verification to re-fetch. The cache is
 * process-wide, so a test that stubs `fetch` for one case would otherwise be
 * answered by the key a previous case installed.
 *
 * The in-flight fetch goes with it, for the same reason and one sharper: a stub
 * installed for the next case would otherwise be answered by a promise the
 * previous case's stub owns.
 */
export function resetJwksCache(): void {
  jwksCache = null;
  jwksInFlight = null;
}

async function getJwks(): Promise<Jwk[]> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  if (jwksInFlight) return jwksInFlight;

  const flight = fetchJwks();
  jwksInFlight = flight;
  try {
    return await flight;
  } finally {
    // Identity, not truthiness: `resetJwksCache()` may have run while this was
    // in the air, and clearing a SUCCESSOR's flight would undo the sharing for
    // whoever started it.
    if (jwksInFlight === flight) jwksInFlight = null;
  }
}

async function fetchJwks(): Promise<Jwk[]> {
  const fetched = await withRequestDeadline(
    GOOGLE_TIMEOUT_MS,
    async (signal) => {
      const res = await fetch(JWKS_URI, { signal });
      if (!res.ok)
        throw new AuthError(`failed to fetch Google JWKS: ${res.status}`);
      const json = (await res.json()) as { keys: Jwk[] };

      // Honour Cache-Control; Google rotates these keys.
      const cc = res.headers.get("cache-control") ?? "";
      const maxAge = /max-age=(\d+)/.exec(cc)?.[1];
      const ttlMs = maxAge ? Number(maxAge) * 1000 : 3600_000;
      return { keys: json.keys, ttlMs };
    },
    () =>
      new AuthError(`google JWKS fetch timed out after ${GOOGLE_TIMEOUT_MS}ms`),
  );

  jwksCache = { keys: fetched.keys, expiresAt: Date.now() + fetched.ttlMs };
  return fetched.keys;
}

/**
 * Verify RS256 signature, issuer, audience and expiry.
 *
 * Exported because the console CONNECTOR flow (src/connectors/google.ts) needs
 * exactly this and nothing around it. That flow runs against a DIFFERENT OAuth
 * client — the one a server's own namespace holds — and checks a pinned email
 * rather than a Workspace `hd`, so it cannot reuse `GoogleOAuthProvider`. What it
 * must not do is grow a second RS256/JWKS/issuer/audience implementation: this is
 * the only proof of identity in either flow, and one of it is the point.
 */
export async function verifyGoogleIdToken(
  token: string,
  audience: string,
): Promise<GoogleClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("malformed id_token");
  const [headerB64, payloadB64, signatureB64] = parts as [
    string,
    string,
    string,
  ];

  const header = JSON.parse(
    Buffer.from(headerB64, "base64url").toString("utf8"),
  ) as { kid?: string; alg?: string };

  if (header.alg !== "RS256") {
    throw new AuthError(`unexpected id_token alg: ${header.alg}`);
  }

  const jwk = (await getJwks()).find((k) => k.kid === header.kid);
  if (!jwk) throw new AuthError("id_token signed by an unknown key");

  const { createPublicKey, createVerify } = await import("node:crypto");
  const key = createPublicKey({ key: jwk as never, format: "jwk" });

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();

  if (!verifier.verify(key, Buffer.from(signatureB64, "base64url"))) {
    throw new AuthError("id_token signature verification failed");
  }

  const claims = JSON.parse(
    Buffer.from(payloadB64, "base64url").toString("utf8"),
  ) as GoogleClaims;

  if (!ISSUERS.has(claims.iss)) {
    throw new AuthError(`unexpected id_token issuer: ${claims.iss}`);
  }
  if (claims.aud !== audience) {
    throw new AuthError("id_token audience mismatch");
  }
  if (claims.exp * 1000 <= Date.now()) {
    throw new AuthError("id_token expired");
  }

  return claims;
}

/** Build the provider from env, or null when credentials are not yet present. */
export function googleProviderFromEnv(
  hostedDomain: string,
  redirectUri: string,
  env: NodeJS.ProcessEnv = process.env,
): GoogleOAuthProvider | null {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new GoogleOAuthProvider({
    clientId,
    clientSecret,
    redirectUri,
    hostedDomain,
  });
}
