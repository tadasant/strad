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
  type CreateParameterInput,
  type ParameterAdmin,
  type ParameterResolver,
  type ParameterStore,
  ParameterStoreError,
} from "./types.ts";

export {
  createGcpParameterStore,
  parseAdminAccount,
  type GcpParameterStoreConfig,
} from "./gcp.ts";

export {
  resolveServerParams,
  resolverFromEnv,
  RESOLVER_ENV,
} from "./resolver.ts";

export {
  staticNamespace,
  gatewayNamespace,
  gatewayParameterPath,
  parameterPath,
  parameterId,
  variableOf,
  validateVariableName,
  validatePathPrefix,
  normalisePathPrefix,
  type ParameterEnvelope,
} from "./namespace.ts";

export { parseServiceAccount, type ServiceAccount } from "./service-account.ts";

export {
  probeCapabilities,
  cachedProbe,
  PROBE_PERMISSIONS,
  NO_CAPABILITIES,
  type Capabilities,
  type ProbeConfig,
} from "./capabilities.ts";
