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
   * Test seam: override the capability probe. Production asks Google on the
   * first listing that needs an answer and caches it for the lifetime of the
   * factory — an IAM grant does not change mid-request, and the tool LIST must
   * be stable within a session or a client's cached listing goes stale in a
   * confusing way.
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

  // Process-lifetime memos, and they have to live OUT here.
  //
  // The bundle host serves this mount statelessly: a fresh `Server` and a fresh
  // `registerHandlers` call PER HTTP REQUEST. Anything declared inside that
  // function is therefore per-request, and a memo that is per-request is not a
  // memo — it is a round trip to Google (an OAuth token mint plus
  // `projects:testIamPermissions`) added to every single `tools/list`, which is
  // what made this mount's listing several times slower than its peers'.
  let probed: Promise<Capabilities> | undefined;
  let writer: ParametersWriter | undefined;

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
