import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { loadConfig, type TelegramConfig } from "./config.js";
import type { TelegramGateway } from "./gateway.js";
import { logWarning } from "./logging.js";
import { createGateway, createMtprotoClient } from "./mtproto.js";
import { parseToolGroups, registerTools, type ToolGroup } from "./tools.js";
import type { GatewayFactory } from "./tools/shared.js";

export interface CreateMCPServerOptions {
  version: string;
  /** Injected in tests; production reads the environment. */
  config?: TelegramConfig;
  /** Injected in tests; production builds one over MTProto. */
  gatewayFactory?: GatewayFactory;
  toolGroups?: ToolGroup[];
  /**
   * The environment this instance reads. Defaults to `process.env`.
   *
   * The bundle host passes a SLUG-SCOPED VIEW (`TELEGRAM_RO__TELEGRAM_API_HASH`
   * ahead of `TELEGRAM_API_HASH`), which is what lets one container run
   * `telegram-ro` and `telegram-rw` on two different accounts. Nothing in this
   * server may reach past it to a global, or the two instances quietly become
   * one.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, so the bundle host mounts it exactly like the others.
 *
 * CREDENTIALS AND THE CONNECTION ARE BOTH LAZY. The image ships neither, strad
 * injects them onto the component at deploy time, and this server shares a
 * process with sixteen others — so a missing session string must be one server's
 * failed tool call, not a boot failure for the whole bundle. `tools/list` works
 * with no credentials at all, which is what lets the console and an agent see
 * what this deployment WOULD offer.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    { name: "strad-telegram", version: options.version },
    { capabilities: { tools: {} } },
  );

  // Process-lifetime memo. The bundle host serves this mount statelessly — a
  // fresh Server and a fresh registerHandlers per HTTP request — so a gateway
  // built inside that function would open a new MTProto connection, and re-do
  // the DC handshake, on every single tool call. Telegram rate-limits that.
  let connecting: Promise<TelegramGateway> | undefined;

  const gatewayFactory: GatewayFactory =
    options.gatewayFactory ??
    (() => {
      // The promise is memoised, not the result: two concurrent first calls must
      // not each open a connection. A connect that FAILS drops the memo, so the
      // next call retries — a missing variable that gets set, or a network blip,
      // recovers without a redeploy. A session that Telegram rejects LATER does
      // not: the connection is live, and `guard` says as much in the error.
      connecting ??= (async () => {
        const config = options.config ?? loadConfig(options.env);
        return createGateway(await createMtprotoClient(config));
      })().catch((err: unknown) => {
        connecting = undefined;
        logWarning(
          `connect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      });
      return connecting;
    });

  const registerHandlers = async (
    target: Server,
    factory?: GatewayFactory,
  ): Promise<void> => {
    registerTools(
      target,
      factory ?? gatewayFactory,
      options.toolGroups ??
        parseToolGroups((options.env ?? process.env).ENABLED_TOOLGROUPS),
    );
  };

  return { server, registerHandlers };
}
