import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { type Env, missingCredentials } from "./config.js";
import { GrafanaUpstream, type UpstreamOptions } from "./upstream.js";

/**
 * The mount: one MCP surface that forwards to one supervised mcp-grafana child.
 *
 * TWO HANDLERS, AND NO THIRD. mcp-grafana declares `tools` and nothing else — no
 * resources, no prompts — so a proxy that forwards `tools/list` and `tools/call`
 * forwards the whole server. Anything it grows later would need adding here
 * deliberately, which is the right default for a surface strad does not author.
 *
 * THE TOOL LIST IS THE CHILD'S, NOT A COPY OF IT. Nothing in this repo restates
 * Grafana's tool definitions: they are read from the running binary on every
 * `tools/list`. A pinned copy would be a second source of truth that goes stale
 * silently at the next version bump, and the version bump is the one moment
 * anybody would have believed the copy.
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
  const slug = options.slug ?? "grafana";
  const upstream = new GrafanaUpstream({
    slug,
    version: options.version,
    env: options.env,
    binary: options.binary,
    log: options.log,
    onDegraded: options.onDegraded,
  });

  return {
    missing: missingCredentials(options.env),
    close: () => upstream.close(),
    // The host builds a fresh Server per request and registers onto it; the
    // UPSTREAM is built once, above, so the child process outlives the request
    // that started it.
    registerHandlers: async (server: unknown): Promise<void> => {
      const s = server as ServerLike;
      s.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: await upstream.listTools(),
      }));
      s.setRequestHandler(
        CallToolRequestSchema,
        async (request: { params: Parameters<typeof upstream.callTool>[0] }) =>
          await upstream.callTool(request.params),
      );
    },
  };
}
