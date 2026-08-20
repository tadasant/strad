import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { parseSpreadsheetId } from '../utils/parse-spreadsheet-id.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  spreadsheet_id: 'The spreadsheet ID, or the full Sheets URL.',
  title: 'Title for the new tab. Must not match an existing tab.',
  index: 'Where to put it, 0-based. Omit to add it last.',
  row_count: 'Rows to create. Sheets defaults to 1000.',
  column_count: 'Columns to create. Sheets defaults to 26.',
} as const;

export const AddSheetSchema = z.object({
  spreadsheet_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.spreadsheet_id),
  title: z.string().min(1).describe(PARAM_DESCRIPTIONS.title),
  index: z.number().int().nonnegative().optional().describe(PARAM_DESCRIPTIONS.index),
  row_count: z.number().int().positive().optional().describe(PARAM_DESCRIPTIONS.row_count),
  column_count: z.number().int().positive().optional().describe(PARAM_DESCRIPTIONS.column_count),
});

const TOOL_DESCRIPTION = `Add a new empty tab to an existing spreadsheet.

**Parameters:**
- spreadsheet_id: ID or full Sheets URL (required)
- title: the new tab's title (required)
- index: 0-based position (default: last)
- row_count / column_count: initial size

**Returns:** the new tab's title and gid.

This is the only structural write here: there is no tool that deletes a tab, and
none that creates or deletes a spreadsheet FILE. Adding is recoverable; those are
not, and a file-level operation would need Drive scopes this server does not ask
for.`;

export function addSheetTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'add_sheet',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: PARAM_DESCRIPTIONS.spreadsheet_id },
        title: { type: 'string', description: PARAM_DESCRIPTIONS.title },
        index: { type: 'number', description: PARAM_DESCRIPTIONS.index },
        row_count: { type: 'number', description: PARAM_DESCRIPTIONS.row_count },
        column_count: { type: 'number', description: PARAM_DESCRIPTIONS.column_count },
      },
      required: ['spreadsheet_id', 'title'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = AddSheetSchema.parse(args ?? {});
        const spreadsheetId = parseSpreadsheetId(parsed.spreadsheet_id);
        const client = clientFactory();

        const properties = await client.addSheet(spreadsheetId, {
          title: parsed.title,
          index: parsed.index,
          rowCount: parsed.row_count,
          columnCount: parsed.column_count,
        });

        const output =
          `Added tab "${properties.title ?? parsed.title}"` +
          `${properties.sheetId !== undefined ? ` (gid ${properties.sheetId})` : ''}.`;

        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('add-sheet-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error adding tab: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
