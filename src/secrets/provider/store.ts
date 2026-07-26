import type { ParameterResolver } from "../parameters/types.ts";
import type { SecretProvider } from "./types.ts";

/**
 * Secrets from a parameter store, read AT RUNTIME.
 *
 * This is the provider that makes "add a secret, and prod picks it up" true. It
 * sits on top of the store-agnostic `ParameterResolver` (see ../parameters), so
 * the GCP backend is an implementation detail: any store that can resolve a
 * namespace into `VARIABLE -> value` plugs in here unchanged.
 *
 * Note what this file does NOT contain: a cloud client. The Parameter Manager +
 * Secret Manager client already exists (../parameters/gcp.ts — fetch plus a
 * node:crypto JWT, no SDK), and this reuses it through the interface rather than
 * standing up a second way to talk to the same two stores. All that is added
 * here is WHEN the read happens and how long its result is trusted.
 *
 * The credential is the RESOLVER identity — `parametermanager.parameterViewer`
 * plus `secretmanager.secretAccessor`. Read-only by IAM. It is deliberately
 * neither the `secrets` MCP server's viewer key (which cannot read a value at
 * all) nor the console's admin key (which can write); see ../parameters/types.ts
 * for why those three are separate, and scripts/render-spec.ts for where the
 * distinction is enforced.
 *
 * ## Why the cache is a namespace SNAPSHOT and not a per-name entry
 *
 * A parameter store's natural read is a namespace, not a name — `resolve()` is
 * one list plus one render per parameter. A generic per-name cache wrapped
 * around `get()` would turn a page of ten `${REF}`s into ten full listings. So
 * the cache lives here, at the layer that knows the backend's grain, and holds
 * ONE snapshot of the whole namespace.
 *
 * ## What "immediately" means, precisely
 *
 * - **Rotation** of an existing secret is visible within `ttlMs` (default 60s):
 *   the snapshot is refreshed on the first `get` after it goes stale.
 * - **Addition** of a name that was previously absent is visible within
 *   `negativeTtlMs` (default 10s). A miss forces an out-of-band refresh, rate
 *   limited to once per `negativeTtlMs` so a genuinely unknown `${REF}` on a hot
 *   path cannot hammer the backend once per request.
 * - **A change made through strad's own console** is instant on that process,
 *   because the writer calls `invalidate()`.
 *
 * ## Failure posture
 *
 * A refresh that throws does NOT propagate if we still hold a snapshot: the last
 * known good values are served and a warning is logged (name of the provider and
 * the error — never a value, never a name-to-value pairing). A store outage must
 * not take `/mcp` down; strad would otherwise trade "secrets are stale" for
 * "the gateway is offline", which is the worse failure by a wide margin.
 *
 * With no snapshot at all — the very first read failed — the error DOES
 * propagate. There is nothing to serve, and pretending the secret is absent
 * would report a config error for what is an outage.
 */
export interface StoreSecretProviderOptions {
  /** How long a snapshot is considered fresh. Default 60s. */
  ttlMs?: number;
  /** Minimum interval between miss-triggered refreshes. Default 10s. */
  negativeTtlMs?: number;
  /** Injected in tests so the clock is not the thing under test. */
  now?: () => number;
  /** Injected in tests to assert we never log a value. */
  onWarn?: (message: string) => void;
}

export const DEFAULT_TTL_MS = 60_000;
export const DEFAULT_NEGATIVE_TTL_MS = 10_000;

interface Snapshot {
  values: Record<string, string>;
  fetchedAt: number;
}

export class StoreSecretProvider implements SecretProvider {
  readonly name: string;

  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

  private snapshot: Snapshot | null = null;
  /** Single-flight: concurrent misses share one backend read. */
  private inflight: Promise<void> | null = null;
  private lastMissRefreshAt = -Infinity;
  /**
   * Bumped by `invalidate()`. A refresh commits its result only if this has not
   * changed since it started — see the comment there for the race it closes.
   */
  private generation = 0;

  constructor(
    private readonly resolver: ParameterResolver,
    /** The namespace this provider reads, e.g. `/strad/prod/gateway/static/`. */
    private readonly namespace: string,
    opts: StoreSecretProviderOptions = {},
  ) {
    this.name = `store:${namespace}`;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.warn =
      opts.onWarn ??
      ((message: string) => {
        console.warn(message);
      });
  }

  async get(name: string): Promise<string | null> {
    await this.ensureFresh();

    const hit = this.snapshot?.values[name];
    if (hit !== undefined) return hit;

    // A MISS. The snapshot may simply predate the secret being added, which is
    // the case this whole class exists to serve. Force one refresh — but no more
    // often than negativeTtlMs, so an unknown ref stays cheap.
    const now = this.now();
    if (now - this.lastMissRefreshAt >= this.negativeTtlMs) {
      this.lastMissRefreshAt = now;
      await this.refresh();
      const retry = this.snapshot?.values[name];
      if (retry !== undefined) return retry;
    }

    return null;
  }

  invalidate(): void {
    // The snapshot is whole-namespace, so a single name cannot be dropped in
    // isolation — and dropping the lot is correct anyway: the caller just wrote
    // to the store, and the write may have touched more than it names.
    this.snapshot = null;
    this.lastMissRefreshAt = -Infinity;

    // Bumping the generation is what makes the invalidate STICK. Without it:
    // a request triggers a refresh, that read captures the pre-write state, the
    // console then writes and calls invalidate(), and the in-flight read lands
    // afterwards and installs the values it captured BEFORE the write. The
    // snapshot would look fresh, be stale, and stay that way for a full TTL —
    // silently turning "a console write is instant" into "a console write is
    // ignored". A refresh that started before this point no longer commits.
    this.generation += 1;
  }

  private async ensureFresh(): Promise<void> {
    const snap = this.snapshot;
    if (snap && this.now() - snap.fetchedAt < this.ttlMs) return;
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    // Single-flight. Without this, a burst of concurrent requests on a cold or
    // just-expired snapshot each opens its own listing of the namespace.
    if (this.inflight) return this.inflight;

    const startedAt = this.generation;

    this.inflight = (async () => {
      try {
        const values = await this.resolver.resolve(this.namespace);
        // Discard a result that an invalidate() has already superseded. The read
        // is not wrong, just out of date: it began before a write we were told
        // about, so installing it would resurrect the pre-write values.
        if (this.generation !== startedAt) return;
        this.snapshot = { values, fetchedAt: this.now() };
      } catch (err) {
        if (!this.snapshot) throw err;
        // Serve stale. The message names the provider and the error; it never
        // names a secret, and it certainly never carries a value.
        this.warn(
          `[strad] secret provider "${this.name}" refresh failed; serving the ` +
            `last known good snapshot: ${errorSummary(err)}`,
        );
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }
}

/**
 * A one-line description of a failure, safe to log.
 *
 * The backend client (parameters/gcp.ts) already builds its errors from a method
 * and a resource path with the query string and any `:verb` stripped, so an
 * error message cannot carry a value. This function exists so that a NON-store
 * error (a TypeError, a network stack trace) is also flattened to one line
 * before it reaches a log.
 */
function errorSummary(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return "unknown error";
}
