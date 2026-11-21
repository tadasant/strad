import { createHash, randomBytes } from "node:crypto";
import { secretEquals } from "../credential.ts";
import type { Cipher } from "./keys.ts";

/**
 * The three values strad's authorization server hands out, and what is inside
 * each of them.
 *
 * ## The identity is Google's, and it stays Google's
 *
 * Every grant here is backed by a GOOGLE refresh token, carried (encrypted)
 * inside strad's own authorization code and then inside strad's own refresh
 * token. That one decision answers the two hardest questions a datastore-less
 * authorization server has:
 *
 *   - **Re-checking the domain on refresh.** The constraint is that only a
 *     member of the configured Workspace may hold a token. Re-reading an `hd`
 *     claim strad sealed an hour ago is strad checking its own copy of its own
 *     answer; it says nothing about whether the account still exists, is still
 *     in the Workspace, or has been suspended. Refreshing against Google gets a
 *     FRESH id_token, and the check runs on that.
 *
 *   - **Revocation of a token that never expires.** Tadas's instruction is that
 *     the refresh token does not expire, and a stateless non-expiring
 *     credential with no revocation is a permanent key. There is no table to
 *     mark revoked and no table that would survive a redeploy if there were —
 *     but Google has one. Revoking the grant at Google (from
 *     `myaccount.google.com`, from the Workspace admin console, or through
 *     strad's own `/oauth/revoke`, which calls Google) makes the next refresh
 *     fail, permanently and durably, with no strad state involved at all.
 *
 * So strad's refresh token never expires and is individually revocable, and
 * neither property is a promise this process keeps in memory.
 *
 * ## Why the access token is opaque
 *
 * strad is BOTH the authorization server and the resource server, in one
 * process, so there is nobody to hand a verifiable JWT to. An encrypted blob
 * costs one AES-GCM open per request, keeps the holder's email address out of
 * anything that decodes a bearer token in transit, and cannot be replayed as a
 * refresh token because the two are under different keys (`keys.ts`).
 *
 * ## The slug set, when there is one
 *
 * The code, the refresh token and the access token carry an OPTIONAL `slugs`
 * array: the `slug:<name>` scopes the grant was narrowed to, at the client's
 * request or by the human on the consent screen (`policy.ts`). Absent means
 * the whole of the client's ceiling — the `mcp` scope — and is what every
 * token minted before the field existed reads as. It is a narrowing, so a
 * token carrying it can only reach less than its roles would; it is never a
 * grant on its own.
 *
 * ## What the token does NOT carry
 *
 * Roles. `Principal.roles` is server-side by construction
 * (`src/auth/index.ts`), and a token is a thing the caller holds. Roles are
 * read from the CURRENT config at verification time, and so is the hosted
 * domain — the same rule `principalFromSession` follows, for the same reason:
 * tightening `auth.mcpOAuth` must take effect on tokens already issued, not
 * only on the ones minted after the deploy.
 */

/**
 * The payload version. `1` is every grant with no slug set — byte for byte the
 * shape minted before slug scopes existed. `2` is a grant that carries one, or
 * an approval that carries the consent screen's `offered` list, and it exists
 * for ROLLBACK: a build that predates the `slugs` field opens only `v: 1`
 * (`keys.ts`), so it refuses a narrowed token outright rather than reading it as
 * the whole ceiling. An unnarrowed grant stays `v: 1` so that the default
 * config mints exactly what it always did.
 */
export type GrantVersion = 1 | 2 | 3;

/**
 * `3` is a grant sealed to a CONFIDENTIAL client (`auth: "private_key_jwt"`),
 * narrowed or not, for the same rollback reason one step further: a build that
 * predates `auth` would spend it without the client's assertion, so it must
 * not be able to open it at all.
 */
export function grantVersion(
  narrowing: unknown,
  auth?: "private_key_jwt",
): GrantVersion {
  if (auth !== undefined) return 3;
  return narrowing === undefined ? 1 : 2;
}

/** The prefixes that decide which door a presented credential goes through. */
export const ACCESS_TOKEN_PREFIX = "strad_oat_";
export const REFRESH_TOKEN_PREFIX = "strad_ort_";

/** RFC 7636: the only challenge method strad accepts. */
export const CODE_CHALLENGE_METHOD = "S256";

/**
 * How long an authorization code is good for.
 *
 * RFC 6749 §4.1.2 says a maximum of ten minutes and RECOMMENDS one. Sixty
 * seconds is what an automated redirect actually needs: the code is minted
 * after the human has already consented, and the only hop left is the client's
 * own back-channel call to `/oauth/token`.
 */
export const CODE_TTL_MS = 60_000;

/** How long a human has between consenting and the code being minted. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** How long a browser has to get through Google's consent screen and back. */
export const TX_TTL_MS = 10 * 60 * 1000;

/** The verified Google identity a grant belongs to. */
export interface GrantIdentity {
  sub: string;
  email: string;
  hd: string;
  name?: string;
}

/**
 * The part of an authorization request that survives the round trip to Google.
 *
 * It travels three times: in the browser's transaction cookie, in the consent
 * screen's hidden field, and (minus the client's own `state`) inside the
 * authorization code. One shape for all three, so the thing `/oauth/token`
 * checks is the thing `/oauth/authorize` validated.
 */
export interface AuthorizationRequest {
  /**
   * `clientFingerprint(client_id)` — the grant's binding to its client.
   *
   * The FINGERPRINT and not the client id itself, and that is a size decision
   * rather than a tidiness one. A `client_id` carries the whole sealed
   * registration, which grows with every redirect URI in it; this shape travels
   * in a COOKIE, and a browser silently drops one past about 4 kB. A client
   * registering near the bounds in `clients.ts` would have got its `201`, been
   * sent to Google, come back, and been told its sign-in had expired — forever,
   * with the failure naming the wrong cause. 43 characters, always.
   */
  cid: string;
  /** The exact registered redirect URI this authorization is delivered to. */
  redirectUri: string;
  /** RFC 7636 `code_challenge`. S256 always; there is no method field. */
  challenge: string;
  /** The client's own `state`, echoed back untouched. */
  state?: string;
  /** The canonical resource this grant is for. Never a `?servers=` URL. */
  resource: string;
  /**
   * The issuer this authorization was begun against — the origin, sealed at
   * `/oauth/authorize` rather than re-derived on each later hop.
   *
   * It is what goes in `iss` on the authorization response (RFC 9207), and the
   * point of carrying it is that the three hops that need it — the Google
   * callback, the consent decision, the redirect that delivers the code — are
   * three separate requests. Re-deriving it from each one's `Host` would let a
   * grant be delivered naming an issuer other than the one the client was
   * talking to when it started, and would answer `""` on a request whose origin
   * happened to be unreadable.
   */
  issuer: string;
  /**
   * The slugs the client asked for as `slug:<name>` scopes, already checked
   * against its ceiling. Absent when it asked for none (`mcp`, or nothing).
   */
  slugs?: string[];
  /**
   * `private_key_jwt` when the client was confidential at `/oauth/authorize` —
   * its document or its config entry said so. Sealed so that every later
   * spend of this grant demands the client's assertion, even if the document
   * changes its mind. Absent is a public client.
   */
  auth?: "private_key_jwt";
}

/** The consent screen's hidden field: a validated request awaiting a decision. */
export interface PendingApproval extends AuthorizationRequest {
  v: GrantVersion;
  identity: GrantIdentity;
  /** Google's refresh token for this grant. The reason this is encrypted. */
  googleRefreshToken: string;
  /** Display only: the client's registered name, for the screen. */
  clientName?: string;
  /**
   * The slugs the consent screen offered, one checkbox each. What the human
   * posts back is intersected with this, so the form can only narrow. Absent
   * on an approval sealed before slug consent existed, which grants the
   * request unchanged.
   */
  offered?: string[];
  exp: number;
}

/** The authorization code. */
export interface CodePayload {
  v: GrantVersion;
  jti: string;
  /** `clientFingerprint(client_id)` — the grant's binding to its client. */
  cid: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  identity: GrantIdentity;
  googleRefreshToken: string;
  /** The granted slug narrowing. Absent = the client's whole ceiling. */
  slugs?: string[];
  /** See `AuthorizationRequest.auth`. */
  auth?: "private_key_jwt";
  exp: number;
}

/** The refresh token. Note the absence of `exp`: it does not expire. */
export interface RefreshPayload {
  v: GrantVersion;
  jti: string;
  cid: string;
  resource: string;
  /** The subject and email at issue time; both re-verified on every refresh. */
  identity: GrantIdentity;
  googleRefreshToken: string;
  /** The granted slug narrowing. Absent = the client's whole ceiling. */
  slugs?: string[];
  /** See `AuthorizationRequest.auth`. */
  auth?: "private_key_jwt";
  iat: number;
}

/** The access token. */
export interface AccessPayload {
  v: GrantVersion;
  jti: string;
  cid: string;
  /** The RFC 8707 audience. Compared against the canonical resource, only. */
  aud: string;
  sub: string;
  email: string;
  hd: string;
  /** This token's slug narrowing. Absent = the client's whole ceiling. */
  slugs?: string[];
  iat: number;
  exp: number;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
const VERIFIER_SHAPE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** RFC 7636 §4.2: the challenge is base64url of a SHA-256, so 43 characters. */
const CHALLENGE_SHAPE = /^[A-Za-z0-9\-._~]{43}$/;

export function validChallenge(challenge: string): boolean {
  return CHALLENGE_SHAPE.test(challenge);
}

/**
 * Does this verifier produce that challenge?
 *
 * `secretEquals` rather than `===` because the challenge is a value an attacker
 * who intercepted the authorization code holds, and the verifier is the secret
 * they are trying to guess. It is also the repo's one comparator
 * (`src/auth/credential.ts`); a local `timingSafeEqual` here would be the
 * second, which `test/auth-header.doors.test.ts` refuses.
 */
export function verifierMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER_SHAPE.test(verifier)) return false;
  const digest = createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  return secretEquals(digest, challenge);
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

export function mintCode(
  cipher: Cipher,
  approval: PendingApproval,
  cid: string,
  now: number = Date.now(),
  slugs: string[] | undefined = approval.slugs,
): string {
  const payload: CodePayload = {
    v: grantVersion(slugs, approval.auth),
    jti: randomBytes(12).toString("base64url"),
    cid,
    redirectUri: approval.redirectUri,
    challenge: approval.challenge,
    resource: approval.resource,
    identity: approval.identity,
    googleRefreshToken: approval.googleRefreshToken,
    ...(slugs ? { slugs } : {}),
    ...(approval.auth ? { auth: approval.auth } : {}),
    exp: now + CODE_TTL_MS,
  };
  return cipher.seal(payload);
}

export function mintAccessToken(
  cipher: Cipher,
  opts: {
    cid: string;
    aud: string;
    identity: GrantIdentity;
    ttlMs: number;
    slugs?: string[];
  },
  now: number = Date.now(),
): string {
  const payload: AccessPayload = {
    v: grantVersion(opts.slugs),
    jti: randomBytes(12).toString("base64url"),
    cid: opts.cid,
    aud: opts.aud,
    sub: opts.identity.sub,
    email: opts.identity.email,
    hd: opts.identity.hd,
    ...(opts.slugs ? { slugs: opts.slugs } : {}),
    iat: now,
    exp: now + opts.ttlMs,
  };
  return `${ACCESS_TOKEN_PREFIX}${cipher.seal(payload)}`;
}

export function mintRefreshToken(
  cipher: Cipher,
  opts: {
    cid: string;
    resource: string;
    identity: GrantIdentity;
    googleRefreshToken: string;
    slugs?: string[];
    auth?: "private_key_jwt";
  },
  now: number = Date.now(),
): string {
  const payload: RefreshPayload = {
    v: grantVersion(opts.slugs, opts.auth),
    jti: randomBytes(12).toString("base64url"),
    cid: opts.cid,
    resource: opts.resource,
    identity: opts.identity,
    googleRefreshToken: opts.googleRefreshToken,
    ...(opts.slugs ? { slugs: opts.slugs } : {}),
    ...(opts.auth ? { auth: opts.auth } : {}),
    iat: now,
  };
  return `${REFRESH_TOKEN_PREFIX}${cipher.seal(payload)}`;
}

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

export function readCode(
  cipher: Cipher,
  code: string | undefined,
  now: number = Date.now(),
): CodePayload | null {
  const payload = cipher.open<CodePayload>(code);
  if (!payload) return null;
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (typeof payload.jti !== "string" || payload.jti === "") return null;
  if (!validIdentity(payload.identity)) return null;
  if (!validSlugs(payload.slugs)) return null;
  if (!validAuth(payload.auth)) return null;
  return payload;
}

export function readRefreshToken(
  cipher: Cipher,
  token: string | undefined,
): RefreshPayload | null {
  if (!token || !token.startsWith(REFRESH_TOKEN_PREFIX)) return null;
  const payload = cipher.open<RefreshPayload>(
    token.slice(REFRESH_TOKEN_PREFIX.length),
  );
  if (!payload) return null;
  // No expiry check. That is the whole point of this token, and it is the one
  // place in strad where the absence of a deadline is deliberate rather than an
  // omission — see the header, and `docs/auth/overview.md`.
  if (!validIdentity(payload.identity)) return null;
  if (typeof payload.googleRefreshToken !== "string") return null;
  if (!validSlugs(payload.slugs)) return null;
  if (!validAuth(payload.auth)) return null;
  return payload;
}

export function readAccessToken(
  cipher: Cipher,
  token: string | undefined,
  now: number = Date.now(),
): AccessPayload | null {
  if (!token || !token.startsWith(ACCESS_TOKEN_PREFIX)) return null;
  const payload = cipher.open<AccessPayload>(
    token.slice(ACCESS_TOKEN_PREFIX.length),
  );
  if (!payload) return null;
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (typeof payload.sub !== "string" || payload.sub === "") return null;
  if (typeof payload.email !== "string" || payload.email === "") return null;
  if (typeof payload.aud !== "string" || payload.aud === "") return null;
  if (!validSlugs(payload.slugs)) return null;
  return payload;
}

/**
 * Absent, or an array of strings. A sealed payload is ours, so anything else
 * is a bug rather than an attack — and a narrowing strad cannot read must not
 * be read as "no narrowing", which is the widest answer.
 */
function validSlugs(slugs: unknown): boolean {
  return (
    slugs === undefined ||
    (Array.isArray(slugs) && slugs.every((s) => typeof s === "string"))
  );
}

/** Absent, or the one confidential method. Anything else reads as unknown. */
function validAuth(auth: unknown): boolean {
  return auth === undefined || auth === "private_key_jwt";
}

function validIdentity(identity: unknown): identity is GrantIdentity {
  const i = identity as GrantIdentity | undefined;
  return (
    typeof i === "object" &&
    i !== null &&
    typeof i.sub === "string" &&
    i.sub !== "" &&
    typeof i.email === "string" &&
    i.email !== "" &&
    typeof i.hd === "string"
  );
}

// ---------------------------------------------------------------------------
// Single-use codes
// ---------------------------------------------------------------------------

/**
 * The authorization codes that have already been spent.
 *
 * A code is a stateless value, so the ONLY way to make it single-use is to
 * remember the ones already seen — and this is the one piece of server-side
 * state in the whole flow. It is deliberately tiny and deliberately bounded: a
 * code lives sixty seconds, so an entry is dropped sixty seconds after it is
 * made, and the set can never hold more than a minute's worth of
 * authorizations.
 *
 * It is PER PROCESS, which is the honest limit. strad core runs one instance
 * today; on a deployment scaled to several, a code replayed against a different
 * replica inside its sixty-second window would not be caught here. What catches
 * it there is PKCE, which is mandatory on this server: whoever replays a code
 * they intercepted does not hold the verifier, and `/oauth/token` refuses them
 * whether or not the code was spent. `HACKS.md` carries this as a known bound.
 */
export class SpentCodes {
  private readonly seen = new Map<string, number>();

  /** True the FIRST time a jti is offered, false every time after. */
  spend(jti: string, now: number = Date.now()): boolean {
    this.sweep(now);
    if (this.seen.has(jti)) return false;
    this.seen.set(jti, now + CODE_TTL_MS);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  private sweep(now: number): void {
    for (const [jti, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(jti);
    }
  }
}
