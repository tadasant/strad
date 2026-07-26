import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type { StradConfig } from "../config/schema.ts";
import type { Principal } from "./index.ts";

/**
 * The console session: a signed, expiring, stateless cookie.
 *
 * This is what turns a verified Google identity into something `/ui` will
 * accept. Google's callback mints one; the console gate reads it back.
 *
 * WHY STATELESS. strad has no datastore, and the console is deployed as an App
 * Platform component that may run more than one replica. A server-side session
 * table breaks on both counts: a login begun on replica A cannot be finished on
 * replica B, and every restart signs everyone out. An HMAC over the identity has
 * neither problem — any replica holding the same key can verify any cookie, and a
 * redeploy is invisible to a signed-in human. The same primitive carries the
 * in-flight OAuth transaction, so no login state lives on the server at all.
 *
 * WHAT WE GIVE UP. A stateless session cannot be revoked one-at-a-time: a cookie
 * is valid until it expires. Three things bound that:
 *   - a short absolute lifetime (12h), with no sliding renewal — the clock
 *     starts at sign-in and never moves, so a stolen cookie dies on a schedule
 *     an attacker cannot extend;
 *   - `hd` is re-checked against the CURRENT config on every request, and roles
 *     are read from the CURRENT config rather than from the cookie, so tightening
 *     `auth.google` takes effect immediately for sessions already issued;
 *   - rotating the signing key invalidates every session at once. That is the
 *     kill switch, and it is a secret rotation rather than a code change.
 *
 * THE KEY. `CONSOLE_SESSION_SECRET` when set. Otherwise it is derived (HKDF)
 * from `GOOGLE_CLIENT_SECRET`, which is necessarily present whenever there is a
 * Google login to sign in the first place — so the session works the moment the
 * OAuth client is provisioned, with no second secret to seed and no silent
 * "signed in but the cookie never verifies" state. Set
 * `CONSOLE_SESSION_SECRET` when you want to rotate sessions independently of the
 * OAuth client.
 *
 * DOMAIN SEPARATION. The login session and the in-flight OAuth transaction get
 * two different derived keys from the same input. A sealed value from one is
 * unforgeable garbage to the other, so a session cookie can never be replayed as
 * an OAuth transaction or the reverse.
 */

const HKDF_SALT = "strad.console.v1";
const INFO_SESSION = "strad.console.session.v1";
const INFO_TX = "strad.console.oauth-tx.v1";

/** The signed Google session. */
export const SESSION_COOKIE = "strad_console_session";
/** The in-flight OAuth transaction: PKCE verifier + state + return path. */
export const OAUTH_TX_COOKIE = "strad_oauth_tx";

/** Absolute session lifetime. Re-authenticating is a redirect, not a password. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** How long a human has to get through Google's consent screen and back. */
export const OAUTH_TX_TTL_MS = 10 * 60 * 1000;

export interface ConsoleSessionPayload {
  v: 1;
  /** Google's stable subject id. The identity, independent of the email. */
  sub: string;
  email: string;
  /** The verified hosted domain, re-checked against config on every read. */
  hd: string;
  name?: string;
  /** Issued-at and absolute expiry, epoch ms. */
  iat: number;
  exp: number;
}

export interface OauthTxPayload {
  v: 1;
  state: string;
  verifier: string;
  /** Where to land after a successful sign-in. Always a same-origin path. */
  next: string;
  exp: number;
}

/**
 * Seals a JSON payload under one derived key: `<payload>.<hmac>`, both base64url.
 *
 * The payload is signed, not encrypted — it holds an email and a hosted domain,
 * which the human it belongs to already knows, and nothing else. What matters is
 * that they cannot change it.
 */
export class Sealer {
  private readonly key: Buffer;

  constructor(ikm: string, info: string) {
    this.key = Buffer.from(
      hkdfSync("sha256", Buffer.from(ikm, "utf8"), HKDF_SALT, info, 32),
    );
  }

  seal(payload: object): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    return `${body}.${this.mac(body)}`;
  }

  /** Returns null for anything that is not a currently-valid sealed payload. */
  unseal<T extends { exp: number }>(
    token: string | undefined,
    now: number = Date.now(),
  ): T | null {
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;

    const body = token.slice(0, dot);
    const presented = Buffer.from(token.slice(dot + 1), "base64url");
    const expected = Buffer.from(this.mac(body), "base64url");
    if (presented.length !== expected.length) return null;
    if (!timingSafeEqual(presented, expected)) return null;

    let payload: T;
    try {
      payload = JSON.parse(
        Buffer.from(body, "base64url").toString("utf8"),
      ) as T;
    } catch {
      return null;
    }

    if (typeof payload?.exp !== "number" || payload.exp <= now) return null;
    return payload;
  }

  private mac(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }
}

export interface ConsoleSessions {
  session: Sealer;
  tx: Sealer;
}

/**
 * Build the sealers, or null when there is no key material to derive from.
 *
 * Null is a hard "no console session can exist" — the gate must then not offer
 * a Google sign-in it cannot complete.
 */
export function consoleSessionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ConsoleSessions | null {
  const ikm = env.CONSOLE_SESSION_SECRET || env.GOOGLE_CLIENT_SECRET;
  if (!ikm) return null;
  return {
    session: new Sealer(ikm, INFO_SESSION),
    tx: new Sealer(ikm, INFO_TX),
  };
}

/**
 * The Principal a valid session cookie stands for.
 *
 * Roles come from `auth.google.roles` at read time, never from the cookie: the
 * comment on `Principal` says roles are server-side only, and a cookie is a
 * thing the caller holds. Signing it would make forgery impossible but would
 * still freeze the grant at sign-in time, which is worse operationally.
 */
export function principalFromSession(
  payload: ConsoleSessionPayload,
  cfg: StradConfig,
): Principal | null {
  const google = cfg.auth.google;
  if (!google?.enabled) return null;
  // The check that mattered at sign-in still has to hold now. Re-pointing the
  // deployment at another Workspace must not leave the old one signed in.
  if (payload.hd !== google.hostedDomain) return null;

  return {
    kind: "google",
    id: payload.sub,
    label: payload.email,
    roles: google.roles,
  };
}

export function issueSessionCookie(
  res: Response,
  sealer: Sealer,
  identity: { sub: string; email: string; hd: string; name?: string },
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): void {
  const payload: ConsoleSessionPayload = {
    v: 1,
    sub: identity.sub,
    email: identity.email,
    hd: identity.hd,
    ...(identity.name ? { name: identity.name } : {}),
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  res.cookie(SESSION_COOKIE, sealer.seal(payload), {
    ...cookieFlags(env),
    // Scoped to "/" because the gate covers the landing page as well as /ui.
    // It therefore rides along to /mcp, which is inert: /mcp authenticates the
    // Authorization header against the static token store and never reads a
    // cookie (HACKS.md #2).
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

export function issueOauthTxCookie(
  res: Response,
  sealer: Sealer,
  tx: { state: string; verifier: string; next: string },
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): void {
  const payload: OauthTxPayload = { v: 1, ...tx, exp: now + OAUTH_TX_TTL_MS };
  res.cookie(OAUTH_TX_COOKIE, sealer.seal(payload), {
    ...cookieFlags(env),
    // Narrower than the session: only the callback ever reads it.
    path: "/console",
    maxAge: OAUTH_TX_TTL_MS,
  });
}

export function clearSessionCookie(
  res: Response,
  env: NodeJS.ProcessEnv,
): void {
  res.clearCookie(SESSION_COOKIE, { ...cookieFlags(env), path: "/" });
}

export function clearOauthTxCookie(
  res: Response,
  env: NodeJS.ProcessEnv,
): void {
  res.clearCookie(OAUTH_TX_COOKIE, { ...cookieFlags(env), path: "/console" });
}

/**
 * SameSite=Lax, not Strict: the browser arrives back from accounts.google.com as
 * a top-level GET navigation, and Strict would withhold the transaction cookie
 * on exactly that request, breaking every login. Lax sends it there and still
 * withholds it from cross-site POSTs, which is what protects the `/ui` writes.
 */
function cookieFlags(env: NodeJS.ProcessEnv) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Staging and prod run NODE_ENV=production behind TLS.
    secure: env.NODE_ENV === "production",
  };
}

/**
 * Constant-time compare of two `state` values, tolerant of different lengths.
 * The sealed cookie already proves the transaction is ours; this proves the
 * callback is the SAME transaction that this browser began.
 */
export function stateMatches(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Where to send the human after sign-in.
 *
 * Only a same-origin, absolute path survives. Anything else — a scheme-relative
 * `//evil.example`, a full URL, a backslash the browser normalises to a slash —
 * becomes `/ui`. An open redirect on a login callback is how a phishing page
 * borrows your domain's trust.
 */
export function sanitizeNext(raw: unknown, fallback = "/ui"): string {
  if (typeof raw !== "string" || raw === "") return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (raw.includes("\\") || raw.includes("\n") || raw.includes("\r")) {
    return fallback;
  }
  return raw;
}

/** Read one cookie out of a raw `Cookie` header. */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}
