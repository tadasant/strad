import type { StradConfig } from "../../config/schema.ts";
import { gatewayNamespace, serverNamespaces } from "../parameters/namespace.ts";
import { resolverFromEnv } from "../parameters/resolver.ts";
import type { ParameterResolver } from "../parameters/types.ts";
import { ChainSecretProvider } from "./chain.ts";
import { EnvSecretProvider } from "./env.ts";
import { StoreSecretProvider } from "./store.ts";
import type { SecretProvider } from "./types.ts";

export { type SecretProvider, SecretNotFoundError } from "./types.ts";
export { EnvSecretProvider } from "./env.ts";
export { ChainSecretProvider } from "./chain.ts";
export {
  StoreSecretProvider,
  DEFAULT_NEGATIVE_TTL_MS,
  type StoreSecretProviderOptions,
} from "./store.ts";
export {
  refsIn,
  resolveRefsAsync,
  resolveMapAsync,
  resolveOptionsAsync,
} from "./resolve.ts";
export {
  hydrateBootEnv,
  bootEnvNames,
  CORE_BOOT_ENV_KEYS,
  BUNDLE_BOOT_ENV_KEYS,
} from "./hydrate.ts";

export interface BuildProviderOptions {
  config: StradConfig;
  env?: NodeJS.ProcessEnv;
  /**
   * Override the store client. Supplied by tests; in production it is built
   * from the bootstrap credential in the environment.
   */
  resolver?: ParameterResolver | null;
}

/**
 * The runtime secret providers this deployment reads `${NAME}` through.
 *
 * TWO of them, because a `${NAME}` reference has an OWNER. A name written in a
 * server entry belongs to that server; a name the deployment itself needs
 * (`STRAD_TOKENS`, the console's OAuth client) belongs to nobody in particular.
 * Handing every caller one provider made those the same thing, and made the
 * per-slug namespace unreadable at runtime — the whole reason this type exists.
 */
export interface ServerSecretProviders {
  /**
   * The deployment-wide provider: the gateway namespace, optionally chained in
   * front of the environment.
   *
   * For the gateway's own keys and for anything with no server to attribute it
   * to. Also the LAST layer of every per-server provider, which is what keeps
   * every existing deployment working unchanged.
   */
  readonly shared: SecretProvider;
  /**
   * The gateway namespace's STORE layer alone, WITHOUT the environment behind it.
   * Absent under `gateway.secrets.provider: env`, where there is no store.
   *
   * `shared` above is the right seam for a `${NAME}`: the env fallback is what
   * makes the migration off deploy-time baking reversible, and a name that has
   * not moved yet must still resolve. It is the WRONG seam for anything whose
   * absence from the store is itself the answer — and `STRAD_TOKENS` is exactly
   * that. `hydrateBootEnv` puts a copy of the roster in `process.env` at boot,
   * so on a store-backed core the chain's second layer is a FROZEN roster that
   * never changes again; a parameter that is later destroyed, or that renders to
   * nothing, would fall through to it and start admitting every token that was
   * live at boot, revocations included. The token store therefore reads this
   * layer, where a miss is a miss.
   */
  readonly gatewayStore?: SecretProvider;
  /**
   * The provider one server's own `${NAME}` refs resolve against: that server's
   * `/strad/{env}/mcp/{slug}/static/` namespace FIRST, `shared` second.
   *
   * Memoised per slug — the layer holds the last good values for its
   * namespace, and a fresh one per call would have nothing to serve through a
   * store outage.
   */
  forServer(slug: string): SecretProvider;
  /**
   * Drop the process's reading of the store, so the next `get` anywhere reaches
   * it. What a write through strad's own console calls.
   */
  invalidate(name?: string): void;
}

/**
 * Lift ONE provider into the set, with no per-server layer.
 *
 * The honest shape for every deployment that has no per-slug namespace to read:
 * the `env` provider, where a container's `process.env` is flat, and any caller
 * holding a single provider (a test, a tool that builds its own). `forServer`
 * returning the same object is the correct answer there, not a stub.
 */
export function sharedSecretProviders(
  provider: SecretProvider,
): ServerSecretProviders {
  return {
    shared: provider,
    // Deliberately absent. This lifts ONE provider with nothing behind it, so
    // there is no chain to leak through — but there is also no store, and a
    // caller that asked for the store layer must not be handed `process.env`
    // wearing its name.
    forServer: () => provider,
    invalidate: (name?: string) => provider.invalidate(name),
  };
}

/**
 * Build the runtime secret providers this deployment declares.
 *
 * `gateway.secrets.provider: env` returns a bare `EnvSecretProvider` — no cloud
 * client is constructed and no credential is looked for. That is the default and
 * it is what keeps strad deployable with no vendor attached. `forServer` is the
 * SAME provider there, and not as a shortcut: a container has one `process.env`
 * and there is no per-slug layer for it to have.
 *
 * `gcp-parameter-store` builds the store provider over the gateway namespace,
 * optionally chained in front of the environment. It needs the ONE bootstrap
 * credential (`STRAD_PARAMS_*`, see parameters/resolver.ts). Missing it is a
 * hard failure and not a silent downgrade: a deployment that asked for the store
 * and quietly got env vars instead would look healthy while serving whatever
 * stale values happened to be baked in.
 *
 * ## One reading of the store, however many providers
 *
 * Every provider built here — the shared one and each per-server one — asks
 * the SAME resolver, and the resolver holds ONE snapshot of the whole store for
 * `gateway.secrets.ttlSeconds` (parameters/gcp.ts). A provider is a slice of
 * that, not a reader of its own: adding a slug adds a namespace to slice and
 * not a timer that enumerates the project. The resolver handed in is built with
 * that TTL by the caller (src/index.ts); the one built here from the
 * environment is too.
 *
 * ## The per-server layer
 *
 *     1. /strad/{env}/mcp/{slug}/static/{NAME}   — this server's own namespace
 *     2. the shared provider                      — gateway namespace, then env
 *
 * This is the SAME layering `src/deploy/server-namespaces.ts` already applies to
 * a supplementary image's `env:` at render time, applied to the other half of
 * the system — the refs strad resolves in its OWN process, which is every
 * `url:`, every `headers:` and every builtin `options:` value. Those had exactly
 * one source, the gateway namespace, so a credential belonging to one server had
 * to be filed in the deployment-wide namespace to be readable at all. For an
 * unhosted server (`remote-http`, `local-tunnel`) that was the only source there
 * was: it runs no container, so `params: true` and the render-time layer are
 * both closed to it.
 *
 * The server's own namespace WINS, for the reason it wins at render time: the
 * shared namespace is where every existing name already is, so a gateway-first
 * order would mean a per-server value could never take effect.
 *
 * It costs nothing where nobody uses it. The layer is LAZY — a `StoreSecretProvider`
 * reads on first `get`, and `forServer` is only asked for a slug that references
 * a `${NAME}` at all — and an empty namespace is an empty slice of the snapshot,
 * so layer 1 misses and layer 2 answers exactly as it did before.
 *
 * ## Why the per-server layer does not chase a miss
 *
 * `negativeTtlMs: Infinity` turns off `StoreSecretProvider`'s miss-triggered
 * re-read for layer 1 only. A miss there is the NORMAL case — most names live in
 * the shared namespace and always will — and chasing one drops the whole
 * snapshot and enumerates the project again, so chasing every one of them would
 * re-read the store for each gateway-resolved name on each slug. The ordinary
 * TTL still re-reads it, so a newly seeded per-server value takes effect within
 * `ttlSeconds` rather than `negativeTtlSeconds`. The shared layer keeps its miss
 * re-read, which is where a brand-new name actually shows up.
 */
export function buildSecretProviders(
  opts: BuildProviderOptions,
): ServerSecretProviders {
  const env = opts.env ?? process.env;
  const settings = opts.config.gateway.secrets;
  const envProvider = new EnvSecretProvider(env);

  if (settings.provider === "env") return sharedSecretProviders(envProvider);

  const resolver =
    opts.resolver === undefined
      ? resolverFromEnv(env, { snapshotTtlMs: settings.ttlSeconds * 1000 })
      : opts.resolver;
  if (!resolver) {
    throw new Error(
      'gateway.secrets.provider is "gcp-parameter-store" but no store ' +
        "credential is configured. Set STRAD_PARAMS_PROJECT_ID and " +
        "STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON, or set the provider " +
        'to "env".',
    );
  }

  const store = new StoreSecretProvider(
    resolver,
    gatewayNamespace(opts.config.gateway.env),
    { negativeTtlMs: settings.negativeTtlSeconds * 1000 },
  );

  const shared: SecretProvider = settings.envFallback
    ? new ChainSecretProvider([store, envProvider])
    : store;

  const perServer = new Map<string, SecretProvider>();
  const forServer = (slug: string): SecretProvider => {
    const held = perServer.get(slug);
    if (held) return held;
    // ONE PROVIDER PER KIND, in precedence order — `oauth/` then `static/`.
    //
    // Each slices the SAME process snapshot of the store (see gcp.ts
    // `snapshot()`), so the extra layer costs a map lookup rather than a round
    // trip, and a slug with nothing under `oauth/` resolves exactly as it did.
    const own = serverNamespaces(opts.config.gateway.env, slug).map(
      (namespace) =>
        new StoreSecretProvider(resolver, namespace, {
          negativeTtlMs: Infinity,
        }),
    );
    // ChainSecretProvider unchanged, including its rule that a THROW does not
    // fall through. An unreachable store must not silently demote a server to
    // whatever the shared namespace happens to hold — that is how a rotated
    // credential comes back from the dead. It is also the semantics a
    // `params: true` server already has for the same namespaces, resolved by the
    // registry's parameter cache, so the two halves of `/mcp/{slug}/` fail the
    // same way.
    const chained = new ChainSecretProvider([...own, shared]);
    perServer.set(slug, chained);
    return chained;
  };

  return {
    shared,
    gatewayStore: store,
    forServer,
    invalidate: (name?: string) => {
      shared.invalidate(name);
      for (const provider of perServer.values()) provider.invalidate(name);
    },
  };
}
