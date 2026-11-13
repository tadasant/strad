export { createMCPServer, type CreateMCPServerOptions } from "./server.js";

export {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_PORT,
  ENV,
  HOW_TO_SEED,
  SSH_REQUIRED_ENV_NAMES,
  loadConfig,
  missingCredentials,
  normalisePrivateKey,
  parseHint,
  type SshConfig,
} from "./config.js";

export {
  ConfigError,
  HostKeyMismatchError,
  InputError,
  SshUnreachableError,
} from "./errors.js";

export {
  describePins,
  fingerprintOf,
  hostKeyAlgorithms,
  matchesPin,
  parseHostKeyPins,
  type HostKeyPin,
} from "./host-key.js";

export {
  connect,
  dialTailnet,
  routeFor,
  shellQuote,
  MAX_DIRECTORY_ENTRIES,
  MAX_EXEC_WALL_MS,
  MAX_TRANSFER_BYTES,
  OUTPUT_HEAD_BYTES,
  OUTPUT_TAIL_BYTES,
  SshConnectError,
  type Connector,
  type DirectoryEntry,
  type ExecResult,
  type FileRead,
  type PresentedHostKey,
  type Route,
  type SshSession,
} from "./client.js";

export {
  parseToolGroups,
  registerTools,
  toolDefinitions,
  type ToolContext,
  type ToolDefinition,
  type ToolGroup,
} from "./tools.js";

export { redact } from "./logging.js";

export {
  TAILNET_SOCKS5_ENV,
  isTailnetAddress,
  isTailnetName,
  parseProxyAddress,
  socks5Connect,
  SocksProxyDownError,
  SocksReplyError,
  SocksTimeoutError,
  type ProxyAddress,
} from "./tailnet.js";
