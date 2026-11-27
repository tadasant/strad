import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createClient, GlitchTipApiError, scrubber } from "./client.js";
import { ConfigError, loadConfig, missingCredentials, writeAllowed } from "./config.js";
import { InputError, TOOLS, WRITE_TOOLS } from "./tools.js";

/**
 * The mount: seven read-only tools over one GlitchTip, and two writes when the
 * environment it was given sets `GLITCHTIP_ALLOW_WRITE` to exactly `true`.
 *
 * THE SWITCH DECIDES THE SURFACE, not just the call. With it off, the write
 * tools are not listed and a call to one is an unknown tool, so a read-only
 * slug is the same seven tools it would be without this code.
 *
 * CREDENTIALS ARE READ PER CALL from the environment this server was GIVEN —
 * one slug's view in the strad bundle — never from a global. `tools/list` needs
 * none, so an unconfigured mount still shows what it would offer.
 *
 * A RESULT IS BOUNDED. An event carries a stack trace, breadcrumbs and request
 * data, and one huge payload in a tool result costs the caller its context. A
 * result over `MAX_RESULT_CHARS` is cut, and says where and how to get less.
 */

export const MAX_RESULT_CHARS = 60_000;

type Env = Readonly<Record<string, string | undefined>>;

export interface CreateMCPServerOptions {
  version: string;
  /** ONE slug's view of the container environment. */
  env?: Env;
  /** Injected in tests. Production uses the global. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** A `Server` from the tree's own SDK copy, as much of it as this file uses. */
interface ServerLike {
  setRequestHandler: (schema: unknown, handler: (request: never) => unknown) => void;
}

/** Serialise, scrub, THEN cut: a cut first could split the token past matching. */
function render(value: unknown, scrub: (text: string) => string): string {
  const text = scrub(JSON.stringify(value, null, 2) ?? "null");
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n…[cut at ${MAX_RESULT_CHARS} of ${text.length} characters. Ask for less: a ` +
    `smaller \`limit\`, or list_events for event summaries instead of get_issue's ` +
    `full latest event.]`
  );
}

export function createMCPServer(options: CreateMCPServerOptions) {
  const env = options.env ?? process.env;
  const tools = writeAllowed(env) ? [...TOOLS, ...WRITE_TOOLS] : TOOLS;

  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
    }
    let scrub = (text: string) => text;
    try {
      const config = loadConfig(env);
      scrub = scrubber(config.apiToken);
      const client = createClient({
        config,
        ...(options.fetch ? { fetchImpl: options.fetch } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      const result = await tool.handler(args, { client, config });
      return { content: [{ type: "text" as const, text: render(result, scrub) }] };
    } catch (error) {
      const known =
        error instanceof ConfigError || error instanceof InputError || error instanceof GlitchTipApiError;
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          { type: "text" as const, text: scrub(known ? message : `${name} failed: ${message}`) },
        ],
        isError: true,
      };
    }
  };

  return {
    /** Which required variables are absent; empty when the mount is configured. */
    missing: missingCredentials(env),
    registerHandlers: async (server: unknown): Promise<void> => {
      const s = server as ServerLike;
      s.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
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
