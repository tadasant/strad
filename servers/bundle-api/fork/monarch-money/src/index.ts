export {
  createMCPServer,
  type ClientFactory,
  type CreateMCPServerOptions,
  buildMonarchClient,
  MonarchAuthError,
  defaultSessionPath,
  type IMonarchClient,
  type MonarchClient,
  type SessionStore,
} from './server.js';

export {
  createGraphQLTransport,
  MonarchGraphQLError,
  type GraphQLTransport,
} from './monarch-client/graphql-transport.js';

export {
  createFileSessionStore,
  createMemorySessionStore,
  defaultStateDir,
} from './monarch-client/session-store.js';

export {
  generateDeviceUuid,
  login,
  MonarchEmailOtpRequiredError,
  MonarchTotpRequiredError,
  MonarchLoginRejectedError,
  MonarchCaptchaRequiredError,
  type LoginInput,
  type LoginResult,
} from './monarch-client/auth.js';

export {
  MonarchAuthManager,
  type AuthManagerOptions,
  type AuthStatus,
} from './monarch-client/auth-manager.js';

export {
  normaliseCookieHeader,
  mergeSetCookies,
  type MonarchCredential,
} from './monarch-client/credentials.js';

export * from './types.js';
