export {
  SecretManagerReadClient,
  SecretManagerError,
  NOTE_ANNOTATION,
  type SecretsReader,
  type SecretMeta,
  type SecretsClientConfig,
  type ServiceAccount,
} from "./client.js";

export {
  ENV,
  loadConfig,
  parseAccount,
  inManagedNamespace,
  type GcpSecretsConfig,
} from "./config.js";

export { registerTools, toolDefinitions } from "./tools.js";

export { createMCPServer, type CreateMCPServerOptions } from "./server.js";
