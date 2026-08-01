// Core server exports
export {
  createMCPServer,
  FetchPetClient,
  setSharedBrowserProvider,
  type SharedBrowserProvider,
  type IFetchPetClient,
  type ClientFactory,
  type CreateMCPServerOptions,
  type LoginFailedCallback,
  type LoginRecoveredCallback,
} from './server.js';

// The login form selectors, and the waiting fill they must be used with.
export {
  EMAIL_FIELD_SELECTOR,
  PASSWORD_FIELD_SELECTOR,
  fillLoginField,
  type LoginPage,
  type LoginLocator,
} from './login.js';

// Tools exports
export { createRegisterTools } from './tools.js';

// Types exports
export type {
  Claim,
  ClaimDetails,
  ClaimSubmissionData,
  ClaimSubmissionResult,
  FetchPetConfig,
} from './types.js';

// Logging exports (re-exported for convenience)
export { logServerStart, logError, logWarning, logDebug } from './logging.js';
