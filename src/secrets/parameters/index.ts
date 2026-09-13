/**
 * The parameter store — strad's store-agnostic secrets/parameters abstraction.
 *
 * A "parameter" is a value strad manages for one MCP server, addressed by the
 * canonical namespace `/strad/{env}/mcp/{slug}/{kind}/{VARIABLE}`. It is either
 * non-secret (readable) or secret (write-and-inject-only). GCP is the first
 * backend: Parameter Manager indexes everything, Secret Manager backs the secret
 * parts. See types.ts for the interface, gcp.ts for the implementation.
 */

export {
  type ParameterMeta,
  type ConsoleReadGrant,
  type CreateParameterInput,
  type ParameterAdmin,
  type ParameterResolver,
  type ParameterStore,
  type ResolvedNamespace,
  ParameterStoreError,
  UnreadablePayloadError,
} from "./types.ts";

export {
  createGcpParameterStore,
  parseAdminAccount,
  type GcpParameterStoreConfig,
} from "./gcp.ts";

export { resolverFromEnv, RESOLVER_ENV } from "./resolver.ts";

export {
  SERVER_PARAM_KINDS,
  type ServerParamKind,
  isServerParamKind,
  serverKindNamespace,
  serverNamespaces,
  layerNamespaces,
  isUsableValue,
  staticNamespace,
  oauthNamespace,
  oauthParameterPath,
  serverParameterPath,
  gatewayNamespace,
  gatewayParameterPath,
  parameterPath,
  validatePathPrefix,
  normalisePathPrefix,
  validateNamespace,
  normaliseNamespace,
} from "./namespace.ts";

/**
 * The console's variable-name gate, re-exported from where the RULE lives.
 *
 * It moved to `src/config/env-name.ts` because `src/config/schema.ts` enforces
 * the same rule on `paramsWritable:` / `paramsRefresh:` and could not import it
 * from here — this tree pulls in `wire.ts`. The console still imports it from
 * this barrel.
 */
export {
  validateVariableName,
  MAX_VARIABLE_LENGTH,
} from "../../config/env-name.ts";

export { parameterId, variableOf, type ParameterEnvelope } from "./wire.ts";

export { parseServiceAccount, type ServiceAccount } from "./service-account.ts";

export {
  probeCapabilities,
  cachedProbe,
  PROBE_PERMISSIONS,
  NO_CAPABILITIES,
  type Capabilities,
  type ProbeConfig,
} from "./capabilities.ts";
