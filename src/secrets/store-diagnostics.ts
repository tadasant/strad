import type { ParameterStore } from "./parameters/index.ts";
import { variableOf } from "./parameters/wire.ts";
import { errorSummary } from "./provider/snapshot.ts";
import { event } from "../telemetry/index.ts";

/**
 * What the parameter store holds, and what it cannot hand over.
 *
 * The console's four states need two facts about a name that the ordinary read
 * path collapses into one. `provider.get(NAME)` answers "did I get a value",
 * and a `null` or a throw from it is compatible with three completely different
 * situations:
 *
 *   - the parameter does not exist            → seed it
 *   - it exists and `:render` refuses it      → rotate it (409 if you seed)
 *   - the store did not answer at all         → do nothing, wait
 *
 * Telling them apart takes an INDEX read, which `list()` performs without ever
 * dereferencing a `__REF__`, plus a per-parameter render, which
 * `resolveDetailed()` performs without letting one failure end the loop. This
 * module runs both and hands the console the pair.
 *
 * ## It is useful before the provider flip, not only after
 *
 * A deployment on `provider: env` still resolves `params: true` servers from the
 * store at DEPLOY time, and a parameter that cannot render fails that deploy.
 * So wherever core holds a resolver credential — which staging does today,
 * `provider: env` and all — this turns "the next deploy will fail and you will
 * find out during the deploy" into a row on a page, now. Where there is no
 * resolver credential there is nothing to read and the answer is null, which
 * costs nothing and claims nothing.
 *
 * ## What it never returns
 *
 * A value. `indexed` is names; `unrenderable` is names and failure SHAPES.
 * `resolveDetailed` hands back rendered values for the parameters that did
 * render and this module drops them on the floor — deliberately, and the type
 * says so. There is no path from here to a byte.
 */
export interface StoreDiagnostics {
  /** Every VARIABLE the store's index holds under this namespace. */
  indexed: ReadonlySet<string>;
  /** VARIABLE -> why its value could not be produced. Never a body. */
  unrenderable: ReadonlyMap<string, string>;
  /**
   * Every VARIABLE that DID render, so "in the index" is never on its own taken
   * as evidence that a value cannot be produced. It usually means the opposite.
   */
  rendered: ReadonlySet<string>;
  /** True when the index read succeeded, so `indexed` is a complete list. */
  indexRead: boolean;
  /** True when the per-parameter render ran, so `unrenderable` is complete. */
  renderRead: boolean;
  /**
   * How long ago the reads above actually happened, in milliseconds. Zero on a
   * pass that just ran.
   *
   * A cached diagnosis is a claim about the store AS OF a moment, and the moment
   * is part of the claim. Every surface that prints one prints this with it —
   * `readStoreDiagnosticsCached` is what makes it non-zero, and a console that
   * showed a minute-old "healthy" without saying so would be the failure mode
   * that caching introduces.
   */
  ageMs: number;
}

export interface ReadDiagnosticsOptions {
  store: Pick<ParameterStore, "list" | "resolveDetailed">;
  namespace: string;
  /** One deadline for the pair. A slow store degrades the page, never hangs it. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 6000;

/**
 * Read both halves, and never throw.
 *
 * A diagnostic that could fail the page it informs would be a strictly worse
 * page. Either half failing leaves its flag false and its collection empty, and
 * every consumer treats "not read" as "draws no distinction" rather than as an
 * answer.
 */
export async function readStoreDiagnostics(
  opts: ReadDiagnosticsOptions,
): Promise<StoreDiagnostics> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const indexed = new Set<string>();
  const unrenderable = new Map<string, string>();
  const rendered = new Set<string>();
  let indexRead = false;
  let renderRead = false;

  const [listed, resolved] = await Promise.all([
    withDeadline(() => opts.store.list(opts.namespace), timeoutMs),
    opts.store.resolveDetailed
      ? withDeadline(
          () => opts.store.resolveDetailed!(opts.namespace),
          timeoutMs,
        )
      : Promise.resolve(null),
  ]);

  if (listed) {
    indexRead = true;
    for (const meta of listed) indexed.add(variableOf(meta.path));
  }
  if (resolved) {
    renderRead = true;
    for (const variable of Object.keys(resolved.values)) {
      rendered.add(variable);
      indexed.add(variable);
    }
    for (const failure of resolved.unrenderable) {
      unrenderable.set(failure.variable, failure.reason);
      // A parameter that failed to render is in the store by definition, so it
      // belongs in the index even when the index read is the half that failed.
      indexed.add(failure.variable);
    }
  }

  return { indexed, unrenderable, rendered, indexRead, renderRead, ageMs: 0 };
}

// ---------------------------------------------------------------------------
// The result cache
// ---------------------------------------------------------------------------

/**
 * No diagnosis is served older than this, whatever `ttlSeconds` says.
 *
 * `gateway.secrets.ttlSeconds` answers "how stale may a store READ be", and it
 * accepts up to an hour — a deployment that rotates rarely can reasonably set it
 * there. That number cannot govern this cache unbounded, because a diagnosis is
 * a HEALTH signal: an hour-old "the store answers and everything renders" said
 * about a store that broke fifty minutes ago is a worse failure than the reads
 * this cache exists to save. So the config knob is followed downward and capped
 * upward, at the default it already carries.
 */
export const MAX_DIAGNOSIS_TTL_MS = 60_000;

/**
 * How long a pass that did NOT fully read suppresses the next one.
 *
 * Matches `snapshot.ts`'s `FAILURE_BACKOFF_MS`, and for the same reason: a store
 * that is down must not cost one full pass per request. It is deliberately far
 * shorter than the success TTL — a failed pass is cached as a SHRUG (`indexRead`
 * false, the states the console had before this feature existed), never as an
 * answer, so the only thing extending it would buy is a longer wait to notice
 * the store came back.
 */
export const FAILURE_BACKOFF_MS = 5_000;

interface CacheEntry {
  value: StoreDiagnostics;
  fetchedAt: number;
  /** How long this entry may be served: the TTL, or the failure backoff. */
  goodFor: number;
  /** Set while a pass is running, so concurrent callers share one read. */
  inflight?: Promise<StoreDiagnostics>;
}

/**
 * One cache per store CLIENT, keyed by namespace inside it.
 *
 * Keyed on the client's identity rather than memoised outright, exactly as
 * `cachedResolver` in `ui/secret-status.ts` is keyed on the environment: in
 * production there is one resolver per process, so this is a process-wide cache,
 * while a test that hands in its own store gets its own cache and cannot be
 * served another test's answer.
 */
const CACHES = new WeakMap<object, Map<string, CacheEntry>>();

export interface CachedDiagnosticsOptions extends ReadDiagnosticsOptions {
  /**
   * How long a COMPLETE pass is served without re-reading. Clamped to
   * `MAX_DIAGNOSIS_TTL_MS`; a shorter value is honoured as given.
   */
  ttlMs: number;
  /** Injected in tests so the clock is not the thing under test. */
  now?: () => number;
}

/**
 * `readStoreDiagnostics`, behind a short TTL.
 *
 * `/ui` and `/api/secrets/readiness` both derive their verdict from this one
 * pair of reads, and the pass is not nominal: `resolveDetailed()` renders each
 * parameter under its own try/catch rather than ending at the first failure, so
 * a namespace-wide refusal costs a full pass at a fan-out of ten. Performed per
 * request, that makes readiness an amplifier for a caller that polls it hard.
 *
 * Three properties, and each one is load-bearing:
 *
 *   - **The deadline is preserved.** This calls `readStoreDiagnostics`, which
 *     still gives the pair one deadline and still never throws. A caller that
 *     joins a pass in flight waits at most what that pass had left, so the cache
 *     can never make a slow store hang a page that would otherwise have degraded.
 *   - **Concurrent callers share one pass.** Ten simultaneous polls on a cold
 *     entry open one read, not ten. Without this the TTL would do nothing at all
 *     for the case it is meant for.
 *   - **A failure is cached briefly and as a shrug.** A pass whose index or
 *     render half did not read is held for `FAILURE_BACKOFF_MS`, not for the
 *     TTL. Caching it for the full TTL would extend an outage's visible life; not
 *     caching it at all would leave a broken store getting hammered by exactly
 *     the poller this exists to bound. Note that a namespace-wide RENDER REFUSAL
 *     is not a failure by this definition: the reads succeeded and returned bad
 *     news, which is a complete answer and is cached for the full TTL — and that
 *     is the expensive case.
 */
export async function readStoreDiagnosticsCached(
  opts: CachedDiagnosticsOptions,
): Promise<StoreDiagnostics> {
  const now = opts.now ?? Date.now;
  const ttlMs = Math.min(Math.max(opts.ttlMs, 0), MAX_DIAGNOSIS_TTL_MS);

  let entries = CACHES.get(opts.store);
  if (!entries) {
    entries = new Map<string, CacheEntry>();
    CACHES.set(opts.store, entries);
  }

  const held = entries.get(opts.namespace);
  if (held?.inflight) return held.inflight;
  if (held) {
    const ageMs = now() - held.fetchedAt;
    if (ageMs < held.goodFor) return { ...held.value, ageMs };
  }

  const pass = (async () => {
    try {
      const value = await readStoreDiagnostics(opts);
      const complete = value.indexRead && value.renderRead;
      entries.set(opts.namespace, {
        value,
        fetchedAt: now(),
        goodFor: complete ? ttlMs : FAILURE_BACKOFF_MS,
      });
      return value;
    } catch (err) {
      // `readStoreDiagnostics` is documented not to throw, and this is the
      // belt: leaving a rejected promise parked as `inflight` would serve the
      // same rejection to every later caller for the life of the process.
      entries.delete(opts.namespace);
      throw err;
    }
  })();

  entries.set(opts.namespace, {
    value: held?.value ?? EMPTY_DIAGNOSIS,
    fetchedAt: held?.fetchedAt ?? -Infinity,
    goodFor: held?.goodFor ?? 0,
    inflight: pass,
  });

  return pass;
}

const EMPTY_DIAGNOSIS: StoreDiagnostics = {
  indexed: new Set(),
  unrenderable: new Map(),
  rendered: new Set(),
  indexRead: false,
  renderRead: false,
  ageMs: 0,
};

/** Resolve to the value, or to null on a throw or a timeout. Never rejects. */
async function withDeadline<T>(
  read: () => Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    // Logged by class, never by message, for the reason snapshot.ts states: a
    // failure on this path can embed a window of a rendered secret.
    event({
      evt: "strad.store_diagnostics_failed",
      error: errorSummary(err),
    });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
