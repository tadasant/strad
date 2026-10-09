import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { createApi, createSend, type DeviceFarmApi } from "./client.js";
import { loadConfig, type DeviceFarmConfig } from "./config.js";
import { createDriverPool } from "./drivers.js";
import { createGateway } from "./gateway.js";
import { globalFetch, type FetchLike } from "./http.js";
import { parseToolGroups, registerTools, type ToolGroup } from "./tools.js";
import type { Deps, DepsFactory } from "./tools/shared.js";

export interface CreateMCPServerOptions {
  version: string;
  /** Injected in tests; production reads the environment. */
  config?: DeviceFarmConfig;
  /** Injected in tests; production builds one over the AWS SDK. */
  api?: DeviceFarmApi;
  /** Injected in tests; production uses the global `fetch`. */
  fetchImpl?: FetchLike;
  toolGroups?: ToolGroup[];
  /**
   * The environment this instance reads. Defaults to `process.env`.
   *
   * The bundle host passes a MOUNT-SCOPED VIEW — `slugEnvView(process.env,
   * "aws-device-farm")`, so `AWS_DEVICE_FARM__AWS_DEVICE_FARM_PROJECT_ARN` is
   * read ahead of the bare name. There is one mount and no per-slug instance:
   * one project ARN is one Device Farm project, and the read-only and
   * interactive slugs are two strad slugs over the same credential, told apart
   * by the gateway's `tools:` policy rather than by their environment.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, so the bundle host mounts it exactly like the others.
 *
 * CREDENTIALS ARE LAZY. The image ships none, strad injects them onto the
 * component at deploy time, and this server shares a process with twenty-four
 * others — so a missing variable must be one server's failed tool call, not a
 * boot failure for the whole bundle. `tools/list` works with no credential at
 * all, which is what lets the console and an agent see what this deployment
 * WOULD offer.
 *
 * THE DEPS ARE MEMOISED, AND ONE OF THEM HAS STATE THAT MATTERS. The gateway is
 * stateless and memoising it is only thrift; the DRIVER POOL is not. It holds
 * one WebDriver session per live phone, and establishing one relaunches the app
 * — so a pool rebuilt per request would turn a sequence of taps into a sequence
 * of cold starts. strad builds a fresh MCP `Server` per request; this closure
 * is what outlives it.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    { name: "strad-aws-device-farm", version: options.version },
    { capabilities: { tools: {} } },
  );

  let built: Deps | undefined;

  const deps: DepsFactory = async () => {
    // A config error is thrown per call rather than cached, so a variable that
    // arrives later recovers without a redeploy.
    if (!built) {
      const config = options.config ?? loadConfig(options.env);
      const api = options.api ?? createApi(createSend({ config }));
      const fetchImpl = options.fetchImpl ?? globalFetch();
      const gateway = createGateway({ api, projectArn: config.projectArn });
      built = {
        gateway,
        pool: createDriverPool({ gateway, fetchImpl }),
        maxUploadBytes: config.maxUploadBytes,
        fetchImpl,
      };
    }
    return built;
  };

  const registerHandlers = async (
    target: Server,
    factory?: DepsFactory,
  ): Promise<void> => {
    registerTools(
      target,
      factory ?? deps,
      options.toolGroups ??
        parseToolGroups((options.env ?? process.env).ENABLED_TOOLGROUPS),
    );
  };

  return { server, registerHandlers };
}
