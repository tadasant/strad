import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createClient } from "./client.js";
import { configuredGroups, degradedReason, secretsIn } from "./config.js";
import { ConfigError, HatchboxApiError, InputError, SshReadError } from "./errors.js";
import { readEnviron as productionReader, type EnvironReader } from "./ssh.js";
import { TOOLS } from "./tools.js";

/**
 * The mount: six tools over ONE Hatchbox app.
 *
 * CREDENTIALS ARE READ PER CALL from the environment this server was GIVEN —
 * one slug's view in the strad bundle — never from a global, and each tool
 * reads only the group it needs. `tools/list` needs none of them.
 *
 * EVERY CREDENTIAL IS SCRUBBED from every result and error, before a long
 * result is cut, so a cut cannot split one past matching.
 */

export const MAX_RESULT_CHARS = 60_000;

type Env = Readonly<Record<string, string | undefined>>;

export interface CreateMCPServerOptions {
  version: string;
  /** ONE slug's view of the container environment. */
  env?: Env;
  /** Injected in tests. Production uses the global. */
  fetch?: typeof fetch;
  /** Injected in tests. Production is `https://hatchbox.io`. */
  origin?: string;
  timeoutMs?: number;
  /** Injected in tests. Production opens a pinned SSH connection. */
  readEnviron?: EnvironReader;
}

/** A `Server` from the tree's own SDK copy, as much of it as this file uses. */
interface ServerLike {
  setRequestHandler: (schema: unknown, handler: (request: never) => unknown) => void;
}

export function scrubber(secrets: readonly string[]): (text: string) => string {
  // Longest first, so a secret containing another is replaced whole. Each is
  // also matched in its JSON-escaped form: a PEM key inside a JSON string has
  // its newlines written as \n.
  const forms = [
    ...new Set(
      secrets
        .filter((s) => s.length >= 4)
        .flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]),
    ),
  ].sort((a, b) => b.length - a.length);
  return (text) => forms.reduce((t, s) => t.split(s).join("[redacted]"), text);
}

function render(value: unknown, scrub: (text: string) => string): string {
  const text = scrub(JSON.stringify(value, null, 2) ?? "null");
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n…[cut at ${MAX_RESULT_CHARS} of ${text.length} characters. Ask for less: ` +
    `getEnvVar for one value, or getEnvVars with names_only.]`
  );
}

export function createMCPServer(options: CreateMCPServerOptions) {
  const env = options.env ?? process.env;
  const client = createClient({
    ...(options.fetch ? { fetchImpl: options.fetch } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const reader = options.readEnviron ?? productionReader;

  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
    }
    const scrub = scrubber(secretsIn(env));
    try {
      const result = await tool.handler(args, { env, client, readEnviron: reader });
      return { content: [{ type: "text" as const, text: render(result, scrub) }] };
    } catch (error) {
      const known =
        error instanceof ConfigError ||
        error instanceof InputError ||
        error instanceof HatchboxApiError ||
        error instanceof SshReadError;
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: scrub(known ? message : `${name} failed: ${message}`) }],
        isError: true,
      };
    }
  };

  return {
    /** Why no tool can run, or null. The bundle host reports it on /healthz. */
    degraded: degradedReason(env),
    /** Which tool groups this slug's environment configures. */
    groups: configuredGroups(env),
    registerHandlers: async (server: unknown): Promise<void> => {
      const s = server as ServerLike;
      s.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS.map((t) => ({
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
