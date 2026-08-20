import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { parseSpreadsheetId } from '../utils/parse-spreadsheet-id.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  spreadsheet_id: 'The spreadsheet ID, or the full Sheets URL.',
  range:
    'The A1 range to empty, naming its tab: "\'Scratch\'!A2:D100". Naming a whole tab ' +
    'empties every cell in it.',
} as const;

export const ClearSheetValuesSchema = z.object({
  spreadsheet_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.spreadsheet_id),
  range: z.string().min(1).describe(PARAM_DESCRIPTIONS.range),
});

const TOOL_DESCRIPTION = `Empty the cells of an A1 range, keeping their formatting.

Values and formulas go; number formats, colours, borders and data validation stay.
Rows are not deleted and nothing shifts up — the cells are simply blank
afterwards.

**Parameters:**
- spreadsheet_id: ID or full Sheets URL (required)
- range: the A1 range to empty, naming its tab (required)

**Returns:** the range that was cleared.

**Careful:** naming a bare tab clears the whole tab. Read the range first if you
are not sure what it holds — there is no undo through this API.`;

export function clearSheetValuesTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'clear_sheet_values',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: PARAM_DESCRIPTIONS.spreadsheet_id },
        range: { type: 'string', description: PARAM_DESCRIPTIONS.range },
      },
      required: ['spreadsheet_id', 'range'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = ClearSheetValuesSchema.parse(args ?? {});
        const spreadsheetId = parseSpreadsheetId(parsed.spreadsheet_id);
        const client = clientFactory();

        const result = await client.clearValues(spreadsheetId, parsed.range);

        return {
          content: [
            { type: 'text', text: `Cleared ${result.clearedRange ?? parsed.range}.` },
          ],
        };
      } catch (error) {
        logError('clear-sheet-values-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error clearing values: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
