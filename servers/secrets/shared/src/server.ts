import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ParameterManagerReadClient,
  type ParametersReader,
} from "./parameter-manager.js";
import { loadConfig, type SecretsConfig } from "./config.js";
import { registerTools } from "./tools.js";

export interface CreateMCPServerOptions {
  version: string;
  /** Injected in tests; production reads the environment. */
  config?: SecretsConfig;
  readerFactory?: () => ParametersReader;
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, so the collapsed bundle host can mount it exactly like
 * the others.
 *
 * Credentials are read LAZILY, at registerHandlers time, because the image ships
 * none — strad injects them onto the component at deploy time.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    { name: "secrets-mcp-server", version: options.version },
    { capabilities: { tools: {} } },
  );

  const registerHandlers = async (
    target: Server,
    readerFactory?: () => ParametersReader,
  ): Promise<void> => {
    const config = options.config ?? loadConfig();
    const factory =
      readerFactory ??
      options.readerFactory ??
      ((): ParametersReader => {
        if (!config.account) {
          throw new Error(
            "SECRETS_SERVICE_ACCOUNT_KEY_JSON is not configured; " +
              "this server cannot list parameters without a (viewer) credential.",
          );
        }
        return new ParameterManagerReadClient({
          projectId: config.projectId,
          account: config.account,
          apiBase: config.apiBase,
          tokenUrl: config.tokenUrl,
        });
      });

    registerTools(target, { config, reader: factory });
  };

  return { server, registerHandlers };
}
