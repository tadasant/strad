// Core server exports
export {
  createMCPServer,
  GoodEggsClient,
  extractProductId,
  findCartItemForUrl,
  isPostSignInUrl,
  reconcileAddResult,
  type ReconcileAddParams,
  parseBasketUpdateResponse,
  type BasketUpdateOutcome,
  BASKET_UPDATE_PATH,
  ADD_BUTTON_SELECTOR,
  setSharedBrowserProvider,
  type SharedBrowserProvider,
  type IGoodEggsClient,
  type ClientFactory,
  type LoginFailedCallback,
  type LoginRecoveredCallback,
  type CreateMCPServerOptions,
  type RegisterHandlersOptions,
} from './server.js';

// Tools exports
export { createRegisterTools, type RegisterToolsOptions } from './tools.js';

// Basket state exports — the authoritative read path (see FORK.md #1)
export {
  extractStoreData,
  cartItemsFromStoreData,
  basketSnapshotFromHtml,
  productNameFromHtml,
  basketItemProductId,
  formatCents,
  type GoodEggsStoreData,
  type StoreBasketItem,
  type StoreProduct,
  type BasketSnapshot,
} from './basketState.js';

// Past orders — read from the payload, matched by calendar date (see FORK.md #11)
export {
  pastOrdersFromStoreData,
  parseOrderDateQuery,
  findPastOrder,
  pastOrderItemsFromStoreData,
  DEFAULT_ORDER_TIMEZONE,
  type OrderDateQuery,
  type PastOrdersStoreData,
  type StorePastOrder,
  type StoreOrderItem,
} from './pastOrders.js';

// Nutrition — Good Eggs Kitchen's published tables, and photo URLs (see FORK.md #12)
export {
  groceryNutritionFromHtml,
  parseKitchenNutritionArticles,
  matchKitchenRow,
  normalizeName,
  splitRecipeName,
  productImageFromUrl,
  HttpKitchenNutritionSource,
  setKitchenNutritionSource,
  getKitchenNutritionSource,
  KITCHEN_PRODUCER_SLUG,
  KITCHEN_NUTRITION_API_URL,
  KITCHEN_NUTRITION_SECTION_URL,
  type GroceryNutrition,
  type NutritionFacts,
  type NutritionStatus,
  type KitchenNutritionRow,
  type KitchenNutritionSource,
  type ProductImage,
} from './nutrition.js';

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

// Availability — whether a product can be had on the basket's day (see FORK.md #14)
export {
  productAvailabilityFromStoreData,
  productAvailabilityFromHtml,
  groceryDetailsFromStoreData,
  unavailableAddMessage,
  describeDay,
  describeStatus,
  type DayAvailability,
  type ProductAvailability,
} from './availability.js';
