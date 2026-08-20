import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { parseSpreadsheetId } from '../utils/parse-spreadsheet-id.js';
import { renderValueRange } from '../utils/format-values.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  spreadsheet_id: 'The spreadsheet ID, or the full Sheets URL.',
  ranges:
    'A1 ranges to read, e.g. ["\'Summary\'!A1:C20", "\'2026\'!A1:M2"]. Each must name its ' +
    'tab, since they may be different tabs.',
  value_render_option:
    'How cells are rendered: FORMATTED_VALUE (default), UNFORMATTED_VALUE, or FORMULA.',
} as const;

export const BatchGetSheetValuesSchema = z.object({
  spreadsheet_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.spreadsheet_id),
  ranges: z.array(z.string().min(1)).min(1).describe(PARAM_DESCRIPTIONS.ranges),
  value_render_option: z
    .enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'])
    .optional()
    .describe(PARAM_DESCRIPTIONS.value_render_option),
});

const TOOL_DESCRIPTION = `Read several ranges of one spreadsheet in a single call.

Use this instead of repeated get_sheet_values when you already know which blocks
you need — one HTTP round trip and one consistent read, rather than N.

**Parameters:**
- spreadsheet_id: ID or full Sheets URL (required)
- ranges: array of A1 ranges, each naming its tab (required)
- value_render_option: FORMATTED_VALUE (default) | UNFORMATTED_VALUE | FORMULA

**Returns:** one addressed table per range, in the order requested. Each range is
truncated independently and says so.`;

export function batchGetSheetValuesTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'batch_get_sheet_values',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: PARAM_DESCRIPTIONS.spreadsheet_id },
        ranges: {
          type: 'array',
          items: { type: 'string' },
          description: PARAM_DESCRIPTIONS.ranges,
        },
        value_render_option: {
          type: 'string',
          enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'],
          description: PARAM_DESCRIPTIONS.value_render_option,
        },
      },
      required: ['spreadsheet_id', 'ranges'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = BatchGetSheetValuesSchema.parse(args ?? {});
        const spreadsheetId = parseSpreadsheetId(parsed.spreadsheet_id);
        const client = clientFactory();

        const response = await client.batchGetValues(spreadsheetId, parsed.ranges, {
          valueRenderOption: parsed.value_render_option,
        });

        const valueRanges = response.valueRanges ?? [];
        let output = `Read ${valueRanges.length} range(s) from ${spreadsheetId}.\n`;
        for (const valueRange of valueRanges) {
          const rendered = renderValueRange(valueRange);
          output += `\n## ${valueRange.range ?? '(unnamed range)'}\n\n${rendered.text}\n`;
        }

        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('batch-get-sheet-values-tool', error);
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
