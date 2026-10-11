export { createMCPServer, type CreateMCPServerOptions } from "./server.js";

export {
  ENV,
  fatsecretConfig,
  fatsecretCredentials,
  fdcApiKey,
  missingCredentials,
} from "./config.js";

export { parseToolGroups, registerTools, toolDefinitions, toolNames, type ToolGroup } from "./tools.js";

export { ATTRIBUTION, DAILY_CALL_BUDGET, scrubProxy } from "./remote/fatsecret.js";
export { defaultDataDir, LocalStore, missingDataFiles } from "./local/store.js";
export { NUTRIENT_KEYS, type Nutrients } from "./nutrients.js";
export type { ToolContext, ToolDefinition } from "./tools/shared.js";
