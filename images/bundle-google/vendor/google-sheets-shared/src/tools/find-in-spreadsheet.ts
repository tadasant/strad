import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { parseSpreadsheetId } from '../utils/parse-spreadsheet-id.js';
import { sheetRange } from '../utils/a1.js';
import { findCells } from '../utils/find-cells.js';
import { logError } from '../logging.js';

/** How many tabs one call will read. A workbook can have hundreds. */
const MAX_TABS = 10;

const PARAM_DESCRIPTIONS = {
  spreadsheet_id: 'The spreadsheet ID, or the full Sheets URL.',
  query: 'The text to look for. Matched as a substring unless exact is true.',
  sheet_titles:
    'Tabs to search, by title. Omit to search the first ' +
    `${MAX_TABS} visible tabs. Naming the tabs is much cheaper on a large workbook.`,
  exact: 'Match the whole cell rather than any substring of it. Default false.',
  match_case: 'Match case. Default false.',
  max_results: 'Stop after this many hits. Default 50.',
} as const;

export const FindInSpreadsheetSchema = z.object({
  spreadsheet_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.spreadsheet_id),
  query: z.string().min(1).describe(PARAM_DESCRIPTIONS.query),
  sheet_titles: z.array(z.string().min(1)).optional().describe(PARAM_DESCRIPTIONS.sheet_titles),
  exact: z.boolean().optional().describe(PARAM_DESCRIPTIONS.exact),
  match_case: z.boolean().optional().describe(PARAM_DESCRIPTIONS.match_case),
  max_results: z.number().int().positive().max(500).optional().describe(PARAM_DESCRIPTIONS.max_results),
});

const TOOL_DESCRIPTION = `Find which cells contain a piece of text, and report their A1 addresses.

The Sheets API has no server-side search, so this reads the tabs and scans them.
That is not free on a large workbook: name the tabs you care about in
sheet_titles when you can, and expect a whole-workbook search to be the expensive
call in a session.

**Parameters:**
- spreadsheet_id: ID or full Sheets URL (required)
- query: text to look for (required)
- sheet_titles: tabs to search (default: the first ${MAX_TABS} visible tabs)
- exact: whole-cell match instead of substring (default false)
- match_case: default false
- max_results: default 50

**Returns:** every matching cell as "'Tab'!C14 — the cell's text", which is an
address you can hand to get_sheet_values or update_sheet_values unchanged.

**Use it for:** locating a row label ("Roth IRA") before reading or updating the
numbers beside it.`;

export function findInSpreadsheetTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'find_in_spreadsheet',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: PARAM_DESCRIPTIONS.spreadsheet_id },
        query: { type: 'string', description: PARAM_DESCRIPTIONS.query },
        sheet_titles: {
          type: 'array',
          items: { type: 'string' },
          description: PARAM_DESCRIPTIONS.sheet_titles,
        },
        exact: { type: 'boolean', description: PARAM_DESCRIPTIONS.exact },
        match_case: { type: 'boolean', description: PARAM_DESCRIPTIONS.match_case },
        max_results: { type: 'number', description: PARAM_DESCRIPTIONS.max_results },
      },
      required: ['spreadsheet_id', 'query'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = FindInSpreadsheetSchema.parse(args ?? {});
        const spreadsheetId = parseSpreadsheetId(parsed.spreadsheet_id);
        const client = clientFactory();

        let titles = parsed.sheet_titles;
        let capped = false;
        if (!titles || titles.length === 0) {
          const spreadsheet = await client.getSpreadsheet(spreadsheetId);
          const visible = (spreadsheet.sheets ?? [])
            .filter((sheet) => !sheet.properties?.hidden)
            .map((sheet) => sheet.properties?.title)
            .filter((title): title is string => Boolean(title));
          capped = visible.length > MAX_TABS;
          titles = visible.slice(0, MAX_TABS);
        }

        if (titles.length === 0) {
          return {
            content: [{ type: 'text', text: 'This spreadsheet has no visible tabs to search.' }],
          };
        }

        const response = await client.batchGetValues(
          spreadsheetId,
          titles.map((title) => sheetRange(title))
        );

        const { hits, truncated } = findCells(response.valueRanges ?? [], parsed.query, {
          matchCase: parsed.match_case,
          exact: parsed.exact,
          maxResults: parsed.max_results ?? 50,
        });

        let output = `Searched ${titles.length} tab(s) for "${parsed.query}": ${hits.length} hit(s).\n\n`;
        for (const hit of hits) {
          output += `- ${hit.address} — ${hit.value}\n`;
        }
        if (hits.length === 0) {
          output += '_No cell contains that text in the tabs searched._\n';
        }
        if (truncated) {
          output += '\n_Stopped at max_results; there may be more._\n';
        }
        if (capped) {
          output +=
            `\n_Only the first ${MAX_TABS} visible tabs were searched. Pass sheet_titles to search others._\n`;
        }

        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('find-in-spreadsheet-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error searching spreadsheet: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
