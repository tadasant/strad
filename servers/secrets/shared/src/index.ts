export {
  ParameterManagerReadClient,
  ParameterManagerError,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  type ParametersReader,
  type ParameterMeta,
  type ParameterRecord,
  type ParametersClientConfig,
  type ServiceAccount,
} from "./parameter-manager.js";

// Vendored from src/secrets/parameters/wire.ts — see `npm run wire:sync`. Only
// what a consumer of this package already had; the rest of the wire is imported
// from the module directly, by the files in this tree that need it.
export {
  parameterId,
  variableOf,
  type ParameterEnvelope,
} from "./parameter-wire.js";

export {
  ENV,
  loadConfig,
  parseAccount,
  inManagedNamespace,
  type SecretsConfig,
} from "./config.js";

export { registerTools, toolDefinitions } from "./tools.js";

export { createMCPServer, type CreateMCPServerOptions } from "./server.js";

export {
  probeCapabilities,
  PROBE_PERMISSIONS,
  NO_CAPABILITIES,
  type Capabilities,
  type ProbeConfig,
} from "./capabilities.js";

export {
  createWriteClient,
  type ParametersWriter,
  type WriteClientConfig,
} from "./write-client.js";

export {
  tokenMinter,
  GoogleAuthError,
  SCOPE_CLOUD_PLATFORM,
} from "./google-auth.js";
