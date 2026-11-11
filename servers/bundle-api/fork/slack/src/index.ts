// Main exports for Slack MCP Server

// Server and client
export {
  createMCPServer,
  SlackClient,
  type ISlackClient,
  type ClientFactory,
  type CreateMCPServerOptions,
  type DownloadOutcome,
} from './server.js';

// The signed download link. Exported for the bundle host, which serves the route
// the token is presented at, and for this tree's own tests.
export {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  NonceLedger,
  deriveKey,
  mintDownloadToken,
  verifyDownloadToken,
  type MintedLink,
  type VerifyResult,
} from './download-link.js';

// Tools
export { createRegisterTools, registerTools } from './tools.js';

// Logging utilities
export { logServerStart, logError, logWarning, logDebug } from './logging.js';

// Types
export type {
  Channel,
  Message,
  Reaction,
  Attachment,
  Block,
  ThreadWithReplies,
  User,
  PaginatedResponse,
} from './types.js';

// MCP Events (draft SEP-3415, poll mode). See src/events/protocol.ts.
export { SlackEventsIngest, type IngestDeps, type WebSocketLike } from './events/ingest.js';
export { EVENTS_EXTENSION, MESSAGE_POSTED_DESCRIPTOR } from './events/protocol.js';
export { MemoryBlobStore } from './events/blob-store.js';
