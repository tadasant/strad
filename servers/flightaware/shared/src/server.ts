import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createClient } from "./client.js";
import { DEFAULT_BASE_URL, ENV, loadConfig } from "./config.js";
import { scrubLiteral } from "./logging.js";
import { parseToolGroups, registerTools, type ToolGroup } from "./tools.js";
import type { ToolContext } from "./tools/shared.js";

export interface CreateMCPServerOptions {
  version: string;
  /**
   * The environment this instance reads. Defaults to `process.env`. The bundle
   * host passes a mount-scoped view, so nothing here may reach past it to a
   * global.
   */
  env?: NodeJS.ProcessEnv;
  toolGroups?: ToolGroup[];
  /** Injected in tests. Production uses the global. */
  fetch?: typeof fetch;
  /** Injected in tests. Production is AeroAPI v4. */
  baseUrl?: string;
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, so the bundle host mounts it like the others and builds
 * a fresh `Server` per request.
 *
 * NOTHING IS CACHED, AND NOTHING NEEDS TO BE. Every call is one HTTPS GET with
 * a static header, so the client is rebuilt per call from the env object this
 * server was GIVEN, and `tools/list` works with no key at all. That object is
 * only as live as its owner makes it: the strad bundle hands each mount a
 * snapshot taken at boot, so there a rotated key takes a redeploy, not just the
 * next call.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    { name: "strad-flightaware", version: options.version },
    { capabilities: { tools: {} } },
  );

  const env = () => options.env ?? process.env;

  const ctx: ToolContext = {
    client: () =>
      createClient({
        config: loadConfig(env(), options.baseUrl ?? DEFAULT_BASE_URL),
        ...(options.fetch ? { fetchImpl: options.fetch } : {}),
      }),
    scrub: (text) => scrubLiteral(text, env()[ENV.apiKey]?.trim()),
  };

  const registerHandlers = async (target: Server): Promise<void> => {
    registerTools(
      target,
      ctx,
      options.toolGroups ?? parseToolGroups(env().ENABLED_TOOLGROUPS),
    );
  };

  return { server, registerHandlers };
}
