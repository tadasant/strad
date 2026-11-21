import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ConfigError, missingCredentials, type Env } from "./config.js";
import { UpstreamError } from "./http.js";
import { createScrubber } from "./scrub.js";
import { InputError, TOOLS } from "./tools.js";

/**
 * The mount: four fixed, read-only billing reads.
 *
 * CREDENTIALS ARE READ PER CALL from the environment this server was GIVEN
 * (in the bundle, the host's per-mount view, copied at mount time), never from
 * a global, and each tool reads only its own. `tools/list` needs
 * none, so an unconfigured mount still shows what it would offer, and a tool
 * whose variables are absent answers `not configured` while the others work.
 *
 * EVERYTHING LEAVING IS SCRUBBED: every result and every error, including the
 * access token a Google call mints, before it is returned. Nothing here logs.
 */

export const MAX_RESULT_CHARS = 60_000;

export interface CreateMCPServerOptions {
  version: string;
  /** ONE slug's view of the container environment. */
  env?: Env;
  /** Injected in tests. Production uses the global. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Injected in tests. */
  now?: () => Date;
}

interface ServerLike {
  setRequestHandler: (schema: unknown, handler: (request: never) => unknown) => void;
}

/** Serialise, scrub, THEN cut: a cut first could split a secret past matching. */
function render(value: unknown, scrub: (text: string) => string): string {
  const text = scrub(JSON.stringify(value, null, 2) ?? "null");
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n…[cut at ${MAX_RESULT_CHARS} of ${text.length} characters. Ask for a shorter date range.]`
  );
}

export function createMCPServer(options: CreateMCPServerOptions) {
  const env = options.env ?? process.env;
  const http = {
    ...(options.fetch ? { fetchImpl: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
  const now = options.now ?? (() => new Date());

  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
    }
    const scrub = createScrubber(env);
    try {
      const result = await tool.handler(args, { env, http, scrub, now });
      return { content: [{ type: "text" as const, text: render(result, scrub) }] };
    } catch (error) {
      const known =
        error instanceof ConfigError || error instanceof InputError || error instanceof UpstreamError;
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: scrub(known ? message : `${name} failed: ${message}`) }],
        isError: true,
      };
    }
  };

  return {
    /** The variables absent when NO tool is configured; empty once any one is. */
    missing: missingCredentials(env),
    registerHandlers: async (server: unknown): Promise<void> => {
      const s = server as ServerLike;
      s.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        })),
      }));
      s.setRequestHandler(
        CallToolRequestSchema,
        async (request: { params: { name: string; arguments?: Record<string, unknown> } }) =>
          await call(request.params.name, request.params.arguments ?? {}),
      );
    },
  };
}
