/**
 * A single-flighted, last-known-good view of one named map over a resolver.
 *
 * Two callers need exactly this and would otherwise each grow their own copy:
 *
 *   - `StoreSecretProvider`, over one namespace, so `${NAME}` resolution on the
 *     request path survives a resolver that has started failing.
 *   - the registry, over a `params: true` server's namespace, so a builtin's
 *     options can be re-resolved per tool call with the same property.
 *
 * It holds NO TTL. How long a value may be reused is decided one layer down, by
 * the resolver's own snapshot (`gateway.secrets.ttlSeconds`, see
 * parameters/gcp.ts): every `get` asks the resolver, and the resolver answers
 * from what it holds or reads the store, on its own clock. A second timer here
 * would only smear that bound — a rotation could land anywhere up to twice the
 * TTL depending on which timer expired first — and would give the operator two
 * knobs for one decision. So this class is about what happens when the
 * resolver THROWS, and nothing else.
 *
 * ## Failure posture
 *
 * A read that throws does NOT propagate if a previous value is held: the last
 * known good map is served and the caller is warned. A secret store going down
 * must not take the gateway down with it — trading "secrets are stale" for "the
 * gateway is offline" is the worse deal by a wide margin. The retry is backed
 * off, so an outage costs one failed read per `FAILURE_BACKOFF_MS`, not per
 * request.
 *
 * With nothing held, a failed read is tried again before it is believed. There
 * are exactly two ways to hold nothing: a cold start, and the moment after an
 * `invalidate` — which every secret write makes, including the OAuth refresh
 * write-back a fresh pod runs seconds after boot. Without the retry, one
 * transient failure there is the whole answer: the gateway's token store reads
 * through this class, so a single bad read right after a write would fail
 * `/mcp` with a 500 (tadasant/strad#523). The retry is bounded on every side:
 *
 *   - `COLD_RETRY_BUDGET` caps the attempts and the sleeps.
 *   - No retry starts once `COLD_RETRY_DEADLINE_MS` has passed since the first
 *     attempt did. A read that hung to its own timeout, or that the store
 *     client already spent its own backoff retrying, is not repeated — only a
 *     read that failed FAST is.
 *   - A status that says "not ever" (a `403`, a `404`, a `400` render
 *     failure) is not retried: asking again rediscovers it.
 *   - After a nothing-held read has failed, the next reads inside
 *     `FAILURE_BACKOFF_MS` each make one attempt and no retry, so an outage
 *     with nothing held costs one read per request, not three.
 *   - A retry stops once an `invalidate` has superseded the read; `get` reads
 *     again against the post-write state.
 *
 * Once the budget is spent the error DOES propagate. There is nothing to serve,
 * and reporting an empty namespace would turn an outage into a silent
 * misconfiguration — and for the token store, failing closed is the point.
 *
 * The pre-`invalidate` map is deliberately NOT kept as a fallback for that
 * case. The read that follows a write is the one that has to see it: serving
 * the map from before a revocation, because the read after it failed, would
 * admit the token the operator was just told is revoked.
 */

import { errorSummary } from "../../util/error-text.ts";
import {
  isRetryableStatus,
  type RetryBudget,
  retryDelayMs,
  sleep,
} from "../../http/retry.ts";

export interface NamespaceViewOptions {
  /** Injected in tests so the clock is not the thing under test. */
  now?: () => number;
  /** Injected in tests to assert we never log a value. */
  onWarn?: (message: string) => void;
  /** Prefixes a warning so it names the subsystem. Never carries a value. */
  label?: string;
  /** Injected in tests so a backoff does not have to be slept through. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests so the jitter is fixed. Returns `[0, 1)`. */
  random?: () => number;
}

interface Entry {
  values: Record<string, string>;
  fetchedAt: number;
  /** Set while a read is in flight, so concurrent readers share one read. */
  inflight?: Promise<void>;
  /** Identity of the in-flight refresh, so it only clears its own. */
  token?: object;
  /** Bumped by `invalidate`; a read started earlier will not commit. */
  generation: number;
  /** When the last read failed, so an outage is not retried per request. */
  lastFailureAt?: number;
}

/** How long a failed read is not retried, with the last good map served instead. */
const FAILURE_BACKOFF_MS = 5_000;

/**
 * Three tries for a read with nothing held: sleeps of 100–200ms and 200–400ms,
 * at most 600ms in all. `maxDelayMs` and `totalDelayMs` never bind at these
 * terms; they are ceilings, there so a widened `baseDelayMs` cannot outgrow
 * them.
 *
 * Sized for the failure it exists for — one bad response from the store in a
 * burst, the shape of #523 — and paid only when a read FAILS with nothing to
 * fall back on, which is on the request path of whoever is waiting. It is not
 * sized to ride out an outage; the store client already retries the statuses
 * that say "not now" (see `src/http/retry.ts`), and this covers what escapes
 * it fast: a reset connection, a failed token exchange, one 5xx too many.
 */
const COLD_RETRY_BUDGET: RetryBudget = {
  attempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 1_000,
  totalDelayMs: 1_000,
};

/**
 * No retry STARTS later than this after the first attempt did.
 *
 * Well below the store client's own per-request timeout (10s,
 * parameters/gcp.ts) and below the 2.8s of backoff its own retry budget can
 * spend, so a read that failed by hanging, or after the client had already
 * retried it, is never repeated here — only one that failed fast. It bounds
 * when an attempt starts, not how long that attempt then takes: the attempt
 * itself is bounded by the client's deadline.
 */
const COLD_RETRY_DEADLINE_MS = 2_000;

/**
 * Is this error worth reading again for?
 *
 * An error that carries an HTTP status is judged by the same transient set the
 * store client retries on; one that carries none (a reset connection, an
 * aborted fetch, a payload that would not parse) is assumed to be a bad moment.
 */
function mayRetry(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== "number" || status === 0) return true;
  return isRetryableStatus(status, true);
}

export class NamespaceView {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    /** Read one key's map from the resolver. */
    private readonly load: (key: string) => Promise<Record<string, string>>,
    private readonly opts: NamespaceViewOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.warn =
      opts.onWarn ??
      ((message: string) => {
        console.warn(message);
      });
    this.sleep = opts.sleep ?? sleep;
  }

  /**
   * `load(key)`, tried again while nothing is held and the budget allows.
   *
   * With something held a failure is answered from it at once (see `refresh`),
   * so there is nothing to wait for and the first error is returned. Each
   * retry is warned, by subsystem and error class — never a value — because
   * the warning is the only trace a retry that then succeeds leaves.
   *
   * `undefined` means an `invalidate` superseded this read while it was
   * failing: whatever it read next would be discarded, so it stops, and
   * `get` reads again against the post-write state.
   */
  private async loadRetrying(
    key: string,
    generation: number,
    attempts: number,
  ): Promise<Record<string, string> | undefined> {
    const startedAt = this.now();
    let spentMs = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.load(key);
      } catch (err) {
        if ((this.entries.get(key)?.generation ?? 0) !== generation) {
          return undefined;
        }
        if (this.held(key) || !mayRetry(err)) throw err;
        const delay = retryDelayMs({
          attempt,
          spentMs,
          budget: { ...COLD_RETRY_BUDGET, attempts },
          random: this.opts.random,
        });
        if (
          delay === undefined ||
          this.now() - startedAt + delay > COLD_RETRY_DEADLINE_MS
        ) {
          throw err;
        }
        this.warn(
          `[strad] ${this.opts.label ?? "namespace"} read failed for "${key}" ` +
            `with nothing held; retrying in ${delay}ms ` +
            `(attempt ${attempt + 2} of ${attempts}): ` +
            errorSummary(err),
        );
        await this.sleep(delay);
        spentMs += delay;
        if ((this.entries.get(key)?.generation ?? 0) !== generation) {
          return undefined;
        }
      }
    }
  }

  /**
   * The map for `key`: the resolver's current answer, or the last good one if
   * the resolver is failing and one is held.
   */
  async get(key: string): Promise<Record<string, string>> {
    await this.refresh(key);
    const entry = this.entries.get(key);
    // The read this caller waited on was DISCARDED: an `invalidate` landed
    // while it was in flight, so what it captured predates a write. Discarding
    // it is right (see `invalidate`), but this caller has been handed nothing —
    // and a per-server provider reads a miss here as "not in my namespace" and
    // falls through to the gateway's, so a request racing a console rotation
    // would see a live credential as absent. Read once more, against the
    // post-write state. Once, not until it sticks: a write racing every read is
    // not a shape worth looping on, and the next `get` reads again anyway.
    if (entry && entry.fetchedAt === -Infinity && !entry.inflight) {
      await this.refresh(key);
    }
    return this.entries.get(key)?.values ?? {};
  }

  /** The held map, without reading. `undefined` when nothing is held. */
  peek(key: string): Record<string, string> | undefined {
    return this.entries.get(key)?.values;
  }

  /**
   * Drop what is held, and make any in-flight read discard its result.
   *
   * The generation bump is what makes this STICK. Without it: a reader starts a
   * read that captures the pre-write state, a writer then writes and
   * invalidates, and the in-flight read lands afterwards and installs what it
   * captured BEFORE the write. It would be served as the last good map on the
   * next failure, and until then every read would carry the resolver's own
   * (already dropped) snapshot forward — quietly turning "a write is visible
   * immediately" into "a write is ignored".
   */
  invalidate(key?: string): void {
    if (key === undefined) {
      for (const k of [...this.entries.keys()]) this.invalidate(k);
      return;
    }
    const entry = this.entries.get(key);
    // The entry survives so an in-flight read has a generation to compare
    // against, but `fetchedAt: -Infinity` marks it as holding nothing: it is
    // stale for `get`, and `held()` reads false so a failure cannot serve it.
    this.entries.set(key, {
      values: {},
      fetchedAt: -Infinity,
      generation: (entry?.generation ?? 0) + 1,
      inflight: entry?.inflight,
      token: entry?.token,
    });
  }

  /** True when a value is held and usable (i.e. a get would not be empty). */
  private held(key: string): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && entry.fetchedAt !== -Infinity;
  }

  /**
   * Read `key` through the resolver, sharing the read with any caller already
   * waiting on it. Public so a miss can force one; `get` is the ordinary path.
   */
  async refresh(key: string): Promise<void> {
    const existing = this.entries.get(key);
    if (existing?.inflight) return existing.inflight;

    // Back off after a failure. Without this, an outage costs one failed network
    // call and one log line per REQUEST, which turns a degraded dependency into
    // a self-inflicted load problem and a flooded log.
    if (
      existing?.lastFailureAt !== undefined &&
      this.held(key) &&
      this.now() - existing.lastFailureAt < FAILURE_BACKOFF_MS
    ) {
      return;
    }

    const generation = existing?.generation ?? 0;
    // A token rather than the promise itself: the `finally` below has to know
    // whether the entry still belongs to THIS read, and it cannot reference
    // the promise it is part of before that promise exists.
    const token = {};

    const inflight = (async () => {
      try {
        // Nothing held and a nothing-held read failed moments ago: one
        // attempt, no retry, so an outage costs a read per request rather
        // than a budget per request. Still a read — this fails closed, it
        // does not fail stale.
        const recentlyFailed =
          existing?.lastFailureAt !== undefined &&
          this.now() - existing.lastFailureAt < FAILURE_BACKOFF_MS;
        const values = await this.loadRetrying(
          key,
          generation,
          recentlyFailed ? 1 : COLD_RETRY_BUDGET.attempts,
        );
        if (values === undefined) return;
        const current = this.entries.get(key);
        // Discard a result an invalidate has already superseded: the read is not
        // wrong, just out of date — it began before a write we were told about.
        if ((current?.generation ?? 0) !== generation) return;
        this.entries.set(key, {
          values,
          fetchedAt: this.now(),
          generation,
        });
      } catch (err) {
        const current = this.entries.get(key);
        if (!this.held(key)) {
          // Remember the failure so the next read inside the backoff does
          // not spend a whole retry budget too — but only for THIS
          // generation: a write since is a reason to try in earnest again.
          if (current && current.generation === generation) {
            this.entries.set(key, { ...current, lastFailureAt: this.now() });
          }
          throw err;
        }
        this.entries.set(key, {
          values: current!.values,
          fetchedAt: current!.fetchedAt,
          generation: current!.generation,
          lastFailureAt: this.now(),
        });
        // Names the subsystem and the failure. Never a secret, never a value.
        this.warn(
          `[strad] ${this.opts.label ?? "namespace"} read failed for "${key}"; ` +
            `serving the last known good values: ${errorSummary(err)}`,
        );
      } finally {
        const current = this.entries.get(key);
        // Clear only OUR read. A blanket clear would also wipe a newer one
        // that an invalidate started while this was in flight.
        if (current?.token === token) {
          this.entries.set(key, {
            ...current,
            inflight: undefined,
            token: undefined,
          });
        }
      }
    })();

    this.entries.set(key, {
      values: existing?.values ?? {},
      fetchedAt: existing?.fetchedAt ?? -Infinity,
      generation,
      lastFailureAt: existing?.lastFailureAt,
      inflight,
      token,
    });

    return inflight;
  }
}
