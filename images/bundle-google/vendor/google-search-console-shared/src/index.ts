export {
  createMCPServer,
  createDefaultClient,
  missingCredentials,
  GOOGLE_SEARCH_CONSOLE_SCOPES,
  GOOGLE_SEARCH_CONSOLE_ENV_NAMES,
  GOOGLE_SEARCH_CONSOLE_OAUTH_APP_ENV_NAMES,
  GOOGLE_SEARCH_CONSOLE_RECONNECT_URL_ENV,
  type IGoogleSearchConsoleClient,
  type CreateMCPServerOptions,
  type ClientFactory,
  type EnvLike,
} from './server.js';
export { READ_TOOLS, createRegisterTools, toolNames } from './tools.js';
export { SearchConsoleApiError } from './client/api-errors.js';
export * from './types.js';
