import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { parseSpreadsheetId, parseSheetGid } from '../utils/parse-spreadsheet-id.js';
import {
  BORDER_STYLES,
  HORIZONTAL_ALIGNMENTS,
  NUMBER_FORMAT_TYPES,
  VERTICAL_ALIGNMENTS,
  WRAP_STRATEGIES,
} from '../google-sheets-client/lib/format-cells.js';
import { logError } from '../logging.js';

/** One batchUpdate carries them all; this bounds a single call, not a sheet. */
const MAX_ENTRIES = 200;

const PARAM_DESCRIPTIONS = {
  spreadsheet_id: 'The spreadsheet ID, or the full Sheets URL.',
  sheet_gid:
    'The tab a range with no tab in it means, by gid (the number after #gid= in a Sheets URL). ' +
    "A range that names its own tab (\"'Offer A'!B2:D20\") ignores it. A pasted URL's #gid= " +
    'counts as this.',
  formats:
    'What to style, as a list of { range, format }. All of them are applied in ONE request: ' +
    'every entry lands, or none does. Later entries win where ranges overlap.',
  range:
    "An A1 range, naming its tab unless sheet_gid is given: \"'Offer A'!B2:D20\", " +
    "\"Summary!A1:F1\" (a row of headers), \"'Offer A'!C:C\" (a whole column), " +
    '"Summary" (the whole tab).',
  format:
    'The formatting to set. Only the keys given are changed; everything else about the ' +
    'cells — values, and formatting not named here — stays as it is.',
} as const;

const hexColor = z
  .string()
  .regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a hex colour: "#1a73e8" or "#fff".');

const border = z
  .object({ style: z.enum(BORDER_STYLES), color: hexColor.optional() })
  .strict();

// `.strict()` throughout: an unknown key (`fill_color`, `bg`) is refused by
// name. Stripped in silence, it would be a call that reports success and styles
// nothing.
const formatSchema = z
  .object({
    background_color: hexColor.optional(),
    text_color: hexColor.optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    font_size: z.number().int().min(1).max(400).optional(),
    font_family: z.string().trim().min(1).optional(),
    number_format: z
      .object({ type: z.enum(NUMBER_FORMAT_TYPES), pattern: z.string().optional() })
      .strict()
      .optional(),
    horizontal_alignment: z.enum(HORIZONTAL_ALIGNMENTS).optional(),
    vertical_alignment: z.enum(VERTICAL_ALIGNMENTS).optional(),
    wrap_strategy: z.enum(WRAP_STRATEGIES).optional(),
    borders: z
      .object({
        outer: border.optional(),
        inner: border.optional(),
        top: border.optional(),
        bottom: border.optional(),
        left: border.optional(),
        right: border.optional(),
        inner_horizontal: border.optional(),
        inner_vertical: border.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const FormatCellsSchema = z.object({
  spreadsheet_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.spreadsheet_id),
  sheet_gid: z.number().int().optional().describe(PARAM_DESCRIPTIONS.sheet_gid),
  formats: z
    .array(
      z
        .object({
          range: z.string().trim().min(1).describe(PARAM_DESCRIPTIONS.range),
          format: formatSchema.describe(PARAM_DESCRIPTIONS.format),
        })
        .strict()
    )
    .min(1)
    .max(MAX_ENTRIES)
    .describe(PARAM_DESCRIPTIONS.formats),
});

const TOOL_DESCRIPTION = `Style cells in a spreadsheet: fill colour, bold/italic/font, number format (currency, percent, custom patterns), alignment, wrapping and borders. Values are never touched.

Give a list of { range, format }, so a whole sheet styles in one call. Every entry is applied in ONE request — all land or none do. In each format, only the keys you give change; a cell's other formatting stays.

**format keys** (all optional; give at least one):
- background_color, text_color: hex, "#1a73e8" or "#fff"
- bold, italic, underline, strikethrough: true / false
- font_size: points, e.g. 11. font_family: e.g. "Roboto"
- number_format: { type, pattern? }. type is one of
  TEXT, NUMBER, PERCENT, CURRENCY, DATE, TIME, DATE_TIME, SCIENTIFIC.
  pattern is the Sheets custom-format string, e.g.
  "$#,##0" (dollars), "$#,##0.00", "0.0%", "$#,##0,,\\"M\\"" (millions, "$12M"),
  "0.0\\"x\\"" (a multiple, "2.5x"), "yyyy-mm-dd". Without a pattern the
  locale's default for the type is used.
- horizontal_alignment: LEFT, CENTER, RIGHT
- vertical_alignment: TOP, MIDDLE, BOTTOM
- wrap_strategy: OVERFLOW_CELL (spill into empty neighbours), CLIP, WRAP
- borders: { outer?, inner?, top?, bottom?, left?, right?, inner_horizontal?, inner_vertical? },
  each { style, color? }. outer = all four edges, inner = the lines between cells; a side
  named on its own overrides them. style: SOLID, SOLID_MEDIUM, SOLID_THICK, DASHED, DOTTED,
  DOUBLE, or NONE to remove that border. color defaults to black. Unnamed sides are left as they are.

**Example:**
{ "spreadsheet_id": "1Bxi…", "formats": [
  { "range": "'Offer A'!A1:F1", "format": { "background_color": "#1f4e79", "text_color": "#fff", "bold": true, "horizontal_alignment": "CENTER" } },
  { "range": "'Offer A'!B2:D20", "format": { "number_format": { "type": "CURRENCY", "pattern": "$#,##0" } } },
  { "range": "'Offer A'!A1:F20", "format": { "borders": { "outer": { "style": "SOLID_MEDIUM" }, "inner": { "style": "SOLID", "color": "#d9d9d9" } } } }
] }

**Returns:**
Formatted 3 ranges in 1Bxi… (3 requests).
- 'Offer A'!A1:F1 — backgroundColor, backgroundColorStyle, textFormat.foregroundColor, …
- 'Offer A'!B2:D20 — numberFormat
- 'Offer A'!A1:F20 — borders.top, borders.bottom, …

**Use cases:**
- A header row: dark fill, white bold text, centred
- Dollar, percent and multiple columns shown as "$1,250,000", "12.5%", "2.5x" instead of raw numbers
- Banding or highlighting rows that need attention
- Boxing a table with an outer border and light inner gridlines

To undo a style, set it back: bold false, background_color "#ffffff", a border style NONE, number_format { "type": "NUMBER" }. Column widths, merged cells and conditional formatting are not reachable here. An uploaded .xlsx is refused; it must be saved as a Google Sheet first.`;

/** A refused argument reads as a sentence per issue, not as Zod's JSON dump. */
function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

const borderJson = {
  type: 'object',
  properties: {
    style: { type: 'string', enum: [...BORDER_STYLES] },
    color: { type: 'string', description: 'Hex. Default black.' },
  },
  required: ['style'],
};

export function formatCellsTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'format_cells',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: PARAM_DESCRIPTIONS.spreadsheet_id },
        sheet_gid: { type: 'number', description: PARAM_DESCRIPTIONS.sheet_gid },
        formats: {
          type: 'array',
          description: PARAM_DESCRIPTIONS.formats,
          minItems: 1,
          maxItems: MAX_ENTRIES,
          items: {
            type: 'object',
            properties: {
              range: { type: 'string', description: PARAM_DESCRIPTIONS.range },
              format: {
                type: 'object',
                description: PARAM_DESCRIPTIONS.format,
                properties: {
                  background_color: { type: 'string', description: 'Hex fill, e.g. "#d9ead3".' },
                  text_color: { type: 'string', description: 'Hex font colour.' },
                  bold: { type: 'boolean' },
                  italic: { type: 'boolean' },
                  underline: { type: 'boolean' },
                  strikethrough: { type: 'boolean' },
                  font_size: { type: 'number', description: 'Points.' },
                  font_family: { type: 'string' },
                  number_format: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: [...NUMBER_FORMAT_TYPES] },
                      pattern: {
                        type: 'string',
                        description: 'Sheets custom format, e.g. "$#,##0", "0.0%", "0.0\\"x\\"".',
                      },
                    },
                    required: ['type'],
                  },
                  horizontal_alignment: { type: 'string', enum: [...HORIZONTAL_ALIGNMENTS] },
                  vertical_alignment: { type: 'string', enum: [...VERTICAL_ALIGNMENTS] },
                  wrap_strategy: { type: 'string', enum: [...WRAP_STRATEGIES] },
                  borders: {
                    type: 'object',
                    properties: {
                      outer: borderJson,
                      inner: borderJson,
                      top: borderJson,
                      bottom: borderJson,
                      left: borderJson,
                      right: borderJson,
                      inner_horizontal: borderJson,
                      inner_vertical: borderJson,
                    },
                  },
                },
              },
            },
            required: ['range', 'format'],
          },
        },
      },
      required: ['spreadsheet_id', 'formats'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = FormatCellsSchema.parse(args ?? {});
        const spreadsheetId = parseSpreadsheetId(parsed.spreadsheet_id);
        const client = clientFactory();

        const result = await client.formatCells(
          spreadsheetId,
          parsed.formats,
          parsed.sheet_gid ?? parseSheetGid(parsed.spreadsheet_id)
        );

        const lines = [
          `Formatted ${result.applied.length} range${result.applied.length === 1 ? '' : 's'} ` +
            `in ${result.spreadsheetId} (${result.requestCount} request${result.requestCount === 1 ? '' : 's'}).`,
          ...result.applied.map((a) => `- ${a.range} — ${a.fields.join(', ')}`),
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        logError('format-cells-tool', error);
        return {
          content: [{ type: 'text', text: `Error formatting cells: ${describeError(error)}` }],
          isError: true,
        };
      }
    },
  };
}
