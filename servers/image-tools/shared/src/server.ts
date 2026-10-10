import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Agent } from "undici";

import { fetchImage } from "./fetch-image.js";
import { createWorkerRunner, type RunJob } from "./jobs.js";
import { DEFAULT_LIMITS, type Limits } from "./limits.js";
import { getDiffOfImagesTool } from "./tools/get-diff-of-images.js";
import type { ToolContext, ToolDefinition } from "./tools/shared.js";
import { traceBitmapToSvgTool } from "./tools/trace-bitmap-to-svg.js";
import { createGuardedDispatcher, parseAllowedHosts } from "./url-guard.js";

export type ImageServerKind = "image-diff" | "svg-tracer";

export interface CreateMCPServerOptions {
  version: string;
  /**
   * The environment this instance reads. Only `IMAGE_TOOLS_ALLOW_PRIVATE_HOSTS`
   * is read from it — there is no credential. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /** Injected in tests. */
  limits?: Partial<Limits>;
  /** Injected in tests; production shares one worker runner per process. */
  runJob?: RunJob;
  /** Injected in tests; production builds the guarded agent. */
  dispatcher?: Agent;
}

const SERVER_NAMES: Record<ImageServerKind, string> = {
  "image-diff": "strad-image-diff",
  "svg-tracer": "strad-svg-tracer",
};

const TOOLS: Record<ImageServerKind, (ctx: ToolContext) => ToolDefinition[]> = {
  "image-diff": (ctx) => [getDiffOfImagesTool(ctx)],
  "svg-tracer": (ctx) => [traceBitmapToSvgTool(ctx)],
};

/**
 * ONE runner for the process, shared by both servers. The runner IS the
 * concurrency gate, so a second one would double what may run at once. Its
 * limits are therefore the FIRST factory call's: a later call's `limits` reach
 * that server's fetch and tools but not the shared gate. Tests that need a
 * different gate pass their own `runJob`.
 */
let sharedRunner: RunJob | undefined;
function defaultRunner(limits: Limits): RunJob {
  sharedRunner ??= createWorkerRunner({ limits });
  return sharedRunner;
}

/** The tool definitions one server serves, built over a context. */
export function toolDefinitions(
  kind: ImageServerKind,
  ctx: ToolContext,
): ToolDefinition[] {
  return TOOLS[kind](ctx);
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, so the bundle host mounts it like the others.
 *
 * Two servers, one tree: `image-diff` and `svg-tracer` are separate MCP
 * servers — separate mounts, separate slugs, separate grants — that share a
 * fetcher, a URL guard and a worker gate. Neither holds a credential, so
 * there is nothing to be lazy about and nothing to be degraded by.
 */
export function createMCPServer(
  kind: ImageServerKind,
  options: CreateMCPServerOptions,
) {
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const allowed = parseAllowedHosts(
    (options.env ?? process.env).IMAGE_TOOLS_ALLOW_PRIVATE_HOSTS,
  );
  const dispatcher = options.dispatcher ?? createGuardedDispatcher({ allowed });
  const ctx: ToolContext = {
    limits,
    fetchImage: (url, label, signal) =>
      fetchImage(url, { limits, dispatcher, allowed, label, signal }),
    runJob: options.runJob ?? defaultRunner(limits),
  };
  const tools = toolDefinitions(kind, ctx);

  const server = new Server(
    { name: SERVER_NAMES[kind], version: options.version },
    { capabilities: { tools: {} } },
  );

  const registerHandlers = async (target: Server): Promise<void> => {
    target.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      })),
    }));
    target.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = tools.find((t) => t.name === request.params.name);
      if (!tool) {
        throw new Error(
          `Unknown tool: ${request.params.name}. This server offers: ${tools.map((t) => t.name).join(", ")}.`,
        );
      }
      return tool.handler(request.params.arguments, extra.signal);
    });
  };

  return { server, registerHandlers };
}
