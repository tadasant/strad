import type { ParameterResolver } from "../parameters/types.ts";
import { SnapshotCache } from "./snapshot.ts";
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
 * one list plus one render per parameter. A per-name cache would turn a page of
 * ten `${REF}`s into ten full listings. So the cache (see snapshot.ts, shared
 * with the registry's `params:` resolution) holds ONE map of the whole namespace.
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

export class StoreSecretProvider implements SecretProvider {
  readonly name: string;

  private readonly cache: SnapshotCache;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private lastMissRefreshAt = -Infinity;

  constructor(
    resolver: ParameterResolver,
    /** The namespace this provider reads, e.g. `/strad/prod/gateway/static/`. */
    private readonly namespace: string,
    opts: StoreSecretProviderOptions = {},
  ) {
    this.name = `store:${namespace}`;
    this.negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.cache = new SnapshotCache((ns) => resolver.resolve(ns), {
      ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
      now: opts.now,
      onWarn: opts.onWarn,
      label: `secret provider "${this.name}"`,
    });
  }

  async get(name: string): Promise<string | null> {
    const values = await this.cache.get(this.namespace);

    const hit = values[name];
    if (hit !== undefined) return hit;

    // A MISS. The snapshot may simply predate the secret being added, which is
    // the case this whole class exists to serve. Force one refresh — but no more
    // often than negativeTtlMs, so an unknown ref stays cheap.
    //
    // Skip it when the values we just read were fetched moments ago: on a cold
    // start the `get` above has already done a live read, and refreshing again
    // would list the namespace twice to learn the same thing.
    const now = this.now();
    const justFetched = this.cache.age(this.namespace) < this.negativeTtlMs;
    if (!justFetched && now - this.lastMissRefreshAt >= this.negativeTtlMs) {
      this.lastMissRefreshAt = now;
      await this.cache.refresh(this.namespace);
      const retry = this.cache.peek(this.namespace)?.[name];
      if (retry !== undefined) return retry;
    }

    return null;
  }

  invalidate(): void {
    // The snapshot is whole-namespace, so a single name cannot be dropped in
    // isolation — and dropping the lot is correct anyway: the caller just wrote
    // to the store, and the write may have touched more than it names.
    this.cache.invalidate(this.namespace);
    this.lastMissRefreshAt = -Infinity;
  }
}
