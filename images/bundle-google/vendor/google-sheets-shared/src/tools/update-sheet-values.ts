import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { parseSpreadsheetId } from '../utils/parse-spreadsheet-id.js';
import { intendedSheetGid, resolveRange } from '../utils/resolve-range.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  spreadsheet_id: 'The spreadsheet ID, or the full Sheets URL.',
  range:
    'The A1 range to overwrite, naming its tab: "\'Q1 2026\'!B4:D6". It should be the ' +
    'same shape as `values` — a range larger than the data leaves the extra cells alone, ' +
    'and a range smaller than the data is an error.',
  values:
    'Rows of cell values, outermost array = rows. Numbers stay numbers; strings starting ' +
    'with "=" become formulas under the default value_input_option.',
  value_input_option:
    'How Sheets parses what you send. USER_ENTERED (default) behaves as if a person typed ' +
    'it: "5/2/2026" becomes a date, "=SUM(B2:B9)" becomes a formula, "$1,200" becomes a ' +
    'formatted number. RAW stores the literal string, formulas included.',
  sheet_gid:
    'The tab to write to, by gid (the number in a Sheets URL after #gid=). An alternative ' +
    'to naming the tab in `range`; combine it with a bare cell range like "B4:D6".',
} as const;

export const UpdateSheetValuesSchema = z.object({
  spreadsheet_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.spreadsheet_id),
  range: z.string().min(1).describe(PARAM_DESCRIPTIONS.range),
  sheet_gid: z.number().int().optional().describe(PARAM_DESCRIPTIONS.sheet_gid),
  values: z.array(z.array(z.unknown())).min(1).describe(PARAM_DESCRIPTIONS.values),
  value_input_option: z
    .enum(['USER_ENTERED', 'RAW'])
    .optional()
    .describe(PARAM_DESCRIPTIONS.value_input_option),
});

const TOOL_DESCRIPTION = `Overwrite the cells of an A1 range with the values you supply.

**This replaces what is there.** It does not insert rows and it does not shift
anything: whatever occupies the range is gone. Read the range first if you are
not certain what it holds.

**Parameters:**
- spreadsheet_id: ID or full Sheets URL (required)
- range: the A1 range to overwrite, naming its tab (required)
- values: rows of values, e.g. [["Rent", 2400], ["Groceries", 812]] (required)
- value_input_option: USER_ENTERED (default) | RAW

**Returns:** the range that was actually written and how many cells changed.

**Tip:** to add rows to the bottom of a table without overwriting anything, use
append_sheet_rows instead.`;

export function updateSheetValuesTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'update_sheet_values',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: PARAM_DESCRIPTIONS.spreadsheet_id },
        range: { type: 'string', description: PARAM_DESCRIPTIONS.range },
        sheet_gid: { type: 'number', description: PARAM_DESCRIPTIONS.sheet_gid },
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
        const parsed = UpdateSheetValuesSchema.parse(args ?? {});
        const spreadsheetId = parseSpreadsheetId(parsed.spreadsheet_id);
        const client = clientFactory();

        // requireTab: a bare "B4:D6" resolves to the FIRST tab, which is how a
        // caller who read one tab silently overwrites another.
        const range = await resolveRange(client, spreadsheetId, {
          range: parsed.range,
          sheetGid: intendedSheetGid({
            spreadsheetIdOrUrl: parsed.spreadsheet_id,
            range: parsed.range,
            sheetGid: parsed.sheet_gid,
          }),
          requireTab: true,
        });

        const result = await client.updateValues(
          spreadsheetId,
          range,
          parsed.values as unknown[][],
          parsed.value_input_option ?? 'USER_ENTERED'
        );

        const output =
          `Updated ${result.updatedRange ?? range}: ` +
          `${result.updatedCells ?? 0} cell(s) across ${result.updatedRows ?? 0} row(s).`;

        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('update-sheet-values-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error updating values: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
