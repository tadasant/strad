import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import {
  CONSOLE_SESSION_DEFAULTS,
  type StradConfig,
} from "../config/schema.ts";
import { secretEquals } from "./credential.ts";
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
 *   - two clocks from `auth.google.session`. A SLIDING window: a cookie past
 *     half of it is re-issued by the console gate, so an active human stays
 *     signed in and an idle cookie dies. And an ABSOLUTE cap, counted from the
 *     Google sign-in (`authAt`), which renewal copies forward and never moves.
 *     Renewal is what lets a stolen cookie that keeps being used keep itself
 *     alive; the cap is what stops that being forever, which is why it is
 *     checked on every read and has no off switch. Both are read from the
 *     CURRENT config, so changing either applies to sessions already issued;
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
/** The connector consent flow. See ConsoleSessions.connector. */
const INFO_CONNECTOR = "strad.connector.oauth-tx.v1";

/** The signed Google session. */
export const SESSION_COOKIE = "strad_console_session";
/** The in-flight OAuth transaction: PKCE verifier + state + return path. */
export const OAUTH_TX_COOKIE = "strad_oauth_tx";

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
  /** When THIS cookie was sealed, epoch ms. Renewal moves it. */
  iat: number;
  /**
   * When the human signed in with Google, epoch ms: the instant the absolute cap
   * counts from. Renewal copies it forward unchanged.
   *
   * Absent on a cookie sealed before renewal existed. Such a cookie was never
   * renewed, so its `iat` IS its sign-in, and `signedInAt()` reads it that way —
   * a legacy cookie is capped from `iat`, never uncapped.
   */
  authAt?: number;
  /**
   * The expiry this cookie was minted with, epoch ms: `iat` plus the sliding
   * window, never later than `authAt` plus the absolute cap. The current config
   * can end it sooner; see `sessionDeadline()`.
   */
  exp: number;
}

/** The session's two clocks, in ms. See `auth.google.session`. */
export interface SessionWindows {
  slidingMs: number;
  absoluteMs: number;
}

export function sessionWindows(cfg: StradConfig): SessionWindows {
  const s = cfg.auth.google?.session ?? CONSOLE_SESSION_DEFAULTS;
  return {
    slidingMs: s.slidingTtlSeconds * 1000,
    absoluteMs: s.absoluteTtlSeconds * 1000,
  };
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
  unseal<T extends { v: 1; exp: number }>(
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
    // The version tag exists so a future v2 payload cannot be read as a v1 one
    // under the same key. Enforcing it is what makes it worth carrying.
    if (payload.v !== 1) return null;
    return payload;
  }

  private mac(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }
}

export interface ConsoleSessions {
  session: Sealer;
  tx: Sealer;
  /**
   * The CONNECTOR authorization transaction — a human consenting, in the
   * console, to hand one server slug a credential for their Google account.
   *
   * A third derived key rather than a reuse of `tx`, on the same reasoning that
   * separates `tx` from `session`: the two flows return different things from
   * different OAuth clients, and a sealed value from one must be unforgeable
   * garbage to the other. Reusing `tx` would let a console LOGIN transaction be
   * presented as a connector transaction, whose payload names the slug and the
   * parameter the callback writes.
   *
   * It hangs off this interface so there is ONE answer to "does this deployment
   * have usable key material": a connector that could mint transactions on a
   * deployment whose console cannot verify a session would be a flow nobody can
   * start. See src/connectors/state.ts.
   */
  connector: Sealer;
}

/**
 * The shortest key material we will derive from.
 *
 * HKDF spreads its input over 32 bytes but does not create entropy: the cookie
 * format is public in this file, so a weak key is brute-forced offline against
 * any cookie the attacker already holds, and forging one is then trivial. A
 * Google client secret is 35 characters, comfortably clear of this.
 */
const MIN_KEY_CHARS = 24;

/**
 * Build the sealers, or null when there is no usable key material.
 *
 * Null is a hard "no console session can exist" — the gate must then not offer
 * a Google sign-in it cannot complete. Failing closed on a SHORT key matters as
 * much as failing closed on a missing one: `CONSOLE_SESSION_SECRET=dev` would
 * otherwise sign sessions an attacker can forge outright.
 */
export function consoleSessionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ConsoleSessions | null {
  const ikm = env.CONSOLE_SESSION_SECRET || env.GOOGLE_CLIENT_SECRET;
  if (!ikm || ikm.length < MIN_KEY_CHARS) return null;
  return {
    session: new Sealer(ikm, INFO_SESSION),
    tx: new Sealer(ikm, INFO_TX),
    connector: new Sealer(ikm, INFO_CONNECTOR),
  };
}

/** Why `consoleSessionsFromEnv` returned null, for the boot warning. */
export function sessionKeyProblem(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const ikm = env.CONSOLE_SESSION_SECRET || env.GOOGLE_CLIENT_SECRET;
  if (!ikm) {
    return "no session key (set CONSOLE_SESSION_SECRET or GOOGLE_CLIENT_SECRET)";
  }
  if (ikm.length < MIN_KEY_CHARS) {
    return `the session key is shorter than ${MIN_KEY_CHARS} characters and is refused as forgeable`;
  }
  return null;
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
  now: number = Date.now(),
): Principal | null {
  const google = cfg.auth.google;
  if (!google?.enabled) return null;
  // The MAC proves we sealed it; it does not prove the shape, and a Principal
  // built from a missing field would be a nameless one.
  if (typeof payload.sub !== "string" || payload.sub === "") return null;
  if (typeof payload.email !== "string" || payload.email === "") return null;
  // The check that mattered at sign-in still has to hold. Re-pointing the
  // deployment at another Workspace must not leave the old one signed in.
  if (payload.hd !== google.hostedDomain) return null;
  // The sealer checked `exp`, which is only the lifetime the cookie was minted
  // with. The cap and the window are the ones THIS config sets.
  const deadline = sessionDeadline(payload, sessionWindows(cfg));
  if (deadline === null || deadline <= now) return null;

  return {
    kind: "google",
    id: payload.sub,
    label: payload.email,
    roles: google.roles,
  };
}

/**
 * When the human behind this session signed in, or null when the payload cannot
 * say. A session that cannot say when it began is refused, never left uncapped.
 */
function signedInAt(payload: ConsoleSessionPayload): number | null {
  if (!Number.isFinite(payload.iat)) return null;
  // Absent, and only absent, is a legacy cookie. A `null` or a string is a
  // payload strad never sealed, and reading it as legacy would hand it a cap.
  const at = payload.authAt === undefined ? payload.iat : payload.authAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  // Renewal only ever moves `iat` forward from the sign-in.
  if (at > payload.iat) return null;
  return at;
}

/**
 * The instant this session stops being accepted under the given clocks, or null
 * when the payload cannot say. The earliest of three:
 *   - the cookie's own `exp`, which is what it was minted with;
 *   - `iat` plus the sliding window, so shortening it applies to cookies already
 *     issued rather than to the next sign-in;
 *   - the sign-in plus the absolute cap: the one no renewal moves.
 */
export function sessionDeadline(
  payload: ConsoleSessionPayload,
  windows: SessionWindows,
): number | null {
  const at = signedInAt(payload);
  if (at === null) return null;
  return Math.min(
    payload.exp,
    payload.iat + windows.slidingMs,
    at + windows.absoluteMs,
  );
}

export function issueSessionCookie(
  res: Response,
  sealer: Sealer,
  identity: { sub: string; email: string; hd: string; name?: string },
  windows: SessionWindows,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): void {
  setSessionCookie(
    res,
    sealer,
    {
      v: 1,
      sub: identity.sub,
      email: identity.email,
      hd: identity.hd,
      ...(identity.name ? { name: identity.name } : {}),
      iat: now,
      authAt: now,
      exp: now + Math.min(windows.slidingMs, windows.absoluteMs),
    },
    env,
    now,
  );
}

/**
 * Re-issue a live session once less than half its sliding window is left, so an
 * active human is never signed out on a fixed clock. One `Set-Cookie` on an
 * ordinary response, and no server-side state: any replica can renew a cookie
 * any other replica sealed.
 *
 * The identity and `authAt` are copied forward. Only `iat` and `exp` move, and
 * `exp` never past the absolute cap — so near the cap this does nothing, rather
 * than re-sending a cookie that cannot live any longer on every request.
 *
 * Returns whether it renewed. The caller has already accepted the payload
 * through `principalFromSession`; a payload that is not live is refused here
 * too, so the order of the two calls cannot turn a dead session into a live one.
 */
export function renewSessionIfDue(
  res: Response,
  sealer: Sealer,
  payload: ConsoleSessionPayload,
  windows: SessionWindows,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): boolean {
  const at = signedInAt(payload);
  const deadline = sessionDeadline(payload, windows);
  if (at === null || deadline === null || deadline <= now) return false;
  if (deadline - now >= windows.slidingMs / 2) return false;

  const exp = Math.min(now + windows.slidingMs, at + windows.absoluteMs);
  if (exp <= deadline) return false;

  setSessionCookie(
    res,
    sealer,
    {
      v: 1,
      sub: payload.sub,
      email: payload.email,
      hd: payload.hd,
      ...(payload.name ? { name: payload.name } : {}),
      iat: now,
      authAt: at,
      exp,
    },
    env,
    now,
  );
  return true;
}

function setSessionCookie(
  res: Response,
  sealer: Sealer,
  payload: ConsoleSessionPayload,
  env: NodeJS.ProcessEnv,
  now: number,
): void {
  res.cookie(SESSION_COOKIE, sealer.seal(payload), {
    ...cookieFlags(env),
    // Scoped to "/" because the gate covers the splash at "/" as well as the
    // console's own pages.
    // It therefore rides along to /mcp, which is inert: /mcp authenticates the
    // Authorization header against the static token store and never reads a
    // cookie (HACKS.md #2).
    path: "/",
    // The browser forgets it when strad would stop accepting it.
    maxAge: payload.exp - now,
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
 * withholds it from cross-site POSTs, which is what protects the console writes.
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
 *
 * `secretEquals` is the compare; the one thing added here is that two EMPTY
 * states do not match. A callback with no `state` and a transaction that sealed
 * none are two absences, not a proof that they belong together.
 */
export function stateMatches(a: string, b: string): boolean {
  return a !== "" && secretEquals(a, b);
}

/**
 * Where to send the human after sign-in.
 *
 * Only a same-origin, absolute path survives. Anything else — a scheme-relative
 * `//evil.example`, a full URL, a backslash the browser normalises to a slash —
 * becomes `/connectors`, the console's working surface. An open redirect on a
 * login callback is how a phishing page borrows your domain's trust.
 */
export function sanitizeNext(raw: unknown, fallback = "/connectors"): string {
  if (typeof raw !== "string" || raw === "") return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (raw.includes("\\")) return fallback;
  // Every C0 control and DEL, not just CR/LF: a browser strips TAB, LF, FF and
  // CR while parsing a URL, so `/<TAB>/evil.example` would resolve as
  // `//evil.example`. Express's encodeUrl() happens to escape them on the way
  // out, but the guard should not lean on a downstream layer.
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return fallback;
  }
  return raw;
}

/**
 * Every value sent under `name`, in header order.
 *
 * ALL of them, not the first: anything that can set a cookie on a sibling
 * subdomain can send `Domain=.strad.tadasant.com; Path=/ui`, and RFC 6265 orders
 * the longer path first. Taking only the first would let that shadow the real
 * session — not a forgery, since the shadow cannot pass the MAC, but a lockout
 * the human cannot clear without emptying their cookie jar. Callers try each and
 * keep the one that verifies.
 *
 * The value is attacker-controlled and `decodeURIComponent` throws a URIError on
 * a stray `%`. Unhandled, that is a 500 from the gate and — on the async callback
 * route, which Express 4 does not catch — an unhandled rejection that takes the
 * process down. An undecodable value is passed through raw instead; nothing
 * downstream trusts it either way.
 */
export function readCookies(
  header: string | undefined,
  name: string,
): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out.push(decodeURIComponent(raw));
    } catch {
      out.push(raw);
    }
  }
  return out;
}

/** The first value under `name` that this sealer accepts, or null. */
export function unsealCookie<T extends { v: 1; exp: number }>(
  sealer: Sealer,
  header: string | undefined,
  name: string,
): T | null {
  for (const value of readCookies(header, name)) {
    const payload = sealer.unseal<T>(value);
    if (payload) return payload;
  }
  return null;
}
