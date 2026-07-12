// Core server exports
export {
  createMCPServer,
  GoodEggsClient,
  type IGoodEggsClient,
  type ClientFactory,
  type CreateMCPServerOptions,
  type RegisterHandlersOptions,
} from './server.js';

// Tools exports
export { createRegisterTools, type RegisterToolsOptions } from './tools.js';

// MCP App (io.modelcontextprotocol/ui) exports
export {
  MCP_APPS_EXTENSION,
  SEARCH_APP_URI,
  SEARCH_APP_NAME,
  SEARCH_APP_MIME,
  SEARCH_APP_TOOL,
  clientSupportsApps,
  searchAppToolMeta,
  serializeForScript,
  renderSearchAppHtml,
  type AppClientCapabilities,
} from './appUi.js';

// Types exports
export type {
  GroceryItem,
  GroceryDetails,
  PastOrder,
  CartResult,
  CartItem,
  GoodEggsConfig,
} from './types.js';

// Logging exports (re-exported for convenience)
export { logServerStart, logError, logWarning, logDebug } from './logging.js';
