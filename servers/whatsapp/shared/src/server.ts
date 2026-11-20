import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { GcsBlobStore, type BlobStore } from "./state-store.js";
import { WhatsAppBridge, type BridgeOptions, type DownloadOutcome } from "./bridge.js";
import {
  downloadLinkConfig,
  loadConfig,
  missingCredentials,
  type WhatsAppConfig,
} from "./config.js";
import { errMessage, logInfo, logWarning, redact } from "./logging.js";
import { createBaileysSocket, type SocketFactory } from "./socket.js";
import { parseToolGroups, registerTools, type ToolGroup } from "./tools.js";
import type { BridgeFactory } from "./tools/shared.js";
import { eventsRequested, WhatsAppEvents } from "./events/ingest.js";
import { registerWhatsAppEventHandlers } from "./events/protocol.js";
import type { WebhookTransport } from "./events/webhook/transport.js";

export interface CreateMCPServerOptions {
  version: string;
  /** The environment this instance reads. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  toolGroups?: ToolGroup[];
  /** Injected in tests. Production reads the environment. */
  config?: WhatsAppConfig;
  /** Injected in tests. Production writes to GCS. */
  blobs?: BlobStore;
  /** Injected in tests. Production opens a Baileys socket. */
  socketFactory?: SocketFactory;
  /** Injected in tests: pacing, timers, clock. */
  bridgeOptions?: Partial<BridgeOptions>;
  /**
   * Start the bridge now — claim the lease, restore the login, connect —
   * rather than on the first tool call. On by default whenever the deployment
   * is configured, because a linked device only receives messages while its
   * socket is open, and a bridge that waited for a poll to connect would miss
   * whatever arrived since the deploy. Off (and nothing is touched) when a
   * required variable is missing, which is every bundle container that does
   * not host this account.
   */
  autoStart?: boolean;
  /** Injected in tests: the event side's webhook transport, and manual timers. */
  events?: { webhookTransport?: WebhookTransport; manualTimers?: boolean };
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, plus `close()` (flush state, end the socket) and the
 * bridge itself for the host's health reporting.
 *
 * ONE BRIDGE PER FACTORY CALL, for the life of the process. The bundle host
 * builds a fresh MCP Server per request and calls `registerHandlers` on it;
 * every one of those shares the bridge built here, because a WhatsApp linked
 * device is one socket and two would kick each other off.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const env = options.env ?? process.env;
  const server = new Server(
    { name: "strad-whatsapp", version: options.version },
    { capabilities: { tools: {} } },
  );

  let bridge: WhatsAppBridge | undefined;
  const configured = options.config !== undefined || missingCredentials(env).length === 0;

  // The `message_received` event (./events/), when this slug asks for it.
  // It shares the bridge's bucket, folder, key and lease, so it exists only
  // where the bridge can: a slug that asks without the bridge's variables is
  // answered by the tools' own "not configured" error, not by this.
  let events: WhatsAppEvents | null = null;
  let blobs: BlobStore | undefined = options.blobs;
  const getConfig = (): WhatsAppConfig => options.config ?? loadConfig(env);
  const getBlobs = (config: WhatsAppConfig): BlobStore =>
    (blobs ??= new GcsBlobStore({
      bucket: config.bucket,
      clientEmail: config.clientEmail,
      privateKey: config.privateKey,
      who: "this bridge",
      privateKeyVariable: config.privateKeyVariable,
      warn: logWarning,
    }));
  if (configured && eventsRequested(env)) {
    try {
      const config = getConfig();
      events = new WhatsAppEvents({
        env,
        blobs: getBlobs(config),
        key: config.encryptionKey,
        prefix: config.prefix,
        ownership: {
          owns: () => bridge?.ownsAccount() ?? false,
          confirm: async () => (bridge ? bridge.confirmOwnership() : false),
        },
        webhookTransport: options.events?.webhookTransport,
        manualTimers: options.events?.manualTimers,
        clock: options.bridgeOptions?.clock,
      });
      if (events.configured) {
        logInfo("events: message_received is on for this slug");
        void events.start().catch(() => {});
      }
    } catch (err) {
      logWarning(`events: not starting: ${errMessage(err)}`);
      events = null;
    }
  }
  const served = events?.configured ? events : null;

  const getBridge = (): WhatsAppBridge => {
    if (!bridge) {
      // Throws a ConfigError naming the missing variables; not memoised, so a
      // variable that arrives later (a redeploy) is picked up.
      const config = getConfig();
      bridge = new WhatsAppBridge({
        config,
        blobs: getBlobs(config),
        socketFactory: options.socketFactory ?? createBaileysSocket,
        ...(served
          ? { onLiveMessage: (m) => served.add(m), onWipe: () => served.wipe() }
          : {}),
        ...options.bridgeOptions,
      });
    }
    return bridge;
  };
  const bridgeFactory: BridgeFactory = async () => getBridge();

  if (configured && !options.config) {
    const link = downloadLinkConfig(env);
    logInfo(
      link.downloadLink
        ? `attachments: download links will be minted for gateway slug "${link.downloadLink.publicSlug}"`
        : `attachments: ${link.downloadUnavailable}; whatsapp_get_attachment returns no link`,
    );
  }
  if ((options.autoStart ?? true) && configured) {
    try {
      void getBridge()
        .start()
        .catch((err: unknown) =>
          logWarning(`start failed; the next tool call retries: ${errMessage(err)}`),
        );
    } catch (err) {
      logWarning(`not starting: ${errMessage(err)}`);
    }
  }

  const registerHandlers = async (target: Server): Promise<void> => {
    registerTools(
      target,
      bridgeFactory,
      options.toolGroups ?? parseToolGroups(env.ENABLED_TOOLGROUPS),
    );
    if (events) registerWhatsAppEventHandlers(target, events);
  };

  const close = async (): Promise<void> => {
    // The bridge first: its last ingest can still hand the event a message.
    await bridge?.close();
    await events?.close();
  };

  /**
   * The bundle host's `/whatsapp/download/:token`: a signed link minted by
   * whatsapp_get_attachment, presented through core's `/mcp-download/:slug/`.
   * A container that does not hold this account answers 404 without building
   * a bridge.
   */
  const handleDownload = async (token: string): Promise<DownloadOutcome> => {
    if (!configured) return { ok: false, status: 404, error: "not_configured" };
    try {
      return await getBridge().handleDownload(token);
    } catch (err) {
      return { ok: false, status: 503, error: redact(errMessage(err)) };
    }
  };

  return { server, registerHandlers, close, handleDownload, bridge: () => bridge, events: () => events };
}
