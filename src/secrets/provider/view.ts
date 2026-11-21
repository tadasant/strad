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
 * write-back a fresh pod runs seconds after boot. In both, one transient
 * failure used to be the whole answer: the gateway's token store reads through
 * this class, so a single bad read right after a write failed `/mcp` with a
 * 500 (tadasant/strad#523). The retry is bounded twice — `COLD_RETRY_BUDGET`
 * caps the attempts and the sleeps, and no further attempt starts once
 * `COLD_RETRY_DEADLINE_MS` has passed since the first, so a read that HUNG to
 * its own timeout is not repeated and a stalled store stays a stalled request,
 * not three of them back to back.
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
import { type RetryBudget, retryDelayMs, sleep } from "../../http/retry.ts";

export interface NamespaceViewOptions {
  /** Injected in tests so the clock is not the thing under test. */
  now?: () => number;
  /** Injected in tests to assert we never log a value. */
  onWarn?: (message: string) => void;
  /** Prefixes a warning so it names the subsystem. Never carries a value. */
  label?: string;
  /** How hard a read with nothing held is retried. Defaults to `COLD_RETRY_BUDGET`. */
  coldRetry?: RetryBudget;
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
 * at most 600ms in all.
 *
 * Sized for the failure it exists for — one bad response from the store in a
 * burst, the shape of #523 — and paid only when a read FAILS with nothing to
 * fall back on, which is on the request path of whoever is waiting. It is not
 * sized to ride out an outage; the store client already retries the statuses
 * that say "not now" (see `src/http/retry.ts`), and this covers what escapes
 * it: a reset connection, a failed token exchange, a payload that would not
 * parse.
 */
export const COLD_RETRY_BUDGET: RetryBudget = {
  attempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 1_000,
  totalDelayMs: 1_000,
};

/**
 * No retry STARTS later than this after the first attempt did.
 *
 * Below the store client's own per-request timeout (10s, parameters/gcp.ts),
 * so a read that failed by hanging to that timeout is never repeated here —
 * only one that failed fast.
 */
export const COLD_RETRY_DEADLINE_MS = 5_000;

export class NamespaceView {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly coldRetry: RetryBudget;
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
    this.coldRetry = opts.coldRetry ?? COLD_RETRY_BUDGET;
    this.sleep = opts.sleep ?? sleep;
  }

  /**
   * `load(key)`, tried again while nothing is held and the budget allows.
   *
   * With something held a failure is answered from it at once (see `refresh`),
   * so there is nothing to wait for and the first error is returned. Each
   * retry is warned, by subsystem and error class — never a value — because
   * the warning is the only trace a retry that then succeeds leaves.
   */
  private async loadRetrying(key: string): Promise<Record<string, string>> {
    const startedAt = this.now();
    let spentMs = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.load(key);
      } catch (err) {
        if (this.held(key)) throw err;
        const delay = retryDelayMs({
          attempt,
          spentMs,
          budget: this.coldRetry,
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
            `(attempt ${attempt + 2} of ${this.coldRetry.attempts}): ` +
            errorSummary(err),
        );
        await this.sleep(delay);
        spentMs += delay;
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
        const values = await this.loadRetrying(key);
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
        if (!this.held(key)) throw err;
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
