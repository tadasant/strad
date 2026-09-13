import type { ParameterStore } from "./parameters/index.ts";
import { variableOf } from "./parameters/wire.ts";
import { errorSummary } from "../util/error-text.ts";
import { event } from "../telemetry/index.ts";
import { withDeadline } from "../util/deadline.ts";

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
   * How old the facts above are, in milliseconds.
   *
   * A diagnosis is a claim about the store AS OF a moment, and the moment is
   * part of the claim. Two things make it non-zero: `readStoreDiagnosticsCached`
   * holding a pass, and the store client answering the pass from the snapshot
   * it holds (`gateway.secrets.ttlSeconds`, see parameters/gcp.ts) — a pass
   * that just ran against a fifty-minute-old snapshot is fifty minutes old, and
   * says so. Every surface that prints a diagnosis prints this with it; a
   * console that showed an hour-old "healthy" without saying so would be the
   * failure mode that holding one introduces.
   */
  ageMs: number;
}

export interface ReadDiagnosticsOptions {
  store: Pick<ParameterStore, "list" | "resolveDetailed">;
  namespace: string;
  /** One deadline for the pair. A slow store degrades the page, never hangs it. */
  timeoutMs?: number;
  /** Injected in tests so the clock is not the thing under test. */
  now?: () => number;
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
    orNull(() => opts.store.list(opts.namespace), timeoutMs, "the store index"),
    opts.store.resolveDetailed
      ? orNull(
          () => opts.store.resolveDetailed!(opts.namespace),
          timeoutMs,
          "the store render",
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

  // The render pass says when the reading it answered from was taken. A
  // resolver that reads live carries no `readAt`, and the facts are as fresh
  // as this call.
  const now = opts.now ?? Date.now;
  const ageMs =
    resolved?.readAt === undefined ? 0 : Math.max(0, now() - resolved.readAt);
  return { indexed, unrenderable, rendered, indexRead, renderRead, ageMs };
}

// ---------------------------------------------------------------------------
// The result cache
// ---------------------------------------------------------------------------

/**
 * No PASS is reused for longer than this, whatever `ttlSeconds` says.
 *
 * A pass is a `list()` plus a `resolveDetailed()` against the store client,
 * which answers both from the snapshot it holds for `gateway.secrets.ttlSeconds`
 * — so a pass inside that TTL is memory, and one past it is what re-reads the
 * store. Holding the pass's RESULT for a minute keeps the failure path bounded:
 * a store that is down costs one attempted pass per backoff, not one per
 * request. It is capped rather than following the knob all the way up because
 * that knob accepts a day, and the pass is what notices the snapshot has aged
 * out and the store has stopped answering. What the cap does NOT do is make the
 * diagnosis fresher than the snapshot under it: its facts are as old as that
 * snapshot, and `ageMs` says so.
 */
export const MAX_DIAGNOSIS_TTL_MS = 60_000;

/**
 * How long a pass that did NOT fully read suppresses the next one.
 *
 * Matches `view.ts`'s `FAILURE_BACKOFF_MS`, and for the same reason: a store
 * that is down must not cost one full pass per request. It is capped by the
 * success TTL as well (see `holdFor`), so it is never the LONGEST thing held: a
 * failed pass is cached as a SHRUG — `indexRead` false, which every consumer
 * reads as "draws no distinction" — never as an answer, and a deployment asking
 * for tighter freshness must not get a looser hold on the worse state.
 */
export const FAILURE_BACKOFF_MS = 5_000;

/** How long a pass may be served, given whether it read both halves. */
function holdFor(complete: boolean, ttlMs: number): number {
  return complete ? ttlMs : Math.min(FAILURE_BACKOFF_MS, ttlMs);
}

/**
 * An entry is EITHER a pass in flight or a completed one, never both.
 *
 * Modelling it as one shape with optional fields left a placeholder value that
 * nothing could ever read — every path checks for the pass first and returns.
 */
type CacheEntry =
  | { pass: Promise<StoreDiagnostics>; done?: undefined }
  | {
      pass?: undefined;
      done: {
        value: StoreDiagnostics;
        /** When the pass STARTED — what `goodFor` is measured from. */
        passAt: number;
        /**
         * When the FACTS were read: the pass start, less however old the
         * store's own reading already was when the pass ran. `ageMs` counts
         * from here, so a pass served from a snapshot reports the snapshot's
         * age and not its own.
         */
        readAt: number;
        /** How long this entry may be served: the TTL, or the failure backoff. */
        goodFor: number;
      };
    };

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
}

/**
 * `readStoreDiagnostics`, behind a short TTL.
 *
 * `/connectors` and `/api/secrets/readiness` both derive their verdict from this one
 * pair of reads, and the pass is not nominal: `resolveDetailed()` renders each
 * parameter under its own try/catch rather than ending at the first failure, so
 * a namespace-wide refusal costs a full pass at a fan-out of ten. Performed per
 * request, that makes readiness an amplifier for a caller that polls it hard.
 *
 * Four properties, and each one is load-bearing:
 *
 *   - **The deadline is preserved.** This calls `readStoreDiagnostics`, which
 *     still gives the pair one deadline and still never throws. A caller that
 *     joins a pass in flight waits at most what that pass had left, so the cache
 *     can never make a slow store hang a page that would otherwise have degraded.
 *     The deadline belongs to the pass, not to the joiner: `timeoutMs` is not
 *     part of the key, so a caller asking for a tighter one gets the running
 *     pass's instead. Both call sites take the default.
 *   - **Concurrent callers share one pass.** Ten simultaneous polls on a cold
 *     entry open one read, not ten. Without this the TTL would do nothing at all
 *     for the case it is meant for. A caller arriving the millisecond AFTER an
 *     entry expires waits for the fresh pass rather than being handed the stale
 *     value: this is a health signal, and serving a known-expired one to save
 *     latency is the trade that makes it dishonest.
 *   - **The age counts from the read, not from its arrival.** `readAt` is taken
 *     before the pass starts, so a six-second pass hands back a six-second-old
 *     answer that says so, and the cap is a cap on the FACT's age.
 *   - **A failure is cached briefly and as a shrug.** A pass whose index or
 *     render half did not read is held for `FAILURE_BACKOFF_MS` (or the TTL,
 *     whichever is shorter), not for the full TTL. Caching it for the full TTL
 *     would extend an outage's visible life; not caching it at all would leave a
 *     broken store getting hammered by exactly the poller this exists to bound.
 *     Note that a namespace-wide RENDER REFUSAL is not a failure by this
 *     definition: the reads succeeded and returned bad news, which is a complete
 *     answer and is cached for the full TTL — and that is the expensive case.
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
  if (held?.pass) return held.pass;
  if (held) {
    if (now() - held.done.passAt < held.done.goodFor) {
      return { ...held.done.value, ageMs: now() - held.done.readAt };
    }
  }

  const passAt = now();
  const pass = (async () => {
    try {
      const value = await readStoreDiagnostics(opts);
      const complete = value.indexRead && value.renderRead;
      const readAt = passAt - value.ageMs;
      entries.set(opts.namespace, {
        done: { value, passAt, readAt, goodFor: holdFor(complete, ttlMs) },
      });
      return { ...value, ageMs: now() - readAt };
    } catch (err) {
      // `readStoreDiagnostics` is documented not to throw, and this is the
      // belt: leaving a rejected promise parked as the entry would serve the
      // same rejection to every later caller for the life of the process.
      entries.delete(opts.namespace);
      throw err;
    }
  })();

  entries.set(opts.namespace, { pass });

  return pass;
}

/**
 * Drop everything cached for this store client.
 *
 * Called after a write through strad's own console, for the reason
 * `StoreSecretProvider.invalidate()` gives: the console has just told a human
 * their rotation succeeded, and a cached diagnosis would keep the row telling
 * them to rotate it for the rest of the TTL — the page contradicting its own
 * flash message. Whole-client rather than per-namespace because a write may
 * touch more than it names, and because a stale diagnosis costs one pass to
 * replace.
 */
export function forgetStoreDiagnosis(store: object): void {
  CACHES.delete(store);
}

/**
 * Resolve to the value, or to null on a throw or a timeout. Never rejects.
 *
 * The swallow is what makes `readStoreDiagnostics` safe to call from a page
 * render, and the summary is why the log line it leaves behind is safe to
 * export. Both stay here rather than inside `withDeadline`, which is generic and
 * has no business deciding either.
 */
async function orNull<T>(
  read: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T | null> {
  try {
    return await withDeadline(read, timeoutMs, label);
  } catch (err) {
    // Logged by class, never by message, for the reason view.ts states: a
    // failure on this path can embed a window of a rendered secret.
    event({
      evt: "strad.store_diagnostics_failed",
      error: errorSummary(err),
    });
    return null;
  }
}
