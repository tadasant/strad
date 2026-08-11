export { createMCPServer, type CreateMCPServerOptions } from "./server.js";

export {
  ENV,
  ConfigError,
  loadConfig,
  missingCredentials,
  type TelegramConfig,
} from "./config.js";

export {
  UnknownChatError,
  type Account,
  type ChatKind,
  type ChatSummary,
  type HistoryQuery,
  type ListChatsQuery,
  type Message,
  type MessageAuthor,
  type MessagePage,
  type SearchQuery,
  type SendRequest,
  type SentMessage,
  type TelegramGateway,
} from "./gateway.js";

export {
  createGateway,
  createMtprotoClient,
  displayName,
  entityKind,
  mediaKind,
  parseChatRef,
  sameChatId,
  toChatSummary,
  toMessage,
  type MtprotoClient,
  type RawDialog,
  type RawEntity,
  type RawMessage,
} from "./mtproto.js";

export {
  parseToolGroups,
  registerTools,
  toolDefinitions,
  toolNames,
  type ToolGroup,
} from "./tools.js";

export { redact } from "./logging.js";

export type { GatewayFactory, ToolDefinition } from "./tools/shared.js";
