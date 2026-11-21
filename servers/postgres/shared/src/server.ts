import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ConfigError, loadConfig, missingCredentials, scrubber, secretsOf } from "./config.js";
import { createRunner, QueryError, type Runner, type RunnerOptions } from "./query.js";
import { SqlRejected } from "./sql.js";
import { InputError, TOOLS } from "./tools.js";

/**
 * The mount: four read-only tools over one Postgres database.
 *
 * CREDENTIALS ARE READ PER CALL from the environment this server was GIVEN —
 * one slug's view in the strad bundle — never from a global. `tools/list` needs
 * none, so an unconfigured mount still shows what it would offer. The pool is
 * kept between calls and rebuilt only when the URI it was built from changes.
 *
 * A RESULT IS BOUNDED, and SCRUBBED FIRST. The URI and its password are
 * removed from every result and every error before anything is cut, so a cut
 * cannot split a secret past matching. A query result over `MAX_RESULT_CHARS`
 * loses rows from the end until it fits, and says how many it kept.
 */

export const MAX_RESULT_CHARS = 60_000;

type Env = Readonly<Record<string, string | undefined>>;

export interface CreateMCPServerOptions {
  version: string;
  /** ONE slug's view of the container environment. */
  env?: Env;
  /** Injected in tests. */
  runner?: RunnerOptions;
}

/** A `Server` from the tree's own SDK copy, as much of it as this file uses. */
interface ServerLike {
  setRequestHandler: (schema: unknown, handler: (request: never) => unknown) => void;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 1) ?? "null";
}

/** Serialise and scrub; then, if it is too long, drop rows until it fits, or cut. */
export function render(value: unknown, scrub: (text: string) => string): string {
  const text = scrub(json(value));
  if (text.length <= MAX_RESULT_CHARS) return text;
  const v = value as { rows?: unknown[] };
  if (v && Array.isArray(v.rows) && v.rows.length > 0) {
    const all = v.rows;
    let lo = 0;
    let hi = all.length - 1;
    let best = "";
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = scrub(
        json({
          ...v,
          rows: all.slice(0, mid),
          row_count: mid,
          more_rows: true,
          note:
            `Cut to ${mid} of the ${all.length} rows fetched: the result passed ${MAX_RESULT_CHARS} ` +
            `characters. Select fewer or narrower columns, or lower max_rows.`,
        }),
      );
      if (candidate.length <= MAX_RESULT_CHARS) {
        best = candidate;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best) return best;
  }
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n…[cut at ${MAX_RESULT_CHARS} of ${text.length} characters. Ask for less.]`
  );
}

export function createMCPServer(options: CreateMCPServerOptions) {
  const env = options.env ?? process.env;
  let pooled: { uri: string; ca: string | undefined; runner: Runner } | undefined;

  const runnerFor = (config: ReturnType<typeof loadConfig>): Runner => {
    if (pooled && pooled.uri === config.uri && pooled.ca === config.ca) return pooled.runner;
    void pooled?.runner.close();
    pooled = { uri: config.uri, ca: config.ca, runner: createRunner(config, options.runner) };
    return pooled.runner;
  };

  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
    }
    let scrub = scrubber([]);
    try {
      const config = loadConfig(env);
      scrub = scrubber(secretsOf(config));
      const result = await tool.handler(args, { runner: runnerFor(config), config });
      return { content: [{ type: "text" as const, text: render(result, scrub) }] };
    } catch (error) {
      const known =
        error instanceof ConfigError ||
        error instanceof InputError ||
        error instanceof SqlRejected ||
        error instanceof QueryError;
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: scrub(known ? message : `${name} failed: ${message}`) }],
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
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: {
            title: t.title,
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        })),
      }));
      s.setRequestHandler(
        CallToolRequestSchema,
        async (request: { params: { name: string; arguments?: Record<string, unknown> } }) =>
          await call(request.params.name, request.params.arguments ?? {}),
      );
    },
    /** Ends the pool. The bundle host calls it on shutdown and when an instance is replaced. */
    close: async (): Promise<void> => {
      const current = pooled;
      pooled = undefined;
      await current?.runner.close();
    },
  };
}
