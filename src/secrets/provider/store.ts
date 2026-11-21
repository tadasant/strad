import { isUsableValue } from "../parameters/namespace.ts";
import type { ParameterResolver } from "../parameters/types.ts";
import { NamespaceView } from "./view.ts";
import type { SecretProvider } from "./types.ts";

/**
 * Secrets from a parameter store, read AT RUNTIME.
 *
 * This is the provider that makes "add a secret, and prod picks it up" true. It
 * sits on top of the store-agnostic `ParameterResolver` (see ../parameters), so
 * the GCP backend is an implementation detail: any store that can resolve a
 * namespace into `VARIABLE -> value` plugs in here unchanged.
 *
 * Note what this file does NOT contain: a cloud client, or a cache. The
 * Parameter Manager + Secret Manager client already exists (../parameters/gcp.ts
 * — fetch plus a node:crypto JWT, no SDK), and it is the one that holds the
 * process's reading of the store — ONE snapshot, sliced per namespace, aged by
 * `gateway.secrets.ttlSeconds`. This class reuses that through the interface
 * rather than standing up a second way to talk to the same two stores or a
 * second timer over the same values. All that is added here is what a MISS
 * means, and what happens when the resolver throws.
 *
 * A parameter that EXISTS and holds no usable value — an un-dereferenced
 * `__REF__`, an empty payload — counts as a miss here rather than as a hit. See
 * the note in `get()`: it is what lets the layer beneath answer instead.
 *
 * The credential is the RESOLVER identity — `parametermanager.parameterViewer`
 * plus `parametermanager.parameterAccessor`, which is the role that carries
 * `parameterVersions.render`; the viewer role does not, and a resolver holding
 * only it lists every parameter and 403s on every value. Read-only by IAM. It is
 * deliberately neither the `secrets` MCP server's viewer key (which cannot read a
 * value at all) nor the console's admin key (which can write); see
 * ../parameters/types.ts for why those three are separate, and
 * scripts/render-spec.ts for where the distinction is enforced.
 *
 * ## Why the unit is a namespace and not a name
 *
 * A parameter store's natural read is a namespace, not a name — `resolve()` is
 * one slice of the snapshot, or one list plus one render per parameter when
 * the snapshot has expired. A per-name read would turn a page of ten `${REF}`s
 * into ten reads. So every `get` asks the resolver for the whole namespace and
 * picks one name out of it.
 *
 * ## What "immediately" means, precisely
 *
 * - **A change that tells the gateway** is instant: a write through strad's
 *   own console, a write through the `secrets` MCP server (its write tools call
 *   `refresh_gateway`), and the console's "Re-read the store" button all end in
 *   `invalidate()`, which drops the snapshot. This is the path a change is
 *   expected to take.
 * - **Rotation** of an existing secret that nobody announced is visible within
 *   `ttlSeconds` — a day by default: the resolver's snapshot is re-read on the
 *   first `get` after it goes stale. That is the fallback, not the mechanism.
 * - **Addition** of a name that was previously absent, likewise unannounced, is
 *   visible within `negativeTtlMs` — an hour by default. A miss asks the
 *   resolver to drop its snapshot and reads again, rate limited to once per
 *   `negativeTtlMs` so a genuinely unknown `${REF}` on a hot path cannot
 *   re-read the store once per request — and skipped outright when the
 *   snapshot is younger than that, because a name the store did not hold a
 *   moment ago is not going to be found by asking again.
 *
 * ## Failure posture
 *
 * A read that throws does NOT propagate if we still hold values: the last known
 * good ones are served and a warning is logged (name of the provider and the
 * error — never a value, never a name-to-value pairing). A store outage must not
 * take `/mcp` down; strad would otherwise trade "secrets are stale" for "the
 * gateway is offline", which is the worse failure by a wide margin.
 *
 * With nothing held — a cold start, or the read straight after `invalidate()`
 * — a failed read is retried within a small budget first (see
 * `src/secrets/provider/view.ts`), so one bad response right after a write is
 * not an outage. Once that budget is spent the error DOES propagate. There is
 * nothing to serve, and pretending the secret is absent would report a config
 * error for what is an outage.
 */
export interface StoreSecretProviderOptions {
  /** Minimum interval between miss-triggered re-reads. Default one hour. */
  negativeTtlMs?: number;
  /** Injected in tests so the clock is not the thing under test. */
  now?: () => number;
  /** Injected in tests to assert we never log a value. */
  onWarn?: (message: string) => void;
  /** Injected in tests so the nothing-held retry's backoff is not slept through. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests so the nothing-held retry's jitter is fixed. */
  random?: () => number;
}

export const DEFAULT_NEGATIVE_TTL_MS = 3_600_000;

export class StoreSecretProvider implements SecretProvider {
  readonly name: string;

  private readonly view: NamespaceView;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private lastMissRefreshAt = -Infinity;

  constructor(
    private readonly resolver: ParameterResolver,
    /** The namespace this provider reads, e.g. `/strad/prod/gateway/static/`. */
    private readonly namespace: string,
    opts: StoreSecretProviderOptions = {},
  ) {
    this.name = `store:${namespace}`;
    this.negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.view = new NamespaceView((ns) => resolver.resolve(ns), {
      now: opts.now,
      onWarn: opts.onWarn,
      sleep: opts.sleep,
      random: opts.random,
      label: `secret provider "${this.name}"`,
    });
  }

  async get(name: string): Promise<string | null> {
    const values = await this.view.get(this.namespace);

    // A HIT IS ONLY A HIT IF THE VALUE IS USABLE.
    //
    // `resolve()` does not promise a value: a `:render` that could not
    // dereference hands the `__REF__` pointer back, and an empty payload
    // resolves to `""`. Returning either would be a definitive answer made of a
    // non-credential — and, worse, it would stop `ChainSecretProvider` dead, so
    // the layer beneath (this slug's other kind, then the gateway namespace)
    // never gets asked and a credential that WORKS is suppressed by one that
    // does not. `layerNamespaces` applies the identical rule to the readers that
    // take whole namespaces at once; this is the same rule for the reader that
    // takes one name at a time.
    const hit = values[name];
    if (hit !== undefined && isUsableValue(hit)) return hit;

    // A MISS. The snapshot may simply predate the secret being added, which is
    // the case this whole class exists to serve. Ask the resolver to drop it
    // and read again — but no more often than negativeTtlMs, so an unknown ref
    // stays cheap.
    //
    // Skip it when the snapshot is younger than that: on a cold start the `get`
    // above has already read the store, and dropping a reading taken moments
    // ago would enumerate the project twice to learn the same thing. A resolver
    // that holds no snapshot reports `Infinity`, and is asked.
    const now = this.now();
    const snapshotAge = this.resolver.snapshotAgeMs?.() ?? Infinity;
    if (
      // `Infinity` is the per-server layer's "never chase", and it has to be
      // read as such rather than compared: Infinity >= Infinity is true.
      Number.isFinite(this.negativeTtlMs) &&
      snapshotAge >= this.negativeTtlMs &&
      now - this.lastMissRefreshAt >= this.negativeTtlMs
    ) {
      this.lastMissRefreshAt = now;
      this.resolver.forget?.();
      await this.view.refresh(this.namespace);
      const retry = this.view.peek(this.namespace)?.[name];
      if (retry !== undefined && isUsableValue(retry)) return retry;
    }

    return null;
  }

  invalidate(): void {
    // Whole-namespace, and whole-snapshot: the caller just wrote to the store,
    // and the write may have touched more than it names. Dropping the
    // resolver's snapshot is what makes the next `get` reach the store; the
    // view's own generation bump is what stops a read already in flight from
    // installing what it captured before the write.
    this.resolver.forget?.();
    this.view.invalidate(this.namespace);
    this.lastMissRefreshAt = -Infinity;
  }
}
