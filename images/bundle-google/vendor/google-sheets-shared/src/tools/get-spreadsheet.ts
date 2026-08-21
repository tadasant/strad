import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { parseSpreadsheetId } from '../utils/parse-spreadsheet-id.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  spreadsheet_id:
    'The spreadsheet ID, or the full Sheets URL (e.g. ' +
    'https://docs.google.com/spreadsheets/d/.../edit#gid=0). Both forms are accepted.',
} as const;

export const GetSpreadsheetSchema = z.object({
  spreadsheet_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.spreadsheet_id),
});

const TOOL_DESCRIPTION = `Map a spreadsheet: its tabs, their sizes and gids, and its named ranges.

Call this FIRST when you do not already know a spreadsheet's structure. Every
other tool addresses cells in A1 notation ('Tab name'!A1:D50), and this is where
the tab names come from. It reads no cell values, so it is cheap on a large file.

**Parameters:**
- spreadsheet_id: ID or full Sheets URL (required)

**Returns:**
- Title, locale and time zone
- Each tab: title, gid, index, size (rows x columns), frozen rows/columns, hidden
- Named ranges, if any

The gid is what a browser URL carries after #gid=; get_sheet_values takes it
directly, so a URL a human pasted is enough to read the tab they were looking at.`;

export function getSpreadsheetTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'get_spreadsheet',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.spreadsheet_id,
        },
      },
      required: ['spreadsheet_id'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = GetSpreadsheetSchema.parse(args ?? {});
        const spreadsheetId = parseSpreadsheetId(parsed.spreadsheet_id);
        const client = clientFactory();

        const spreadsheet = await client.getSpreadsheet(spreadsheetId);

        let output = `# ${spreadsheet.properties?.title || '(Untitled spreadsheet)'}\n\n`;
        output += `**Spreadsheet ID:** ${spreadsheet.spreadsheetId}\n`;
        if (spreadsheet.properties?.locale) {
          output += `**Locale:** ${spreadsheet.properties.locale}\n`;
        }
        if (spreadsheet.properties?.timeZone) {
          output += `**Time zone:** ${spreadsheet.properties.timeZone}\n`;
        }
        output += '\n## Tabs\n\n';

        const sheets = spreadsheet.sheets ?? [];
        if (sheets.length === 0) {
          output += '_(this spreadsheet reports no tabs)_\n';
        }
        for (const sheet of sheets) {
          const props = sheet.properties ?? {};
          const grid = props.gridProperties ?? {};
          output += `- **${props.title ?? '(untitled)'}** — gid ${props.sheetId ?? '?'}`;
          if (grid.rowCount !== undefined && grid.columnCount !== undefined) {
            output += `, ${grid.rowCount} rows x ${grid.columnCount} columns`;
          }
          if (grid.frozenRowCount) output += `, ${grid.frozenRowCount} frozen row(s)`;
          if (props.hidden) output += ', hidden';
          if (props.sheetType && props.sheetType !== 'GRID') output += `, ${props.sheetType}`;
          output += '\n';
        }

        const named = spreadsheet.namedRanges ?? [];
        if (named.length > 0) {
          output += '\n## Named ranges\n\n';
          for (const range of named) {
            output += `- ${range.name ?? '(unnamed)'}`;
            if (range.range?.sheetId !== undefined) output += ` — gid ${range.range.sheetId}`;
            output += '\n';
          }
        }

        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('get-spreadsheet-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error reading spreadsheet: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
