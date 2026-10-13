import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ClientFactory } from './server.js';
import { searchFilesTool } from './tools/search-files.js';
import { getFileTool } from './tools/get-file.js';
import { readFileTool } from './tools/read-file.js';
import { createFolderTool } from './tools/create-folder.js';
import { createFileTool } from './tools/create-file.js';
import { updateFileMetadataTool } from './tools/update-file-metadata.js';
import { moveFileTool } from './tools/move-file.js';
import { copyFileTool } from './tools/copy-file.js';
import { restoreFileTool, trashFileTool } from './tools/trash-file.js';

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
 * The tools that only read, the tools that create, and the tools that organise
 * files that already exist: rename, move, copy, trash, restore. None of them
 * writes a file's content.
 *
 * Exported because a strad `-ro` slug's `tools: allow:` is READ_TOOLS, and a
 * list transcribed by hand into a config in another repository goes stale.
 * `test/tool-tiers.test.ts` holds these lists to the registered tools.
 */
export const READ_TOOLS = ['search_files', 'get_file', 'read_file'] as const;
export const WRITE_TOOLS = ['create_folder', 'create_file'] as const;
export const ORGANIZE_TOOLS = [
  'update_file_metadata',
  'move_file',
  'copy_file',
  'trash_file',
  'restore_file',
] as const;

/**
 * Each tier holds the one before it, and each asks for one more scope:
 *
 * readonly:  the three reads                          drive.readonly
 * readwrite: the reads, and the two creates           + drive.file
 * full:      all of that, and the five organising tools  drive
 *
 * `readwrite` is deliberately create-only, so it can stay on `drive.file` and
 * never touch a file a human made. Renaming, moving or trashing those is
 * `full`, and needs `drive`. No tier overwrites a file's content: rewriting a
 * Google Doc through Drive's upload conversion loses its formatting, and
 * in-place document editing belongs to a Docs server.
 */
export type ToolGroup = 'readonly' | 'readwrite' | 'full';
export const TOOL_GROUPS: readonly ToolGroup[] = ['readonly', 'readwrite', 'full'];

const ALL_TOOLS: Array<{ factory: ToolFactory; groups: ToolGroup[] }> = [
  { factory: searchFilesTool, groups: ['readonly', 'readwrite', 'full'] },
  { factory: getFileTool, groups: ['readonly', 'readwrite', 'full'] },
  { factory: readFileTool, groups: ['readonly', 'readwrite', 'full'] },
  { factory: createFolderTool, groups: ['readwrite', 'full'] },
  { factory: createFileTool, groups: ['readwrite', 'full'] },
  { factory: updateFileMetadataTool, groups: ['full'] },
  { factory: moveFileTool, groups: ['full'] },
  { factory: copyFileTool, groups: ['full'] },
  { factory: trashFileTool, groups: ['full'] },
  { factory: restoreFileTool, groups: ['full'] },
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
      `unknown tool group(s) ${unknown.map((g) => `"${g}"`).join(', ')} in "${raw}"; expected ${TOOL_GROUPS.join(', ')}`
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
