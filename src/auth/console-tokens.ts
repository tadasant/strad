import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { StradConfig } from "../config/schema.ts";
import type { Principal } from "./index.ts";

/**
 * The console login token: short-lived, single-use, revocable.
 *
 * What it is for. An automated actor — a CI job, an agent driving `/ui` with
 * Playwright — needs a console session, and the only non-interactive credential
 * that opens one is a STANDING one (`ADMIN_BOOTSTRAP_TOKEN`, or a human's Google
 * session). Handing the standing credential to the actor puts it in a job log, a
 * transcript or a browser context, where it outlives the task. So the standing
 * credential mints a token, and the actor exchanges it for a session:
 *
 *   mint      POST /console/tokens              -> "<jti>.<secret>", shown once
 *   exchange  POST /console/token-login  {token} -> the session cookie
 *   revoke    POST /console/tokens/<jti>/revoke -> dead, idempotent
 *
 * The token itself grants nothing but one exchange. The exchange's CONSEQUENCE
 * is a session of its own — shorter than a Google session, never renewed, and
 * ended by revoking the token that made it. That session can LOOK at every
 * console page and cannot make the console act: `refuseTokenSession` in
 * src/ui/console-auth.ts keeps it off every route that reads a stored value,
 * writes the store, or calls an upstream. Without that, thirty minutes of
 * console is enough to reveal the bootstrap token or plant an `/mcp` token,
 * and the credential that was meant to die in minutes would not.
 *
 * SINGLE-USE IS THE POINT. A failed exchange of a token this actor minted and
 * has not used is a tripwire: somebody else consumed it. A replayable token
 * cannot say that — a thief and the legitimate actor would both succeed and
 * nobody would learn anything.
 *
 * THE COMPARE-AND-SET. `exchange()` is synchronous from the lookup to the write
 * of `consumed` and the session it creates: there is no `await`, no callback and
 * no I/O between checking `status === "active"` and setting it. Node runs one
 * JavaScript turn at a time, so two exchanges of one token racing in on two
 * sockets are serialised by the event loop and exactly one of them sees
 * `active`. That is the whole atomicity argument, and it is why this module
 * imports nothing asynchronous. An `await` inside `exchange()` that yields to
 * I/O or a timer — a store behind a network hop is the realistic one — makes
 * the token replayable with nothing visibly broken. `test/console-tokens.test.ts`
 * races concurrent exchanges over pre-opened sockets to catch exactly that, and
 * separately pins that `exchange()` returns no promise at all.
 *
 * WHERE THE STATE LIVES. In this process's memory. That is sound because the
 * console is ONE process: core is rendered with `instance_count: 1`
 * (src/deploy/appspec.ts), and every config change is a deploy, which is a
 * restart, which empties the store. Every way that premise can break fails
 * CLOSED rather than open:
 *   - a restart between mint and exchange: the exchange sees an unknown token,
 *     401, no cookie — the tripwire fires, and the actor re-mints;
 *   - a restart during a session: the cookie stops resolving and the gate
 *     answers its sign-in wall;
 *   - a second core replica: a mint on A is unknown on B (401, no cookie), and a
 *     revoke that lands on the wrong replica answers 404 `unknown_token` rather
 *     than claiming a revocation it did not make.
 * Single-use survives all three, because a record lives in exactly one process
 * and is consumed there. What a shared store would buy is availability, not
 * safety — HACKS.md #91.
 *
 * AUTHORITY RIDES IN THE RECORD. The roles are the minting principal's, fixed
 * at mint (optionally narrowed, never widened), and the session carries them.
 * A token session cannot mint: a session that could mint its successor would
 * live forever, one 30-minute hop at a time.
 */

/** How long a minted token waits to be exchanged. */
export const TOKEN_TTL_MS = 10 * 60 * 1000;
/** How long the session an exchange opens lives. Absolute; never renewed. */
export const TOKEN_SESSION_TTL_MS = 30 * 60 * 1000;
/**
 * The ceiling on records held at once, live or waiting to be forgotten.
 *
 * Minting takes a standing credential, so this is not a defence against the
 * internet — it is a bound on what a loop in somebody's CI script can do to
 * core's heap.
 */
export const MAX_RECORDS = 256;

/** The exchanged session's cookie. Its value is `<sid>.<secret>`. */
export const TOKEN_SESSION_COOKIE = "strad_console_token";

/**
 * The `gateway.env` values token login may exist under. Everything else —
 * `prod`, and any name nobody wrote down here — has no routes.
 *
 * An ALLOWLIST, so a production deployment that happens to be called `prd` or
 * `live` fails closed rather than open. Exact match: ` staging ` is not
 * `staging`.
 *
 * `gateway.env` rather than `NODE_ENV`, deliberately: staging runs
 * `NODE_ENV=production` (src/auth/dev.ts), and staging is the one environment
 * this exists for. `gateway.env` is also what binds every `/mcp` token
 * (`strad_<env>_…`, src/auth/tokens.ts), so a production deployment that claimed
 * to be `staging` would reject its own agents' tokens — the claim cannot be
 * wrong quietly.
 */
export const TOKEN_LOGIN_ENVS: ReadonlySet<string> = new Set([
  "dev",
  "local",
  "test",
  "staging",
]);

export interface ConsoleTokenLoginStatus {
  active: boolean;
  reason: string;
}

/**
 * Whether the three routes exist on this deployment.
 *
 * Two locks: the config flag, and a `gateway.env` in `TOKEN_LOGIN_ENVS`. The
 * flag defaults off, so a config that never mentions this has no routes. The
 * second lock is not configurable at all — there is no acknowledgement that
 * turns it on in prod, because the issue this closes (tadasant/strad#43) asks
 * for automation to be unable to token-login to prod, full stop.
 *
 * It does NOT depend on the dev bypass. The bypass is scheduled for deletion
 * (tadasant/strad#6), and this is the automated path meant to outlive it.
 */
export function consoleTokenLoginStatus(
  cfg: StradConfig,
): ConsoleTokenLoginStatus {
  if (!cfg.auth.consoleTokenLogin.enabled) {
    return { active: false, reason: "auth.consoleTokenLogin.enabled is false" };
  }
  if (!TOKEN_LOGIN_ENVS.has(cfg.gateway.env)) {
    return {
      active: false,
      reason:
        `gateway.env is "${cfg.gateway.env}", and token login exists only under ` +
        [...TOKEN_LOGIN_ENVS].join(", "),
    };
  }
  return { active: true, reason: "active" };
}

export type TokenStatus = "active" | "consumed" | "revoked";

/** Who minted a token. Never a secret; safe to log and to show. */
export interface Minter {
  kind: Principal["kind"];
  id: string;
  label: string;
}

export interface ConsoleTokenRecord {
  /** Public lookup key: 16 hex characters. Safe to log. */
  jti: string;
  /** hex SHA-256 of the secret half. The plaintext is never stored. */
  secretHash: string;
  principal: Minter;
  /** The session's roles, fixed at mint. */
  roles: string[];
  status: TokenStatus;
  /** Epoch ms. Past it, an `active` token no longer exchanges. */
  expiresAt: number;
  createdAt: number;
  consumedAt?: number;
  revokedAt?: number;
  /** The session this token was exchanged for, once it has been. */
  session?: TokenSession;
}

interface TokenSession {
  sid: string;
  secretHash: string;
  expiresAt: number;
  /** Set by revoke or logout. An ended session never resolves again. */
  endedAt?: number;
}

export interface LiveTokenSession {
  principal: Principal;
  /** Epoch ms. Absolute; nothing extends it. */
  expiresAt: number;
}

export interface MintedConsoleToken {
  /** `<jti>.<secret>`. Returned once, never persisted. */
  token: string;
  record: ConsoleTokenRecord;
}

/** Why an exchange did not happen, from the caller's side. */
export type ExchangeRefusal =
  /** Garbled, unknown, or the secret half is wrong. Nothing is disclosed. */
  | "invalid_token"
  /** A real token that has already been exchanged. The tripwire. */
  | "token_consumed"
  | "token_revoked"
  | "token_expired";

export type ExchangeResult =
  | {
      ok: true;
      record: ConsoleTokenRecord;
      /** The session cookie's value: `<sid>.<secret>`. */
      cookie: string;
      /** Epoch ms; the cookie's Max-Age is measured to it. */
      expiresAt: number;
    }
  | {
      ok: false;
      reason: ExchangeRefusal;
      /**
       * The record, when the secret verified. A refusal that carries one was
       * presented by somebody holding the real token — that is what makes it a
       * security signal rather than noise.
       */
      record?: ConsoleTokenRecord;
    };

export type RevokeResult =
  | { found: false }
  | {
      found: true;
      record: ConsoleTokenRecord;
      /** True when this call ended a session that was still live. */
      endedSession: boolean;
    };

const JTI_BYTES = 8;
const SECRET_BYTES = 32;
const JTI_RE = /^[0-9a-f]{16}$/;
// 32 bytes of base64url, unpadded.
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
// A well-formed digest no secret hashes to, so an unknown jti costs the same
// hash-and-compare a known one does. See verifyToken() in src/auth/tokens.ts.
const DUMMY_HASH = "0".repeat(64);

export class StoreFull extends Error {
  constructor() {
    super(`${MAX_RECORDS} console tokens are already held`);
  }
}

export class ConsoleTokenStore {
  private readonly byJti = new Map<string, ConsoleTokenRecord>();
  /** sid -> jti, so a session cookie resolves in O(1). */
  private readonly bySid = new Map<string, string>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** How many records are held, forgotten ones excluded. For tests and boot logs. */
  get size(): number {
    this.prune();
    return this.byJti.size;
  }

  mint(principal: Principal, roles: string[]): MintedConsoleToken {
    this.prune();
    if (this.byJti.size >= MAX_RECORDS) throw new StoreFull();

    const now = this.now();
    let jti = randomBytes(JTI_BYTES).toString("hex");
    while (this.byJti.has(jti)) jti = randomBytes(JTI_BYTES).toString("hex");
    const secret = randomBytes(SECRET_BYTES).toString("base64url");

    const record: ConsoleTokenRecord = {
      jti,
      secretHash: sha256(secret),
      principal: {
        kind: principal.kind,
        id: principal.id,
        label: principal.label,
      },
      roles: [...roles],
      status: "active",
      expiresAt: now + TOKEN_TTL_MS,
      createdAt: now,
    };
    this.byJti.set(jti, record);
    return { token: `${jti}.${secret}`, record };
  }

  /**
   * The compare-and-set, and the session it opens.
   *
   * SYNCHRONOUS, and it must stay that way — see the header. Everything from the
   * lookup to `status = "consumed"` and the session write happens in one turn.
   */
  exchange(presented: string): ExchangeResult {
    const verified = this.verify(presented);
    if (!verified) return { ok: false, reason: "invalid_token" };

    const now = this.now();
    const record = verified;
    if (record.status === "consumed") {
      return { ok: false, reason: "token_consumed", record };
    }
    if (record.status === "revoked") {
      return { ok: false, reason: "token_revoked", record };
    }
    if (record.expiresAt <= now) {
      return { ok: false, reason: "token_expired", record };
    }

    // The set. Nothing between the `active` check above and this line yields.
    record.status = "consumed";
    record.consumedAt = now;

    let sid = randomBytes(JTI_BYTES).toString("hex");
    while (this.bySid.has(sid)) sid = randomBytes(JTI_BYTES).toString("hex");
    const secret = randomBytes(SECRET_BYTES).toString("base64url");
    const expiresAt = now + TOKEN_SESSION_TTL_MS;
    record.session = { sid, secretHash: sha256(secret), expiresAt };
    this.bySid.set(sid, record.jti);

    return { ok: true, record, cookie: `${sid}.${secret}`, expiresAt };
  }

  /**
   * Burn a token that arrived somewhere it must not: a URL, which lands in
   * access logs and `Referer`. An `active` token that verifies is revoked.
   * `burned` says whether this call did that — a token already consumed or
   * revoked is returned untouched, so the caller can say which.
   */
  burn(
    presented: string,
  ): { record: ConsoleTokenRecord; burned: boolean } | null {
    const record = this.verify(presented);
    if (!record) return null;
    if (record.status !== "active") return { record, burned: false };
    record.status = "revoked";
    record.revokedAt = this.now();
    return { record, burned: true };
  }

  /**
   * The jti of a presented token, if its secret verifies. Possession of the
   * whole token is what lets the actor revoke it without a standing
   * credential — see the revoke route.
   */
  possessed(presented: string): string | null {
    return this.verify(presented)?.jti ?? null;
  }

  /**
   * Revoke by jti. Idempotent.
   *
   * An `active` token becomes `revoked`. A `consumed` one stays consumed — it
   * WAS used, and the record should keep saying so — but the session it was
   * exchanged for is ended. That is the other half of the tripwire: an actor
   * whose exchange failed because somebody else consumed its token revokes the
   * jti, and the somebody else is signed out.
   */
  revoke(jti: string): RevokeResult {
    this.prune();
    const record = JTI_RE.test(jti) ? this.byJti.get(jti) : undefined;
    if (!record) return { found: false };

    const now = this.now();
    if (record.status === "active") {
      record.status = "revoked";
      record.revokedAt = now;
    }
    const endedSession = this.end(record, now);
    return { found: true, record, endedSession };
  }

  /** The live session a cookie value stands for, or null. Synchronous. */
  session(cookieValue: string | undefined): LiveTokenSession | null {
    const record = this.resolveSession(cookieValue);
    const s = record?.session;
    if (!record || !s) return null;
    return {
      principal: {
        kind: "console-token",
        id: record.jti,
        label: `token ${record.jti} · minted by ${record.principal.label}`,
        roles: [...record.roles],
      },
      expiresAt: s.expiresAt,
    };
  }

  /** Sign-out: end the session behind a cookie. True if one was live. */
  endSession(cookieValue: string | undefined): boolean {
    const record = this.resolveSession(cookieValue);
    if (!record) return false;
    return this.end(record, this.now());
  }

  private end(record: ConsoleTokenRecord, now: number): boolean {
    const s = record.session;
    if (!s || s.endedAt !== undefined || s.expiresAt <= now) return false;
    s.endedAt = now;
    return true;
  }

  private resolveSession(
    cookieValue: string | undefined,
  ): ConsoleTokenRecord | null {
    const parsed = split(cookieValue);
    if (!parsed) return null;
    const jti = this.bySid.get(parsed.id);
    const record = jti ? this.byJti.get(jti) : undefined;
    const s = record?.session;
    const matches = hashesEqual(sha256(parsed.secret), s?.secretHash);
    if (!record || !s || !matches) return null;
    if (s.endedAt !== undefined) return null;
    if (s.expiresAt <= this.now()) return null;
    return record;
  }

  /** The record a presented token names, if its secret half is right. */
  private verify(presented: string): ConsoleTokenRecord | null {
    const parsed = split(presented);
    if (!parsed) return null;
    const record = this.byJti.get(parsed.id);
    // Hash and compare whether or not the jti exists, so which jtis exist is
    // not a timing measurement away.
    const matches = hashesEqual(sha256(parsed.secret), record?.secretHash);
    return record && matches ? record : null;
  }

  /**
   * Forget records whose token has expired and whose session (if any) would
   * have. Revoking or consuming a token does not shorten that: the record is
   * what answers a replay with `token_consumed` rather than `invalid_token`, and
   * what a second revoke finds, for as long as the token could have been in
   * play.
   */
  private prune(): void {
    const now = this.now();
    for (const [jti, r] of this.byJti) {
      const s = r.session;
      if (r.expiresAt <= now && (!s || s.expiresAt <= now)) {
        this.byJti.delete(jti);
        if (s) this.bySid.delete(s.sid);
      }
    }
  }
}

/**
 * Every substring of `text` shaped like a login token, `<16 hex>.<43 base64url>`.
 * Shape only — nothing here says a match is a token this process minted; the
 * store's `burn()` decides that by verifying the secret.
 */
export function tokensIn(text: string): string[] {
  return [...text.matchAll(/[0-9a-f]{16}\.[A-Za-z0-9_-]{43}/g)].map(
    (m) => m[0],
  );
}

function split(
  value: string | undefined,
): { id: string; secret: string } | null {
  if (typeof value !== "string") return null;
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const id = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  if (!JTI_RE.test(id) || !SECRET_RE.test(secret)) return null;
  return { id, secret };
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function hashesEqual(a: string, b: string | undefined): boolean {
  const expected = b ?? DUMMY_HASH;
  if (a.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(expected, "utf8"));
}
