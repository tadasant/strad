import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ClientFactory } from './server.js';
import { searchFilesTool } from './tools/search-files.js';
import { getFileTool } from './tools/get-file.js';
import { readFileTool } from './tools/read-file.js';
import { createFolderTool } from './tools/create-folder.js';
import { createFileTool } from './tools/create-file.js';

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
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

/**
 * The tools that only read, and the tools that also create.
 *
 * Exported because a strad `-ro` slug's `tools: allow:` is READ_TOOLS, and a
 * list transcribed by hand into a config in another repository goes stale.
 * `test/tool-tiers.test.ts` holds these two lists to the registered tools.
 */
export const READ_TOOLS = ['search_files', 'get_file', 'read_file'] as const;
export const WRITE_TOOLS = ['create_folder', 'create_file'] as const;

/**
 * readonly:  the three read tools
 * readwrite: the three read tools and the two creates
 */
export type ToolGroup = 'readonly' | 'readwrite';
export const TOOL_GROUPS: readonly ToolGroup[] = ['readonly', 'readwrite'];

const ALL_TOOLS: Array<{ factory: ToolFactory; groups: ToolGroup[] }> = [
  { factory: searchFilesTool, groups: ['readonly', 'readwrite'] },
  { factory: getFileTool, groups: ['readonly', 'readwrite'] },
  { factory: readFileTool, groups: ['readonly', 'readwrite'] },
  { factory: createFolderTool, groups: ['readwrite'] },
  { factory: createFileTool, groups: ['readwrite'] },
];

/**
 * A comma list of groups. Unset or blank means every group. An unknown name
 * THROWS: reading it as "every group", the way a lenient parser would, turns a
 * typo meant to narrow the server into the widest setting it has.
 */
export function parseToolGroups(raw: string | undefined): ToolGroup[] {
  const names = (raw ?? '')
    .split(',')
    .map((g) => g.trim().toLowerCase())
    .filter((g) => g !== '');
  if (names.length === 0) return [...TOOL_GROUPS];
  const unknown = names.filter((g) => !TOOL_GROUPS.includes(g as ToolGroup));
  if (unknown.length > 0) {
    throw new Error(
      `unknown tool group(s) ${unknown.map((g) => `"${g}"`).join(', ')} in "${raw}"; expected ${TOOL_GROUPS.join(' or ')}`
    );
  }
  return names as ToolGroup[];
}

export function createRegisterTools(clientFactory: ClientFactory, groups: ToolGroup[] = [...TOOL_GROUPS]) {
  return (server: Server) => {
    const tools = ALL_TOOLS.filter((t) => t.groups.some((g) => groups.includes(g))).map((t) =>
      t.factory(clientFactory)
    );

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
  return ALL_TOOLS.map((t) => t.factory(noClient).name);
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
