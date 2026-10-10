export { createMCPServer, type CreateMCPServerOptions } from "./server.js";

export {
  API_BASE_URL,
  CONTENT_BASE_URL,
  ConfigError,
  ENV,
  HOW_TO_GET_IT,
  loadConfig,
  missingCredentials,
  type AirtableConfig,
} from "./config.js";

export {
  buildSearchFormula,
  createClient,
  PAGE_SIZE,
  REQUEST_TIMEOUT_MS,
  type AirtableClient,
  type AirtableRecord,
  type CreateClientOptions,
  type RecordPage,
} from "./client.js";

export {
  AirtableApiError,
  InputError,
  RateLimitError,
  TransportError,
} from "./errors.js";

export {
  parseToolGroups,
  registerTools,
  toolDefinitions,
  toolNames,
  type ToolGroup,
} from "./tools.js";

export { redact, scrubSecret } from "./logging.js";

export type { ClientFactory, ToolDefinition } from "./tools/shared.js";
