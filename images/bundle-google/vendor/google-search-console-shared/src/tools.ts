import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ClientFactory } from './server.js';
import { listSitesTool, getSiteTool } from './tools/sites.js';
import { querySearchAnalyticsTool } from './tools/query-search-analytics.js';
import { listSitemapsTool, getSitemapTool } from './tools/sitemaps.js';
import { inspectUrlTool } from './tools/inspect-url.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  handler: (args: unknown) => Promise<ToolResult>;
}

type ToolFactory = (clientFactory: ClientFactory) => Tool;

const ALL_TOOLS: ToolFactory[] = [
  listSitesTool,
  getSiteTool,
  querySearchAnalyticsTool,
  listSitemapsTool,
  getSitemapTool,
  inspectUrlTool,
];

/**
 * Every tool this server registers. All six read, so there is one tier and no
 * tool-group toggle: a `webmasters.readonly` token is the whole boundary, and
 * Google refuses it every write the API has.
 *
 * Exported so a strad slug's `tools: allow:` can be held to the real names;
 * `test/tools.test.ts` holds this list to the registered tools.
 */
export const READ_TOOLS = [
  'list_sites',
  'get_site',
  'query_search_analytics',
  'list_sitemaps',
  'get_sitemap',
  'inspect_url',
] as const;

export function createRegisterTools(clientFactory: ClientFactory) {
  return (server: Server) => {
    const tools = ALL_TOOLS.map((factory) => factory(clientFactory));

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return await tool.handler(args);
    });
  };
}

/** Every tool this server registers, in registration order. */
export function toolNames(): string[] {
  const noClient: ClientFactory = () => {
    throw new Error('listing tool names does not build a client');
  };
  return ALL_TOOLS.map((factory) => factory(noClient).name);
}

/** The error result every tool returns, with the cause's message intact. */
export function errorResult(prefix: string, error: unknown): ToolResult {
  const message =
    error instanceof Error
      ? // A Zod failure's message is a JSON dump of issues; name the fields instead.
        error.name === 'ZodError'
        ? (error as unknown as { issues: Array<{ path: unknown[]; message: string }> }).issues
            .map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
            .join('; ')
        : error.message
      : String(error);
  return { content: [{ type: 'text', text: `${prefix}: ${message}` }], isError: true };
}

/** The annotations every tool here carries: a read of a remote, changing system. */
export const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
