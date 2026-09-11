import { createHash } from "node:crypto";
import { bearerToken } from "../../auth/credential.ts";
import type { OAuthRefresh } from "../../config/schema.ts";
import {
  resolveRefsAsync,
  type SecretProvider,
} from "../../secrets/provider/index.ts";
import {
  event,
  type ErrorKind,
  type SelfClassifyingError,
} from "../../telemetry/index.ts";

/**
 * Short-lived upstream access tokens, minted from a refresh token strad holds.
 *
 * A `remote-http` server with `oauthRefresh:` sends no static bearer. Every
 * operation asks this minter for the current access token, and the minter
 * answers from memory until the token nears its expiry, then trades the refresh
 * token for a new one at the upstream's token endpoint (RFC 6749 §6). The
 * adapter sees an ordinary `Authorization` header that happens to change, and
 * its existing fingerprint check is what rebuilds the connection when it does.
 *
 * ## One minter per server, and what it is keyed on
 *
 * The failure this design is built around is credential-shaped and silent: one
 * principal's access token sent upstream on another principal's request. Two
 * things rule it out.
 *
 *   - There is NO shared cache. The registry builds one minter per slug and hands
 *     it to that slug's endpoint thunk alone, so a token minted for `granola-a`
 *     is not reachable from `granola-b`'s code path however their configs
 *     compare — same token endpoint, same client id, it makes no difference.
 *   - Inside one minter, everything held is bound to the LINEAGE it was minted
 *     from: the client (token URL, client id, secret, scope, resource) and the
 *     refresh token the store handed over. When the store hands over a refresh
 *     token this minter has never held — a human authorized a different account
 *     and re-seeded — the held access token, any refresh in flight and any
 *     remembered failure are all dropped before the next request is served. A
 *     refresh that was already in flight for the old lineage completes into
 *     nothing: its result is never installed and never returned.
 *
 * "Never held" is the part that makes rotation work. A provider that rotates
 * refresh tokens hands back a new one on every use; the minter remembers each
 * one it was handed, so when the write-back lands and the store starts
 * returning the rotated value, that reads as its own lineage continuing rather
 * than as a re-seed.
 *
 * ## When it refreshes
 *
 *   - PROACTIVELY, `REFRESH_MARGIN_MS` before `expires_in` runs out (or a tenth
 *     of the lifetime, for a token shorter-lived than ten minutes). A token with
 *     no `expires_in` is used until the upstream refuses it.
 *   - REACTIVELY, when the upstream answers `401` to a token: the adapter calls
 *     `reject()` with the token it sent, and the next request mints. Only the
 *     token that was actually refused is dropped, so a burst of 401s on one
 *     stale token costs one refresh, not one per request. A token minted less
 *     than `REJECTION_FLOOR_MS` ago is NOT dropped: a token that fresh was not
 *     refused for its age, minting another would not help, and dropping it would
 *     let an upstream that rejects every token drive a refresh per request.
 *
 * Concurrent requests share one exchange. A failed exchange is remembered for a
 * short backoff, so an upstream whose refresh token has died is asked about it
 * once per window rather than once per request. A held token that has passed
 * its refresh point but not its expiry keeps being served through a failed
 * refresh — the upstream still accepts it, and failing a request that would
 * have succeeded helps nobody.
 *
 * ## What never leaves
 *
 * Neither token appears in an error, an event, a span or a log line. Errors are
 * strad's own sentences, built from the slug, the `${NAME}` the refresh token
 * is read from, an HTTP status and — only when it is one of the RFC's own error
 * codes — the `error` field of the token endpoint's answer. `error_description`
 * is never read: it is prose from someone else's server.
 */

/** Refresh this long before `expires_in` runs out. */
export const REFRESH_MARGIN_MS = 60_000;

/** A refused refresh is not retried for this long, unless the store changes. */
export const REFUSED_BACKOFF_MS = 60_000;

/** A token endpoint that did not answer is not retried for this long. */
export const UNAVAILABLE_BACKOFF_MS = 5_000;

/** A token minted this recently is not dropped on a 401. See the header. */
export const REJECTION_FLOOR_MS = 30_000;

/** The token endpoint's deadline. */
export const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/** How many rotated refresh tokens a minter remembers as its own. */
const OWN_LINEAGE_LIMIT = 16;

/**
 * The OAuth 2.0 error codes a token endpoint may answer with (RFC 6749 §5.2,
 * plus RFC 8707's `invalid_target`). The ONLY upstream-authored string that
 * reaches an error message, and only when it is one of these.
 */
const OAUTH_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_target",
]);

/** One refresh's inputs, with every `${NAME}` already resolved. */
export interface RefreshGrant {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  clientAuth: "basic" | "post";
  refreshToken: string;
  scope?: string;
  resource?: string;
}

/** Resolve an `oauthRefresh:` block against the server's own provider. */
export async function resolveRefreshGrant(
  block: OAuthRefresh,
  provider: SecretProvider,
): Promise<RefreshGrant> {
  const resolve = (value: string) => resolveRefsAsync(value, provider);
  const [tokenUrl, clientId, clientSecret, refreshToken, scope, resource] =
    await Promise.all([
      resolve(block.tokenUrl),
      resolve(block.clientId),
      block.clientSecret === undefined
        ? undefined
        : resolve(block.clientSecret),
      resolve(block.refreshToken),
      block.scope === undefined ? undefined : resolve(block.scope),
      block.resource === undefined ? undefined : resolve(block.resource),
    ]);
  return {
    tokenUrl,
    clientId,
    clientSecret,
    clientAuth: block.clientAuth,
    refreshToken,
    scope,
    resource,
  };
}

/** Why a refresh failed, from a closed set. Also the event's `reason`. */
export type RefreshFailure =
  /** The endpoint answered and said no: a dead refresh token, a bad client. */
  | "refused"
  /** No answer, a 5xx, a 429: a moment, not a verdict. */
  | "unavailable"
  /** A 2xx that did not carry a usable bearer token. */
  | "malformed"
  /** The config resolved to something strad will not send a token to. */
  | "misconfigured";

/**
 * A failed refresh, in strad's own words.
 *
 * Thrown out of the endpoint thunk, so it surfaces exactly where an unresolvable
 * `${NAME}` does: the slug's calls fail, its listing fails, the reachability
 * probe marks it degraded, and every other server carries on.
 */
export class TokenRefreshError extends Error implements SelfClassifyingError {
  readonly telemetryKind: ErrorKind;

  constructor(
    readonly slug: string,
    readonly variable: string,
    readonly failure: RefreshFailure,
    detail: { status?: number; oauthError?: string } = {},
  ) {
    super(describe(slug, variable, failure, detail));
    this.name = "TokenRefreshError";
    this.telemetryKind =
      failure === "unavailable" ? "upstream_unavailable" : "upstream_error";
  }
}

function describe(
  slug: string,
  variable: string,
  failure: RefreshFailure,
  detail: { status?: number; oauthError?: string },
): string {
  const lead = `server "${slug}" could not mint an upstream access token: `;
  const answer =
    detail.oauthError ??
    (detail.status === undefined ? "no answer" : `HTTP ${detail.status}`);
  switch (failure) {
    case "refused":
      if (
        detail.oauthError === "invalid_client" ||
        detail.oauthError === "unauthorized_client"
      ) {
        return (
          lead +
          `the token endpoint refused the OAuth client (${answer}). Check ` +
          `oauthRefresh.clientId and clientSecret. This server stays ` +
          `unavailable until they are fixed; no other server is affected.`
        );
      }
      return (
        lead +
        `the token endpoint refused the refresh token in \${${variable}} ` +
        `(${answer}). It has expired, been revoked, or was rotated by a ` +
        `process that could not persist the new one. Authorize again and seed ` +
        `the new refresh token as \${${variable}}; this server stays ` +
        `unavailable until then, and no other server is affected.`
      );
    case "unavailable":
      return (
        lead +
        `the token endpoint did not answer (${answer}). strad retries it ` +
        `within ${UNAVAILABLE_BACKOFF_MS / 1000}s.`
      );
    case "malformed":
      return (
        lead +
        `the token endpoint answered ${answer} without a usable bearer ` +
        `access token.`
      );
    case "misconfigured":
      return (
        lead +
        `oauthRefresh.tokenUrl must be an https URL (plain http is allowed ` +
        `only for a loopback host), so strad will not send the refresh token ` +
        `to it.`
      );
  }
}

/** What one successful exchange produced. */
interface Exchanged {
  accessToken: string;
  /** Seconds, when the endpoint said. */
  expiresIn?: number;
  /** A ROTATED refresh token, when the endpoint issued one. */
  refreshToken?: string;
}

interface Minted {
  token: string;
  mintedAt: number;
  /** When to mint the next one. Null: when the upstream refuses this one. */
  refreshAt: number | null;
  /** When this one stops working. Null: unknown. */
  expiresAt: number | null;
}

export interface MinterOptions {
  slug: string;
  /** The `${NAME}` the refresh token is read from. Never a value. */
  variable: string;
  /**
   * Persist a ROTATED refresh token where the store will hand it back. Called
   * once per rotation, serialised, and skipped for a value a later rotation or a
   * re-seed has already superseded.
   *
   * `ours` answers whether a value the store holds RIGHT NOW belongs to this
   * lineage — the seed, or a rotation this minter has held. The writer asks it
   * before overwriting: a human re-seeding another account between the
   * exchange and the write would otherwise be overwritten by the old account's
   * rotation, and the slug would silently serve the old account again. The
   * generation check inside the queue only covers a write that has not STARTED.
   *
   * Absent, the rotation lives in memory only. The registry always supplies one
   * on core; a minter without it is a test's.
   */
  persist?: (
    refreshToken: string,
    ours: (current: string) => boolean,
  ) => Promise<void>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class AccessTokenMinter {
  private readonly now: () => number;
  /** Digest of the client half of the lineage. */
  private clientKey: string | null = null;
  /** Digest of the refresh token the store handed over, as last seen. */
  private seed: string | null = null;
  /** Digests of every refresh token this lineage has held, newest last. */
  private own: string[] = [];
  /** The grant as last adopted — the client half plus the refresh token to use. */
  private grant: RefreshGrant | null = null;
  private minted: Minted | null = null;
  private inflight: Promise<string> | null = null;
  private failure: { error: TokenRefreshError; until: number } | null = null;
  /** Bumped whenever the lineage changes. What a stale exchange is judged by. */
  private generation = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly opts: MinterOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** The access token to send right now, minting one if it has to. */
  async accessToken(grant: RefreshGrant, depth = 0): Promise<string> {
    this.adopt(grant);
    const now = this.now();
    const held = this.minted;
    if (held && (held.refreshAt === null || now < held.refreshAt)) {
      return held.token;
    }
    // Past its refresh point, but the upstream still takes it. The fallback for
    // a refresh that fails; never a reason to skip trying.
    const usable =
      held && (held.expiresAt === null || now < held.expiresAt)
        ? held.token
        : null;

    if (!this.inflight && this.failure && now < this.failure.until) {
      if (usable) return usable;
      throw this.failure.error;
    }

    const generation = this.generation;
    this.inflight ??= this.refresh();
    try {
      return await this.inflight;
    } catch (err) {
      // A lineage change while the exchange ran: the answer belongs to a
      // refresh token this minter no longer holds. Ask again, for the lineage
      // that is current now. Bounded, because a store flapping between two
      // values faster than an exchange completes is a fault, not a condition.
      if (err instanceof SupersededExchange) {
        if (depth < 3 && this.grant) {
          return this.accessToken(this.grant, depth + 1);
        }
        throw new TokenRefreshError(
          this.opts.slug,
          this.opts.variable,
          "unavailable",
        );
      }
      if (usable && generation === this.generation && this.minted === held) {
        return usable;
      }
      throw err;
    }
  }

  /**
   * The upstream answered `401` to `token`. Drop it, if it is still the one held
   * and old enough that its age could be why. See the header.
   */
  reject(token: string): void {
    const held = this.minted;
    if (!held || held.token !== token) return;
    if (this.now() - held.mintedAt < REJECTION_FLOOR_MS) return;
    this.minted = null;
  }

  /** Resolves once every write-back queued so far has finished. For tests. */
  settled(): Promise<void> {
    return this.writes;
  }

  /**
   * Take the grant the store answered with, and decide whether it continues
   * the lineage held or starts a new one.
   */
  private adopt(grant: RefreshGrant): void {
    const clientKey = digest([
      grant.tokenUrl,
      grant.clientId,
      grant.clientSecret ?? "",
      grant.clientAuth,
      grant.scope ?? "",
      grant.resource ?? "",
    ]);
    const seed = digest([grant.refreshToken]);
    if (clientKey === this.clientKey) {
      if (seed === this.seed) return;
      if (this.own.includes(seed)) {
        // The store is handing back a refresh token this lineage itself was
        // issued — the write-back landing. Keep the NEWEST one held in memory:
        // a store read can trail a second rotation.
        this.seed = seed;
        return;
      }
    }
    // A different client, or a refresh token this minter was never handed:
    // another principal, or a human who authorized again. Nothing held for the
    // old lineage survives, and an exchange in flight for it completes into
    // nothing (see `refresh`).
    this.generation += 1;
    this.clientKey = clientKey;
    this.seed = seed;
    this.own = [seed];
    this.grant = grant;
    this.minted = null;
    this.inflight = null;
    this.failure = null;
  }

  private refresh(): Promise<string> {
    const generation = this.generation;
    const grant = this.grant!;
    const startedAt = this.now();
    const attempt = (async (): Promise<string> => {
      let exchanged: Exchanged;
      try {
        exchanged = await exchange(grant, this.opts);
      } catch (err) {
        if (generation !== this.generation) throw new SupersededExchange();
        const error =
          err instanceof TokenRefreshError
            ? err
            : new TokenRefreshError(
                this.opts.slug,
                this.opts.variable,
                "unavailable",
              );
        this.failure = {
          error,
          until:
            this.now() +
            (error.failure === "unavailable"
              ? UNAVAILABLE_BACKOFF_MS
              : REFUSED_BACKOFF_MS),
        };
        console.warn(`[strad] ${error.message}`);
        event({
          evt: "strad.upstream_token_refresh_failed",
          slug: this.opts.slug,
          reason: error.failure,
        });
        throw error;
      }
      if (generation !== this.generation) throw new SupersededExchange();

      this.minted = mintedFrom(exchanged, startedAt);
      this.failure = null;
      const rotated =
        exchanged.refreshToken !== undefined &&
        exchanged.refreshToken !== grant.refreshToken;
      if (rotated) this.rotate(exchanged.refreshToken!, generation);
      event({
        evt: "strad.upstream_token_refreshed",
        slug: this.opts.slug,
        rotated,
      });
      return this.minted.token;
    })();
    void attempt
      .catch(() => {})
      .finally(() => {
        if (this.inflight === attempt) this.inflight = null;
      });
    return attempt;
  }

  /**
   * Hold a rotated refresh token, and queue it for the store.
   *
   * The provider invalidated the old one when it issued this, so from here on
   * the store's copy is dead until the write lands. Writes are serialised and a
   * superseded one is skipped: two rotations in quick succession must never
   * land in the wrong order, because the older value is the dead one.
   */
  private rotate(refreshToken: string, generation: number): void {
    this.grant = { ...this.grant!, refreshToken };
    this.own = [...this.own, digest([refreshToken])].slice(-OWN_LINEAGE_LIMIT);
    const persist = this.opts.persist;
    if (!persist) return;
    // Answered against the lineage as it is when the WRITE runs, not when it
    // was queued: a later rotation is still ours.
    const ours = (current: string): boolean =>
      generation === this.generation && this.own.includes(digest([current]));
    this.writes = this.writes.then(async () => {
      if (generation !== this.generation) return;
      if (this.grant?.refreshToken !== refreshToken) return;
      // `Promise.resolve().then` so a persister that throws synchronously
      // rejects THIS step rather than poisoning the queue for every later one.
      await Promise.resolve()
        .then(() => persist(refreshToken, ours))
        .catch(() => {});
    });
  }
}

/** Internal: an exchange whose lineage was replaced while it ran. */
class SupersededExchange extends Error {
  constructor() {
    super("token exchange superseded by a new refresh token");
    this.name = "SupersededExchange";
  }
}

function mintedFrom(exchanged: Exchanged, startedAt: number): Minted {
  if (exchanged.expiresIn === undefined) {
    return {
      token: exchanged.accessToken,
      mintedAt: startedAt,
      refreshAt: null,
      expiresAt: null,
    };
  }
  // Measured from BEFORE the request went out, so the clock on the token is
  // never read as later than it is.
  const lifetime = exchanged.expiresIn * 1000;
  const margin = Math.min(REFRESH_MARGIN_MS, lifetime / 10);
  return {
    token: exchanged.accessToken,
    mintedAt: startedAt,
    refreshAt: startedAt + lifetime - margin,
    expiresAt: startedAt + lifetime,
  };
}

/** A digest, for comparing credentials without keeping a second copy around. */
function digest(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** `https:`, or `http:` to a loopback host. Nothing else gets a refresh token. */
export function tokenUrlAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/**
 * One refresh-token grant (RFC 6749 §6), as strad sends it.
 *
 * Redirects are refused rather than followed: a 307 would resend the body, and
 * the body is the refresh token.
 */
async function exchange(
  grant: RefreshGrant,
  opts: MinterOptions,
): Promise<Exchanged> {
  const fail = (
    failure: RefreshFailure,
    detail?: { status?: number; oauthError?: string },
  ) => new TokenRefreshError(opts.slug, opts.variable, failure, detail);

  if (!tokenUrlAllowed(grant.tokenUrl)) throw fail("misconfigured");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: grant.refreshToken,
  });
  if (grant.scope) body.set("scope", grant.scope);
  if (grant.resource) body.set("resource", grant.resource);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (grant.clientSecret !== undefined && grant.clientAuth === "basic") {
    // RFC 6749 §2.3.1: each half form-encoded, then joined and base64'd.
    const user = `${formEncode(grant.clientId)}:${formEncode(grant.clientSecret)}`;
    headers["authorization"] =
      `Basic ${Buffer.from(user, "utf8").toString("base64")}`;
  } else {
    body.set("client_id", grant.clientId);
    if (grant.clientSecret !== undefined) {
      body.set("client_secret", grant.clientSecret);
    }
  }

  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(grant.tokenUrl, {
      method: "POST",
      headers,
      body: body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw fail("unavailable");
  }

  const status = response.status;
  const parsed = await response.json().catch(() => null);
  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;

  if (status === 429 || status >= 500) throw fail("unavailable", { status });
  if (status < 200 || status >= 300) {
    const code = record?.error;
    throw fail("refused", {
      status,
      oauthError:
        typeof code === "string" && OAUTH_ERROR_CODES.has(code)
          ? code
          : undefined,
    });
  }

  // A 2xx that carries an RFC 6749 error is a refusal wearing the wrong status
  // — some endpoints answer that way — and naming the code beats "malformed".
  const code = record?.error;
  if (typeof code === "string" && OAUTH_ERROR_CODES.has(code)) {
    throw fail("refused", { status, oauthError: code });
  }

  const accessToken = record?.access_token;
  const tokenType = record?.token_type;
  if (
    typeof accessToken !== "string" ||
    accessToken === "" ||
    (tokenType !== undefined &&
      (typeof tokenType !== "string" || !namesBearerScheme(tokenType)))
  ) {
    throw fail("malformed", { status });
  }

  const rawExpiry = record?.expires_in;
  const expiresIn =
    typeof rawExpiry === "number"
      ? rawExpiry
      : typeof rawExpiry === "string" && /^\d+$/.test(rawExpiry)
        ? Number(rawExpiry)
        : undefined;
  // A lifetime of zero or less is a token already dead on arrival. Folding it
  // into "no expiry" would serve it until a 401, and the rejection floor would
  // then hold every call on the slug for thirty seconds per mint.
  if (
    expiresIn !== undefined &&
    !(Number.isFinite(expiresIn) && expiresIn > 0)
  ) {
    throw fail("malformed", { status });
  }
  const refreshToken = record?.refresh_token;
  return {
    accessToken,
    expiresIn,
    refreshToken:
      typeof refreshToken === "string" && refreshToken !== ""
        ? refreshToken
        : undefined,
  };
}

/**
 * Whether a `token_type` names the scheme strad sends the token under.
 *
 * RFC 6750 makes it case-insensitive, and "the Bearer scheme" is defined once,
 * by `bearerToken` — so this asks that function rather than spelling the word a
 * second time. A value carrying a space is not a scheme name at all.
 */
function namesBearerScheme(tokenType: string): boolean {
  return !/\s/.test(tokenType) && bearerToken(`${tokenType} t`) !== null;
}

/** `application/x-www-form-urlencoded`, for one Basic credential half. */
function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

/**
 * The bearer token in a header map strad SENT, whatever the header's spelling.
 *
 * Read with the one `bearerToken` every door uses (src/auth/credential.ts),
 * so what counts as a bearer is decided once for both directions.
 */
export function bearerIn(headers: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization") return bearerToken(value);
  }
  return null;
}

/**
 * The configured headers with the minted bearer as their `Authorization`.
 *
 * Any configured spelling is removed first: `fetch` folds a record into
 * `Headers` by appending, so `Authorization` beside `authorization` would go out
 * as one comma-joined value. (The schema refuses a configured one anyway.)
 */
export function withBearer(
  headers: Record<string, string>,
  token: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "authorization") out[name] = value;
  }
  out.authorization = `Bearer ${token}`;
  return out;
}
