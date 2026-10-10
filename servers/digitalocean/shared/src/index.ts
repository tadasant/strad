export { createMCPServer, type CreateMCPServerOptions } from "./server.js";

export {
  ConfigError,
  DEFAULT_BASE_URL,
  ENV,
  HOW_TO_GET_IT,
  loadConfig,
  missingCredentials,
  type DigitalOceanConfig,
} from "./config.js";

export {
  createClient,
  listPage,
  REQUEST_TIMEOUT_MS,
  type CreateClientOptions,
  type DigitalOceanClient,
  type Page,
  type RequestOptions,
} from "./client.js";

export { DigitalOceanApiError, InputError, TimeoutError } from "./errors.js";

export {
  parseToolGroups,
  registerTools,
  toolDefinitions,
  toolNames,
  type ToolGroup,
} from "./tools.js";

export { redact } from "./logging.js";
export { redactSecrets, redactUriPasswords, REDACTED } from "./secrets.js";

export type { ClientFactory, ToolDefinition } from "./tools/shared.js";
