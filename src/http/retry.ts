/**
 * When an HTTP call is worth making again, and how long to wait.
 *
 * ## Why this exists
 *
 * A response can refuse a request without saying anything about the resource.
 * A `429` means the quota layer declined to ask; a `503` means the server was
 * not ready to answer. Neither is a fact a caller can act on, and turning one
 * into a thrown error is how a working system reports someone else's bad
 * second as its own failure.
 *
 * The incident that produced this module is the shape to keep in mind.
 * Parameter Manager enforces a per-project, per-minute read quota, and a strad
 * deploy is exactly the workload that trips it: `check-store --resolve` reads
 * the whole store, `render-spec` reads it again seconds later, and each
 * namespace fans out. One `429` out of that burst aborted a production deploy
 * before `doctl` was ever called. The registry walk in
 * `src/deploy/imageTag.ts` is the same shape against a different service — up
 * to 50 sequential `HEAD`s at one GHCR repository, which is precisely what
 * provokes a rate limit.
 *
 * So a refusal that carries no information about the resource gets tried again,
 * with a bounded budget. Everything else still fails on the first answer: a
 * `403` retried is a permission error rediscovered four times and reported one
 * backoff later, which is strictly worse than reporting it now.
 *
 * ## Why the budget is a caller's to size
 *
 * Retrying trades a bound the caller already had — every call SETTLES — for a
 * bigger one, so the bigger one is written down rather than left to emerge: at
 * most `attempts` tries and at most `totalDelayMs` of added sleep per call. A
 * quota that is exhausted for the whole minute is not something a caller can
 * wait out inside a deploy step, and pretending otherwise turns a fast failure
 * into a hung job.
 *
 * `DEFAULT_RETRY_BUDGET` is sized for ONE call. A caller that makes the same
 * call fifty times in a row multiplies it, and should say what it chose and
 * why — `REGISTRY_RETRY_BUDGET` in `src/deploy/imageTag.ts` is the worked
 * example.
 */

/** The bound on one call's retrying. Every field is a ceiling, not a target. */
export interface RetryBudget {
  /** Total tries including the first. `1` disables retrying. */
  attempts: number;
  /** The exponential's first term. Doubles per retry. */
  baseDelayMs: number;
  /** Ceiling on any single sleep. */
  maxDelayMs: number;
  /** Ceiling on the SUM of the sleeps in one call. */
  totalDelayMs: number;
}

/**
 * Three retries: at most 2.8s of backoff, under a 6s ceiling on everything.
 *
 * The two numbers bound different things. Left to the exponential the terms are
 * 400ms, 800ms and 1600ms, so three retries sleep 2.8s and no more —
 * `maxDelayMs` never binds on THIS budget, and is there to cap a caller who
 * widens `baseDelayMs` or `attempts`. `totalDelayMs` is the ceiling a
 * server-named `Retry-After` is measured against, which is the only way one call
 * reaches six seconds.
 *
 * Sized against the failure it exists for: a burst that overruns a per-minute
 * quota for a second or two, which de-synchronising a ten-wide batch is enough
 * to clear. It is deliberately NOT sized to outlast a minute-long exhaustion —
 * see the module comment. It is also sized for ONE call: a caller that repeats
 * the same call dozens of times in a row is multiplying these numbers and owes
 * itself a budget of its own.
 */
export const DEFAULT_RETRY_BUDGET: RetryBudget = {
  attempts: 4,
  baseDelayMs: 400,
  maxDelayMs: 3_000,
  totalDelayMs: 6_000,
};

/**
 * The statuses that say "not now" rather than "not ever".
 *
 * `429` is the quota refusal this exists for. The 5xx set is the transient
 * server-side family — a retry is the documented response to all four.
 *
 * Everything outside the set fails on the first answer, including the statuses
 * that merely sound temporary. A `501` is a permanent "this server does not do
 * that", and a `408` is a request the server gave up READING — repeating it
 * would need the caller to know the body was never delivered, which nothing
 * here knows. Widening this set is a decision about somebody's failure mode;
 * make it deliberately, not because a status looked transient.
 */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([
  429, 500, 502, 503, 504,
]);

/**
 * Is another attempt at this status both useful and SAFE?
 *
 * The safety half is the reason `idempotent` is a parameter, and it gates EVERY
 * status including `429`. A refusal that reaches us from a fronting proxy may
 * have been emitted AFTER the backend applied the write, and nothing in the
 * response distinguishes that from a quota layer refusing the request before the
 * service ever saw it. Retrying a `POST` on either turns a write that landed
 * into a `409 ALREADY_EXISTS`, and a caller that reads `409` as "not mine"
 * unwinds the wrong half of its own rollback: the parameter store's `create()`
 * skips the parameter rollback, deletes the backing secret it DID make, and
 * strands a versionless parameter that `destroy()` cannot remove.
 *
 * Both paths this exists for are every-request-a-`GET`, so nothing is given up
 * by drawing the line here.
 */
export function isRetryableStatus(
  status: number,
  idempotent: boolean,
): boolean {
  return idempotent && TRANSIENT_STATUSES.has(status);
}

/** `GET`, `HEAD` and `DELETE` may be repeated; a `POST` creates something. */
export function isIdempotentMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "DELETE";
}

/**
 * `Retry-After` as a delay in ms, or `undefined` when the header is absent or
 * unintelligible.
 *
 * Both RFC forms are accepted: delta-seconds (`Retry-After: 30`) and an HTTP
 * date (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`). A date already in the
 * past is `0`, not a negative sleep.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

export interface DelayInput {
  /** Zero-based index of the attempt that just failed. */
  attempt: number;
  /** Sleep already spent on this call. */
  spentMs: number;
  /** `Retry-After` in ms, if the response carried one. */
  retryAfterMs?: number;
  budget: RetryBudget;
  /** Injectable for tests. Returns `[0, 1)`. */
  random?: () => number;
}

/**
 * How long to sleep before the next attempt, or `undefined` to give up.
 *
 * Exponential backoff with EQUAL jitter — half the term is fixed, half is
 * random. Full jitter would let a sleep round to nothing, which is neither a
 * backoff nor something a test can assert; equal jitter keeps a floor while
 * still scattering a ten-wide batch that all got refused in the same
 * millisecond.
 *
 * `Retry-After` is honoured VERBATIM rather than clamped down: a server that
 * names a delay is telling us when it will answer, and sleeping less than that
 * is a request we already know will be refused. It is still checked against the
 * remaining budget — a `Retry-After: 60` on a 6s budget gives up NOW, because
 * the alternative is sleeping past the bound this module exists to hold.
 */
export function retryDelayMs(input: DelayInput): number | undefined {
  const { attempt, spentMs, retryAfterMs, budget } = input;
  const random = input.random ?? Math.random;

  if (attempt + 1 >= budget.attempts) return undefined;

  const remaining = budget.totalDelayMs - spentMs;
  if (remaining <= 0) return undefined;

  if (retryAfterMs !== undefined) {
    return retryAfterMs <= remaining ? retryAfterMs : undefined;
  }

  const term = Math.min(budget.maxDelayMs, budget.baseDelayMs * 2 ** attempt);
  const jittered = Math.round(term / 2 + random() * (term / 2));
  return jittered <= remaining ? jittered : undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
