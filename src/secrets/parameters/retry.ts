/**
 * When a parameter-store call is worth making again, and how long to wait.
 *
 * ## Why this exists
 *
 * Parameter Manager enforces a per-project, per-minute read quota, and a strad
 * deploy is exactly the workload that trips it: `check-store --resolve` reads the
 * whole store, `render-spec` reads it again seconds later, and each namespace
 * fans out. A `429` from that quota is not a fact about the store — the
 * parameter is there, the credential is right, the request was simply refused —
 * and turning one into a thrown `ParameterStoreError` aborted a production
 * deploy before `doctl` was ever called.
 *
 * So a refusal that carries no information about the resource gets tried again,
 * with a bounded budget. Everything else still fails on the first answer: a
 * `403` retried is a permission error rediscovered four times and reported one
 * backoff later, which is strictly worse than reporting it now.
 *
 * ## Why the budget is small
 *
 * The store's other invariant is that every read SETTLES (see `timeoutMs` in
 * `gcp.ts`). Retrying trades that bound for a bigger one, so the bigger one is
 * written down here rather than left to emerge: at most `attempts` tries and at
 * most `totalDelayMs` of added sleep per call. A quota that is exhausted for the
 * whole minute is not something a caller can wait out inside a deploy step, and
 * pretending otherwise turns a fast failure into a hung job.
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
 * Three retries, ~6s of sleep at the very most.
 *
 * Sized against the failure it exists for: a burst that overruns the per-minute
 * quota for a second or two, which de-synchronising a ten-wide batch is enough
 * to clear. It is deliberately NOT sized to outlast a minute-long exhaustion —
 * see the module comment.
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
 */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([
  429, 500, 502, 503, 504,
]);

/**
 * Is another attempt at this status both useful and SAFE?
 *
 * The safety half is the reason `idempotent` is a parameter. A `503` on a
 * `POST .../versions` may mean the version was written and the response lost, so
 * retrying it can add a second version to a parameter that already rotated —
 * and `create()`'s rollback would then be reasoning about a resource it did not
 * make. A `429` is different in kind: the quota layer refuses the request BEFORE
 * the service sees it, so it is effect-free whatever the method, and retrying a
 * refused write is safe.
 */
export function isRetryableStatus(
  status: number,
  idempotent: boolean,
): boolean {
  if (status === 429) return true;
  return idempotent && TRANSIENT_STATUSES.has(status);
}

/** `GET` and `DELETE` may be repeated; a `POST` here always creates something. */
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
