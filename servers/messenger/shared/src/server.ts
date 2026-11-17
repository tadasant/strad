import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { MessengerBridge, type BridgeOptions } from "./bridge.js";
import { loadConfig, missingCredentials, type MessengerConfig } from "./config.js";
import { errMessage, logWarning } from "./logging.js";
import { GcsBlobStore, type BlobStore } from "./state-store.js";
import { parseToolGroups, registerTools, type BridgeFactory, type ToolGroup } from "./tools.js";

export interface CreateMCPServerOptions {
  version: string;
  /** The environment this instance reads. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  toolGroups?: ToolGroup[];
  /** Injected in tests. Production reads the environment. */
  config?: MessengerConfig;
  /** Injected in tests. Production writes to GCS. */
  blobs?: BlobStore;
  /** Injected in tests: the fake bridge command, intervals. */
  bridgeOptions?: Partial<BridgeOptions>;
  /**
   * Start the bridge at once rather than on the first tool call. On by default
   * whenever the deployment is configured: Messenger delivers to a connected
   * device, and a bridge that waited for a poll would be offline until then.
   * Off (and nothing is touched) when a required variable is missing, which is
   * every bundle container that does not host this account.
   */
  autoStart?: boolean;
}

/**
 * The factory, in the shape every server in this repo uses, plus `close()`.
 *
 * ONE BRIDGE PER FACTORY CALL, for the life of the process. The bundle host
 * builds a fresh MCP Server per request and calls `registerHandlers` on it;
 * every one of those shares the bridge built here, because one Messenger
 * device is one connection.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const env = options.env ?? process.env;
  const server = new Server(
    { name: "strad-messenger", version: options.version },
    { capabilities: { tools: {} } },
  );

  let bridge: MessengerBridge | undefined;
  const getBridge = (): MessengerBridge => {
    if (!bridge) {
      // Throws a ConfigError naming what is missing; not memoised, so a
      // variable that arrives with a redeploy is picked up.
      const config = options.config ?? loadConfig(env);
      bridge = new MessengerBridge({
        config,
        blobs:
          options.blobs ??
          new GcsBlobStore({
            bucket: config.bucket,
            clientEmail: config.clientEmail,
            privateKey: config.privateKey,
            who: "the Messenger bridge",
            ...(config.privateKeyVariable ? { privateKeyVariable: config.privateKeyVariable } : {}),
            warn: logWarning,
          }),
        ...options.bridgeOptions,
      });
    }
    return bridge;
  };
  const bridgeFactory: BridgeFactory = async () => getBridge();

  const configured = options.config !== undefined || missingCredentials(env).length === 0;
  if ((options.autoStart ?? true) && configured) {
    try {
      void getBridge()
        .start()
        .catch((err: unknown) => logWarning(`start failed; the next tool call retries: ${errMessage(err)}`));
    } catch (err) {
      logWarning(`not starting: ${errMessage(err)}`);
    }
  }

  const registerHandlers = async (target: Server): Promise<void> => {
    registerTools(target, bridgeFactory, options.toolGroups ?? parseToolGroups(env.ENABLED_TOOLGROUPS));
  };

  const close = async (): Promise<void> => {
    await bridge?.close();
  };

  return { server, registerHandlers, close, bridge: () => bridge };
}
