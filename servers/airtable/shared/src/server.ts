import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createClient } from "./client.js";
import { ENV, loadConfig } from "./config.js";
import { parseToolGroups, registerTools, type ToolGroup } from "./tools.js";
import type { ClientFactory } from "./tools/shared.js";

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
  /** The API host. Injected in tests. */
  baseUrl?: string;
  /** The attachment-upload host. Injected in tests. */
  contentBaseUrl?: string;
}

/**
 * The factory, in the shape every server in strad's bundle uses: `{ server,
 * registerHandlers }`. The host builds a fresh `Server` per request and calls
 * `registerHandlers` on it, so nothing here may live on a `Server`.
 *
 * CREDENTIALS ARE LAZY. The token is read per call from the env this server
 * was given, and the client is rebuilt from it — there is no handshake to
 * amortise, every call is one HTTPS request with a static header — so a token
 * that is missing is a failed call naming the variable, not a failed boot. In
 * the strad bundle that env is a snapshot fixed at boot, so a rotated token
 * takes a redeploy. `tools/list` needs no token at all.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    { name: "strad-airtable", version: options.version },
    { capabilities: { tools: {} } },
  );

  const env = () => options.env ?? process.env;

  const client: ClientFactory = async () =>
    createClient({
      apiKey: loadConfig(env()).apiKey,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.contentBaseUrl
        ? { contentBaseUrl: options.contentBaseUrl }
        : {}),
    });

  const registerHandlers = async (target: Server): Promise<void> => {
    registerTools(
      target,
      client,
      options.toolGroups ?? parseToolGroups(env().ENABLED_TOOLGROUPS),
      () => env()[ENV.apiKey],
    );
  };

  return { server, registerHandlers };
}
