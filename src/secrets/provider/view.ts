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
 * With nothing held — the very first read failed — the error DOES propagate.
 * There is nothing to serve, and reporting an empty namespace would turn an
 * outage into a silent misconfiguration.
 */

export interface NamespaceViewOptions {
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

export class NamespaceView {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

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
