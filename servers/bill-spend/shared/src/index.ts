export { createMCPServer, type CreateMCPServerOptions } from "./server.js";

export {
  BASE_URLS,
  ENV,
  ENVIRONMENTS,
  ConfigError,
  loadConfig,
  missingCredentials,
  readEnvironment,
  type BillConfig,
  type BillEnvironment,
} from "./config.js";

export {
  createHttp,
  describeErrors,
  paginate,
  parseErrors,
  PAGE_MAX,
  type BillHttp,
  type CreateHttpOptions,
  type Page,
  type RequestOptions,
} from "./client.js";

export {
  AuthError,
  BillApiError,
  InputError,
  LockedTransactionError,
  RateLimitError,
  WriteNotPersistedError,
  type BdcError,
  type WriteAttempt,
} from "./errors.js";

export {
  createGateway,
  type BillGateway,
  type CodingField,
  type CodingOption,
  type CodingWriteResult,
  type CreateGatewayOptions,
  type ListFieldsQuery,
  type ListOptionsQuery,
  type ListTransactionsQuery,
  type SetCodingRequest,
  type TransactionCoding,
  type TransactionSummary,
} from "./gateway.js";

export {
  buildUpdateBody,
  resolveIdentifier,
  selectionMatches,
  WIRE_VARIANTS,
  type FieldKey,
  type Identifier,
  type IdForm,
  type SelectedValue,
  type UpdateBody,
  type WireVariant,
} from "./wire.js";

export {
  parseToolGroups,
  registerTools,
  toolDefinitions,
  toolNames,
  type ToolGroup,
} from "./tools.js";

export { redact } from "./logging.js";

export type { GatewayFactory, ToolDefinition } from "./tools/shared.js";
