export { createMCPServer, type CreateMCPServerOptions } from "./server.js";

export {
  ConfigError,
  DEFAULT_BASE_URL,
  ENV,
  loadConfig,
  missingCredentials,
  type AeroConfig,
} from "./config.js";

export {
  createClient,
  describeError,
  MAX_PAGES_CAP,
  nextCursor,
  REQUEST_TIMEOUT_MS,
  type AeroClient,
  type CreateClientOptions,
  type Query,
} from "./client.js";

export {
  AeroApiError,
  AuthError,
  InputError,
  NotFoundError,
  PlanError,
  RateLimitError,
} from "./errors.js";

export {
  parseToolGroups,
  registerTools,
  toolDefinitions,
  toolNames,
  type ToolGroup,
} from "./tools.js";

export { redact } from "./logging.js";
export { compact, downsample } from "./shape.js";

export type { ToolContext, ToolDefinition } from "./tools/shared.js";
