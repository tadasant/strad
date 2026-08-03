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
}

export const EMPTY_DIAGNOSTICS: StoreDiagnostics = {
  indexed: new Set(),
  unrenderable: new Map(),
  rendered: new Set(),
  indexRead: false,
  renderRead: false,
};

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

  return { indexed, unrenderable, rendered, indexRead, renderRead };
}

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
