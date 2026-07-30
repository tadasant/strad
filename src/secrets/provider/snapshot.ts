/**
 * A TTL'd, single-flighted, stale-on-error cache of named maps.
 *
 * Two callers need exactly this and would otherwise each grow their own copy:
 *
 *   - `StoreSecretProvider`, caching one gateway namespace, so `${NAME}` can be
 *     resolved on the request path without a round trip per reference.
 *   - the registry, caching a `params: true` server's namespace, so a builtin's
 *     options can be re-resolved per tool call without a round trip per call.
 *
 * The unit is a whole map rather than a single entry because that is the grain
 * the backing store actually reads at: resolving a namespace is one list plus a
 * render per parameter, so caching per name would turn a page of ten references
 * into ten full listings.
 *
 * ## Failure posture
 *
 * A refresh that throws does NOT propagate if a previous value is held: the last
 * known good map is served and the caller is warned. A secret store going down
 * must not take the gateway down with it — trading "secrets are stale" for "the
 * gateway is offline" is the worse deal by a wide margin.
 *
 * With nothing held — the very first load failed — the error DOES propagate.
 * There is nothing to serve, and reporting an empty namespace would turn an
 * outage into a silent misconfiguration.
 */

export interface SnapshotCacheOptions {
  /** How long an entry is fresh. */
  ttlMs: number;
  /** Injected in tests so the clock is not the thing under test. */
  now?: () => number;
  /** Injected in tests to assert we never log a value. */
  onWarn?: (message: string) => void;
  /** Prefixes a warning so it names the subsystem. Never carries a value. */
  label?: string;
}

interface Entry {
  values: Record<string, string>;
  fetchedAt: number;
  /** Set while a refresh is in flight, so concurrent readers share one read. */
  inflight?: Promise<void>;
  /** Identity of the in-flight refresh, so it only clears its own. */
  token?: object;
  /** Bumped by `invalidate`; a refresh started earlier will not commit. */
  generation: number;
  /** When the last refresh failed, so an outage is not retried per request. */
  lastFailureAt?: number;
}

/** How long to wait before retrying after a failed refresh. */
const FAILURE_BACKOFF_MS = 5_000;

export class SnapshotCache {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

  constructor(
    /** Load one key's map from the backing store. */
    private readonly load: (key: string) => Promise<Record<string, string>>,
    private readonly opts: SnapshotCacheOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.warn =
      opts.onWarn ??
      ((message: string) => {
        console.warn(message);
      });
  }

  /** The cached map for `key`, refreshing it if stale. */
  async get(key: string): Promise<Record<string, string>> {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.fetchedAt < this.opts.ttlMs) {
      return entry.values;
    }
    await this.refresh(key);
    return this.entries.get(key)?.values ?? {};
  }

  /** The cached map, without refreshing. `undefined` when nothing is held. */
  peek(key: string): Record<string, string> | undefined {
    return this.entries.get(key)?.values;
  }

  /** Age of the held map in ms, or `Infinity` when nothing is held. */
  age(key: string): number {
    const entry = this.entries.get(key);
    return entry ? this.now() - entry.fetchedAt : Infinity;
  }

  /**
   * Drop what is held, and make any in-flight refresh discard its result.
   *
   * The generation bump is what makes this STICK. Without it: a reader triggers a
   * refresh whose read captures the pre-write state, a writer then writes and
   * invalidates, and the in-flight read lands afterwards and installs what it
   * captured BEFORE the write. The entry would look fresh, be stale, and stay
   * that way for a full TTL — quietly turning "a write is visible immediately"
   * into "a write is ignored".
   */
  invalidate(key?: string): void {
    if (key === undefined) {
      for (const k of [...this.entries.keys()]) this.invalidate(k);
      return;
    }
    const entry = this.entries.get(key);
    // The entry survives so an in-flight refresh has a generation to compare
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
    // whether the entry still belongs to THIS refresh, and it cannot reference
    // the promise it is part of before that promise exists.
    const token = {};

    const inflight = (async () => {
      try {
        const values = await this.load(key);
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
          `[strad] ${this.opts.label ?? "snapshot"} refresh failed for "${key}"; ` +
            `serving the last known good values: ${errorSummary(err)}`,
        );
      } finally {
        const current = this.entries.get(key);
        // Clear only OUR refresh. A blanket clear would also wipe a newer one
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

/**
 * A one-line description of a failure, safe to log.
 *
 * A `ParameterStoreError` is built from a method and a resource path with the
 * query string and any `:verb` stripped (see parameters/gcp.ts), so its message
 * is known not to carry a value and is passed through. ANYTHING else is reduced
 * to its class name: a `SyntaxError` from a malformed response body embeds a
 * window of that body, and on this path the body can be a rendered secret.
 */
export function errorSummary(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "ParameterStoreError"
      ? `${err.name}: ${err.message}`
      : err.name;
  }
  return "unknown error";
}
