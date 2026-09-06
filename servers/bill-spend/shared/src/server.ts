import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createHttp } from "./client.js";
import { loadConfig, type BillConfig } from "./config.js";
import { createGateway, type BillGateway } from "./gateway.js";
import { parseToolGroups, registerTools, type ToolGroup } from "./tools.js";
import type { GatewayFactory } from "./tools/shared.js";

export interface CreateMCPServerOptions {
  version: string;
  /** Injected in tests; production reads the environment. */
  config?: BillConfig;
  /** Injected in tests; production builds one over HTTPS. */
  gatewayFactory?: GatewayFactory;
  toolGroups?: ToolGroup[];
  /**
   * The environment this instance reads. Defaults to `process.env`.
   *
   * The bundle host passes a MOUNT-SCOPED VIEW — `slugEnvView(process.env,
   * "bill-spend")`, so `BILL_SPEND__BILL_SPEND_API_TOKEN` is read ahead of the
   * bare `BILL_SPEND_API_TOKEN`. There is one mount and no per-slug instance,
   * because one BILL token is one company: `bill-spend-ro` and `bill-spend-rw`
   * are two strad slugs over the same credential, told apart by the gateway's
   * `tools:` policy rather than by their environment. Nothing in this server may
   * reach past the view to a global anyway — that is what would make a second
   * instance possible if a second company ever needed one.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, so the bundle host mounts it exactly like the others.
 *
 * CREDENTIALS ARE LAZY. The image ships none, strad injects them onto the
 * component at deploy time, and this server shares a process with twenty-one
 * others — so a missing token must be one server's failed tool call, not a boot
 * failure for the whole bundle. `tools/list` works with no credential at all,
 * which is what lets the console and an agent see what this deployment WOULD
 * offer.
 *
 * THE GATEWAY IS MEMOISED AND HOLDS NO CONNECTION. Unlike the MTProto servers in
 * this repo there is no handshake to amortise — every call is one HTTPS request
 * with a static header — so the memo exists only to keep the learned write
 * variant and the value-catalog cache across the fresh `Server` the bundle host
 * builds per request. Losing them would be correct but wasteful: the ladder in
 * wire.ts would be re-walked on every single write.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    { name: "strad-bill-spend", version: options.version },
    { capabilities: { tools: {} } },
  );

  let built: BillGateway | undefined;

  const gatewayFactory: GatewayFactory =
    options.gatewayFactory ??
    (async () => {
      // A config error is thrown per call rather than cached, so a variable that
      // arrives later recovers without a redeploy.
      if (!built) {
        const config = options.config ?? loadConfig(options.env);
        built = createGateway({ http: createHttp({ config }) });
      }
      return built;
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
