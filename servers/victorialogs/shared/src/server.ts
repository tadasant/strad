import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { type Env, missingCredentials } from "./config.js";
import { VictoriaLogsUpstream, type UpstreamOptions } from "./upstream.js";

/**
 * The mount: one MCP surface that forwards to one supervised mcp-victorialogs
 * child.
 *
 * TOOLS ONLY. The binary also declares prompts and resources — its embedded
 * VictoriaLogs documentation — and those are not forwarded: its `documentation`
 * tool searches the same documents, and a proxied resource surface is one more
 * thing for strad's gateway to route that no client of this mount has asked
 * for. Two handlers, and adding a third is a deliberate change here.
 *
 * THE TOOL LIST IS THE CHILD'S, NOT A COPY OF IT, read from the running binary
 * on every `tools/list`, so a version bump cannot leave a stale definition here.
 *
 * AN UNCONFIGURED MOUNT LISTS BUT DOES NOT CALL. Its child runs against an
 * entrypoint that cannot resolve (config.ts), purely so the binary will start
 * and list; a call is refused here, naming the variable, before it reaches the
 * child.
 */

export interface CreateOptions {
  version: string;
  /** ONE slug's view of the container environment. */
  env: Env;
  /** The strad slug this mount serves. */
  slug?: string;
  binary?: UpstreamOptions["binary"];
  log?: UpstreamOptions["log"];
  onDegraded?: UpstreamOptions["onDegraded"];
}

export interface CreatedServer {
  registerHandlers: (server: unknown) => Promise<void>;
  /** Which required variables are absent; empty when the mount is configured. */
  missing: string[];
  close: () => Promise<void>;
}

/** A `Server` from the tree's own SDK copy, as much of it as this file uses. */
interface ServerLike {
  setRequestHandler: (
    schema: unknown,
    handler: (request: never) => unknown,
  ) => void;
}

export function createMCPServer(options: CreateOptions): CreatedServer {
  const slug = options.slug ?? "victorialogs";
  const missing = missingCredentials(options.env);
  const upstream = new VictoriaLogsUpstream({
    slug,
    version: options.version,
    env: options.env,
    binary: options.binary,
    log: options.log,
    onDegraded: options.onDegraded,
  });

  return {
    missing,
    close: () => upstream.close(),
    // The host builds a fresh Server per request and registers onto it; the
    // UPSTREAM is built once, above, so the child outlives the request that
    // started it.
    registerHandlers: async (server: unknown): Promise<void> => {
      const s = server as ServerLike;
      s.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: await upstream.listTools(),
      }));
      s.setRequestHandler(
        CallToolRequestSchema,
        async (request: { params: Parameters<typeof upstream.callTool>[0] }) => {
          if (missing.length > 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `${missing.join(", ")} is not set for this VictoriaLogs mount, ` +
                    `so nothing was sent. It is the URL of a VictoriaLogs instance, ` +
                    `or of a proxy in front of one (for example Grafana's ` +
                    `/api/datasources/proxy/uid/<uid>).`,
                },
              ],
              isError: true,
            };
          }
          return await upstream.callTool(request.params);
        },
      );
    },
  };
}
