import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { parseSpreadsheetId } from '../utils/parse-spreadsheet-id.js';
import { intendedSheetGid, resolveRange } from '../utils/resolve-range.js';
import { renderValueRange } from '../utils/format-values.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  spreadsheet_id:
    'The spreadsheet ID, or the full Sheets URL. A URL carrying #gid= also selects that tab.',
  range:
    'A1 range to read, e.g. "\'Q1 2026\'!A1:D50" or "A1:D50". Omit to read the whole ' +
    'tab. A tab title containing a space or an apostrophe must be quoted, as above.',
  sheet_gid:
    'The tab to read, by gid (the number in a Sheets URL after #gid=). An alternative ' +
    'to naming the tab in `range`; combine it with a bare cell range like "A1:D50" to ' +
    'read part of that tab. Costs one extra metadata lookup.',
  value_render_option:
    'How cells are rendered. FORMATTED_VALUE (default) is what the sheet displays, ' +
    'e.g. "$1,234.00". UNFORMATTED_VALUE is the underlying number, best for arithmetic. ' +
    'FORMULA returns the formula text, e.g. "=SUM(B2:B9)".',
  format:
    'Output shape. "table" (default) renders a markdown table addressed with real A1 ' +
    'column letters and row numbers. "json" returns the raw API valueRange.',
} as const;

export const GetSheetValuesSchema = z.object({
  spreadsheet_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.spreadsheet_id),
  range: z.string().optional().describe(PARAM_DESCRIPTIONS.range),
  sheet_gid: z.number().int().optional().describe(PARAM_DESCRIPTIONS.sheet_gid),
  value_render_option: z
    .enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'])
    .optional()
    .describe(PARAM_DESCRIPTIONS.value_render_option),
  format: z.enum(['table', 'json']).optional().describe(PARAM_DESCRIPTIONS.format),
});

const TOOL_DESCRIPTION = `Read the cells of one range of a spreadsheet.

**Parameters:**
- spreadsheet_id: ID or full Sheets URL (required)
- range: A1 range, e.g. "'Q1 2026'!A1:D50". Omit for the whole tab
- sheet_gid: tab by gid, instead of naming it in range
- value_render_option: FORMATTED_VALUE (default) | UNFORMATTED_VALUE | FORMULA
- format: "table" (default) | "json"

**Returns:** the cells, addressed the way the spreadsheet is — column letters
across the top and real row numbers down the side, so a cell you want to change
later has an address you can pass straight to update_sheet_values.

Large ranges are truncated, and say so. Ask for a narrower range rather than a
whole 20,000-row tab.

**Tip:** run get_spreadsheet first if you do not know the tab names.`;

export function getSheetValuesTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'get_sheet_values',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: PARAM_DESCRIPTIONS.spreadsheet_id },
        range: { type: 'string', description: PARAM_DESCRIPTIONS.range },
        sheet_gid: { type: 'number', description: PARAM_DESCRIPTIONS.sheet_gid },
        value_render_option: {
          type: 'string',
          enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'],
          description: PARAM_DESCRIPTIONS.value_render_option,
        },
        format: {
          type: 'string',
          enum: ['table', 'json'],
          description: PARAM_DESCRIPTIONS.format,
        },
      },
      required: ['spreadsheet_id'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = GetSheetValuesSchema.parse(args ?? {});
        const spreadsheetId = parseSpreadsheetId(parsed.spreadsheet_id);
        const client = clientFactory();

        const sheetGid = intendedSheetGid({
          spreadsheetIdOrUrl: parsed.spreadsheet_id,
          range: parsed.range,
          sheetGid: parsed.sheet_gid,
        });
        const range = await resolveRange(client, spreadsheetId, { range: parsed.range, sheetGid });

        const valueRange = await client.getValues(spreadsheetId, range, {
          valueRenderOption: parsed.value_render_option,
        });

        if (parsed.format === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify(valueRange, null, 2) }] };
        }

        const rendered = renderValueRange(valueRange);
        let output = `**Range:** ${valueRange.range ?? range}\n\n`;
        output += rendered.text;

        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('get-sheet-values-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error reading values: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
