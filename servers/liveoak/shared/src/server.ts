import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ApitureOptions } from "./apiture.js";
import type { CognitoOptions } from "./cognito.js";
import { downloadLinkConfig, loadConfig, missingCredentials, type LiveOakConfig } from "./config.js";
import { GcsBlobStore, type BlobStore } from "./gcs.js";
import { logInfo, redact, errMessage, registerSecret } from "./logging.js";
import { LiveOakService, type DownloadOutcome } from "./service.js";
import { parseToolGroups, registerTools, type ServiceFactory, type ToolGroup } from "./tools.js";

export interface CreateMCPServerOptions {
  version: string;
  /** The environment this instance reads. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  toolGroups?: ToolGroup[];
  /** Injected in tests. Production reads the environment. */
  config?: LiveOakConfig;
  /** Injected in tests. Production writes to GCS. */
  blobs?: BlobStore;
  /** Injected in tests: a fake Cognito endpoint. */
  cognito?: CognitoOptions;
  /** Injected in tests: a fake Apiture root. */
  apiture?: ApitureOptions;
  now?: () => number;
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, plus `handleDownload` for the bundle host's
 * `/liveoak/download/:token`.
 *
 * ONE SERVICE PER FACTORY CALL, for the life of the process. The bundle host
 * builds a fresh MCP Server per request and calls `registerHandlers` on it;
 * every one of those shares the service built here, because a pending
 * enrolment and a statement's download bytes live in its memory between calls.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const env = options.env ?? process.env;
  const server = new Server(
    { name: "strad-liveoak", version: options.version },
    { capabilities: { tools: {} } },
  );

  let service: LiveOakService | undefined;
  const getService = (): LiveOakService => {
    if (!service) {
      // Throws a ConfigError naming the missing variables; not memoised, so a
      // variable that arrives later (a redeploy) is picked up.
      const config = options.config ?? loadConfig(env);
      registerSecret(config.password);
      service = new LiveOakService({
        config,
        blobs:
          options.blobs ??
          new GcsBlobStore({
            bucket: config.bucket,
            clientEmail: config.clientEmail,
            privateKey: config.privateKey,
          }),
        ...(options.cognito ? { cognito: options.cognito } : {}),
        ...(options.apiture ? { apiture: options.apiture } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    }
    return service;
  };
  const serviceFactory: ServiceFactory = async () => getService();

  const configured = options.config !== undefined || missingCredentials(env).length === 0;
  if (configured && !options.config) {
    const link = downloadLinkConfig(env);
    logInfo(
      link.downloadLink
        ? `statements: download links will be minted for gateway slug "${link.downloadLink.publicSlug}"`
        : `statements: ${link.downloadUnavailable}; get_statement returns no link`,
    );
  }

  const registerHandlers = async (target: Server): Promise<void> => {
    registerTools(target, serviceFactory, options.toolGroups ?? parseToolGroups(env.ENABLED_TOOLGROUPS));
  };

  /**
   * A signed link minted by get_statement, presented through core's
   * `/mcp-download/:slug/`. A container with no LiveOak config answers 404
   * without building anything.
   */
  const handleDownload = async (token: string): Promise<DownloadOutcome> => {
    if (!configured) return { ok: false, status: 404, error: "not_configured" };
    try {
      return await getService().handleDownload(token);
    } catch (err) {
      return { ok: false, status: 503, error: redact(errMessage(err)) };
    }
  };

  return { server, registerHandlers, handleDownload };
}
