import type { StradConfig } from "../../config/schema.ts";
import { gatewayNamespace } from "../parameters/namespace.ts";
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
  DEFAULT_TTL_MS,
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
 * Build the runtime secret provider this deployment declares.
 *
 * `gateway.secrets.provider: env` returns a bare `EnvSecretProvider` — no cloud
 * client is constructed and no credential is looked for. That is the default and
 * it is what keeps strad deployable with no vendor attached.
 *
 * `gcp-parameter-store` builds the store provider over the gateway namespace,
 * optionally chained in front of the environment. It needs the ONE bootstrap
 * credential (`STRAD_PARAMS_*`, see parameters/resolver.ts). Missing it is a
 * hard failure and not a silent downgrade: a deployment that asked for the store
 * and quietly got env vars instead would look healthy while serving whatever
 * stale values happened to be baked in.
 */
export function buildSecretProvider(
  opts: BuildProviderOptions,
): SecretProvider {
  const env = opts.env ?? process.env;
  const settings = opts.config.gateway.secrets;
  const envProvider = new EnvSecretProvider(env);

  if (settings.provider === "env") return envProvider;

  const resolver =
    opts.resolver === undefined ? resolverFromEnv(env) : opts.resolver;
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
    {
      ttlMs: settings.ttlSeconds * 1000,
      negativeTtlMs: settings.negativeTtlSeconds * 1000,
    },
  );

  return settings.envFallback
    ? new ChainSecretProvider([store, envProvider])
    : store;
}
