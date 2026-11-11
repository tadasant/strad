import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ClientFactory } from './server.js';
import { getSpreadsheetTool } from './tools/get-spreadsheet.js';
import { getSheetValuesTool } from './tools/get-sheet-values.js';
import { batchGetSheetValuesTool } from './tools/batch-get-sheet-values.js';
import { findInSpreadsheetTool } from './tools/find-in-spreadsheet.js';
import { updateSheetValuesTool } from './tools/update-sheet-values.js';
import { appendSheetRowsTool } from './tools/append-sheet-rows.js';
import { clearSheetValuesTool } from './tools/clear-sheet-values.js';
import { addSheetTool } from './tools/add-sheet.js';
import { createSpreadsheetTool } from './tools/create-spreadsheet.js';
import { formatCellsTool } from './tools/format-cells.js';
import { shareSpreadsheetTool } from './tools/share-spreadsheet.js';

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

type ToolFactory = (server: Server, clientFactory: ClientFactory) => Tool;

/**
 * The tools that only read, the tools that also write, and the one that grants
 * other people access.
 *
 * THIS SERVER REGISTERS ALL OF THEM, ALWAYS. The split is exported because
 * READ_TOOLS is what a strad `-ro` slug's `tools: allow:` must contain, and
 * READ_TOOLS + WRITE_TOOLS is what a `-rw` slug's must — a list transcribed by
 * hand into a config in another repository is a list that goes stale. Only an
 * `-rw-external` slug, with no `tools:` block, reaches EXTERNAL_TOOLS.
 * `test/tool-tiers.test.ts` asserts the three arrays account for every
 * registered tool, so adding a tool without deciding its tier fails CI rather
 * than silently landing in whichever tier a config happens to allow.
 */
export const READ_TOOLS = [
  'get_spreadsheet',
  'get_sheet_values',
  'batch_get_sheet_values',
  'find_in_spreadsheet',
] as const;

export const WRITE_TOOLS = [
  'update_sheet_values',
  'append_sheet_rows',
  'clear_sheet_values',
  'add_sheet',
  'create_spreadsheet',
  'format_cells',
] as const;

/**
 * Sharing: the act an `-rw` slug must not have, because it hands a spreadsheet
 * to someone outside the account. The google-docs counterpart, `share_document`,
 * is withheld the same way.
 */
export const EXTERNAL_TOOLS = ['share_spreadsheet'] as const;

const ALL_TOOLS: ToolFactory[] = [
  // Read
  getSpreadsheetTool,
  getSheetValuesTool,
  batchGetSheetValuesTool,
  findInSpreadsheetTool,
  // Write
  updateSheetValuesTool,
  appendSheetRowsTool,
  clearSheetValuesTool,
  addSheetTool,
  createSpreadsheetTool,
  formatCellsTool,
  // External
  shareSpreadsheetTool,
];

export function createRegisterTools(clientFactory: ClientFactory) {
  return (server: Server) => {
    const tools = ALL_TOOLS.map((factory) => factory(server, clientFactory));

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }

      return await tool.handler(args);
    });
  };
}

/** Every tool this server registers, in registration order. Used by the tier test. */
export function toolNames(): string[] {
  const noClient: ClientFactory = () => {
    throw new Error('listing tool names does not build a client');
  };
  return ALL_TOOLS.map((factory) => factory(undefined as unknown as Server, noClient).name);
}
