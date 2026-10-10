import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createClient } from "./client.js";
import { DEFAULT_BASE_URL, loadConfig } from "./config.js";
import { parseToolGroups, registerTools, type ToolGroup } from "./tools.js";
import type { ClientFactory } from "./tools/shared.js";

export interface CreateMCPServerOptions {
  version: string;
  /**
   * The environment this instance reads. Defaults to `process.env`. The bundle
   * host passes a mount-scoped view, so a slug-prefixed
   * `…__DIGITALOCEAN_API_TOKEN` is read ahead of the bare name; nothing here
   * reaches past the view to a global.
   */
  env?: NodeJS.ProcessEnv;
  toolGroups?: ToolGroup[];
  /** Injected in tests. Production uses the global. */
  fetch?: typeof fetch;
  /** Injected in tests. Production is `https://api.digitalocean.com/v2`. */
  baseUrl?: string;
  /** Injected in tests, so the timeout path costs no wall clock. */
  timeoutMs?: number;
  /** Injected in tests, so the log fetch cap is reachable with a small fixture. */
  logCapBytes?: number;
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, so the bundle host mounts it like the others.
 *
 * CREDENTIALS ARE LAZY. The image ships none and this server shares a process
 * with the rest of the bundle, so a missing token is one failed tool call, not
 * a boot failure; `tools/list` works with no credential at all. Nothing is
 * memoised either: there is no connection to amortise, so the token is read
 * per call from the environment this server was GIVEN. In the strad bundle that
 * is a view fixed at boot, so a rotated token reaches it through a redeploy,
 * not on the next call. The bundle builds a fresh `Server` per request and
 * calls `registerHandlers` on it, so nothing may live on the `Server` anyway.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    { name: "strad-digitalocean", version: options.version },
    { capabilities: { tools: {} } },
  );

  const factory: ClientFactory = () => {
    const config = loadConfig(
      options.env ?? process.env,
      options.baseUrl ?? DEFAULT_BASE_URL,
    );
    return {
      client: createClient({
        config,
        ...(options.fetch ? { fetchImpl: options.fetch } : {}),
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
        ...(options.logCapBytes !== undefined
          ? { logCapBytes: options.logCapBytes }
          : {}),
      }),
      token: config.apiToken,
    };
  };

  const registerHandlers = async (target: Server): Promise<void> => {
    registerTools(
      target,
      factory,
      options.toolGroups ??
        parseToolGroups((options.env ?? process.env).ENABLED_TOOLGROUPS),
    );
  };

  return { server, registerHandlers };
}
