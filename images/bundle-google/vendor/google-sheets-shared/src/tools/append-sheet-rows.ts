import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { parseSpreadsheetId } from '../utils/parse-spreadsheet-id.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  spreadsheet_id: 'The spreadsheet ID, or the full Sheets URL.',
  range:
    'A range that identifies the TABLE to append to — usually just the tab, "\'Ledger\'", ' +
    'or its first row, "\'Ledger\'!A1:D1". Sheets finds the end of the table containing ' +
    'that range and adds rows after it; it does not overwrite the range you name.',
  values: 'Rows to add, outermost array = rows.',
  value_input_option:
    'How Sheets parses what you send. USER_ENTERED (default) behaves as if a person typed ' +
    'it; RAW stores literal strings.',
} as const;

export const AppendSheetRowsSchema = z.object({
  spreadsheet_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.spreadsheet_id),
  range: z.string().min(1).describe(PARAM_DESCRIPTIONS.range),
  values: z.array(z.array(z.unknown())).min(1).describe(PARAM_DESCRIPTIONS.values),
  value_input_option: z
    .enum(['USER_ENTERED', 'RAW'])
    .optional()
    .describe(PARAM_DESCRIPTIONS.value_input_option),
});

const TOOL_DESCRIPTION = `Add rows to the bottom of a table, without overwriting anything.

New rows are INSERTED after the last row of the table Sheets finds at the range
you name, so data sitting further down the tab is pushed down rather than
clobbered. This is the safe way to log a transaction, a monthly snapshot, or any
other append-only record.

**Parameters:**
- spreadsheet_id: ID or full Sheets URL (required)
- range: the tab or header row identifying the table, e.g. "'Ledger'!A1:D1" (required)
- values: rows to add, e.g. [["2026-08-01", "Rent", -2400]] (required)
- value_input_option: USER_ENTERED (default) | RAW

**Returns:** the range the new rows landed in.`;

export function appendSheetRowsTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'append_sheet_rows',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: PARAM_DESCRIPTIONS.spreadsheet_id },
        range: { type: 'string', description: PARAM_DESCRIPTIONS.range },
        values: {
          type: 'array',
          items: { type: 'array', items: {} },
          description: PARAM_DESCRIPTIONS.values,
        },
        value_input_option: {
          type: 'string',
          enum: ['USER_ENTERED', 'RAW'],
          description: PARAM_DESCRIPTIONS.value_input_option,
        },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = AppendSheetRowsSchema.parse(args ?? {});
        const spreadsheetId = parseSpreadsheetId(parsed.spreadsheet_id);
        const client = clientFactory();

        const result = await client.appendValues(
          spreadsheetId,
          parsed.range,
          parsed.values as unknown[][],
          parsed.value_input_option ?? 'USER_ENTERED'
        );

        const updates = result.updates ?? {};
        const output =
          `Appended ${parsed.values.length} row(s) to ${result.tableRange ?? parsed.range}` +
          `${updates.updatedRange ? `, landing in ${updates.updatedRange}` : ''}.`;

        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('append-sheet-rows-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error appending rows: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
