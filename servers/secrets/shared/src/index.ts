export {
  ParameterManagerReadClient,
  ParameterManagerError,
  parameterId,
  variableOf,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  type ParametersReader,
  type ParameterMeta,
  type ParameterEnvelope,
  type ParameterRecord,
  type ParametersClientConfig,
  type ServiceAccount,
} from "./parameter-manager.js";

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
