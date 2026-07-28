import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ParameterManagerReadClient,
  type ParametersReader,
} from "./parameter-manager.js";
import { loadConfig, type SecretsConfig } from "./config.js";
import { registerTools } from "./tools.js";
import {
  NO_CAPABILITIES,
  probeCapabilities,
  type Capabilities,
} from "./capabilities.js";
import { createWriteClient, type ParametersWriter } from "./write-client.js";

export interface CreateMCPServerOptions {
  version: string;
  /** Injected in tests; production reads the environment. */
  config?: SecretsConfig;
  readerFactory?: () => ParametersReader;
  /**
   * Test seam: override the capability probe. Production asks Google once, at
   * registerHandlers time, and caches the answer for the process lifetime — an
   * IAM grant does not change mid-request, and the tool LIST must be stable
   * within a session or a client's cached listing goes stale in a confusing way.
   */
  capabilities?: () => Promise<Capabilities>;
  writerFactory?: () => ParametersWriter;
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

    // ONE probe per process. Memoised rather than per-request: the answer is a
    // property of the credential, and re-asking on every tools/list would add a
    // round trip to every listing for a value that changes when a human edits
    // IAM. A revoked permission still fails closed at Google.
    let probed: Promise<Capabilities> | undefined;
    const capabilities =
      options.capabilities ??
      (() => {
        probed ??= config.account
          ? probeCapabilities({
              projectId: config.projectId,
              account: config.account,
              tokenUrl: config.tokenUrl,
            })
          : Promise.resolve({
              ...NO_CAPABILITIES,
              reason: "no credential is configured for this server",
            });
        return probed;
      });

    // The mutating client is built LAZILY and only ever reached through a
    // capability check in tools.ts. Constructing it is not the permission; the
    // probe is.
    let writer: ParametersWriter | undefined;
    const writerFactory =
      options.writerFactory ??
      ((): ParametersWriter => {
        if (!config.account) {
          throw new Error("no credential is configured for this server");
        }
        writer ??= createWriteClient({
          projectId: config.projectId,
          account: config.account,
          pmApiBase: config.apiBase,
          tokenUrl: config.tokenUrl,
        });
        return writer;
      });

    registerTools(target, {
      config,
      reader: factory,
      capabilities,
      writer: writerFactory,
    });
  };

  return { server, registerHandlers };
}
