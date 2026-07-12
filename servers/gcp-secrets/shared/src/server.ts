import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SecretManagerReadClient, type SecretsReader } from "./client.js";
import { loadConfig, type GcpSecretsConfig } from "./config.js";
import { registerTools } from "./tools.js";

export interface CreateMCPServerOptions {
  version: string;
  /** Injected in tests; production reads the environment. */
  config?: GcpSecretsConfig;
  readerFactory?: () => SecretsReader;
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, so the collapsed bundle host can mount it exactly like
 * the other fourteen.
 *
 * Credentials are read LAZILY, at registerHandlers time, because the image ships
 * none — strad injects them onto the component at deploy time.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    { name: "gcp-secrets-mcp-server", version: options.version },
    { capabilities: { tools: {} } },
  );

  const registerHandlers = async (
    target: Server,
    readerFactory?: () => SecretsReader,
  ): Promise<void> => {
    const config = options.config ?? loadConfig();
    const factory =
      readerFactory ??
      options.readerFactory ??
      ((): SecretsReader => {
        if (!config.account) {
          throw new Error(
            "GCP_SECRETS_SERVICE_ACCOUNT_KEY_JSON is not configured; " +
              "this server cannot list secrets without a (read-only) credential.",
          );
        }
        return new SecretManagerReadClient({
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
