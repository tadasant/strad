import type { IGoogleSheetsClient } from '../server.js';
import type { Spreadsheet } from '../types.js';
import { sheetRange } from './a1.js';

/** The tab a `gid` names, by title. Throws naming the tabs that do exist. */
export function sheetTitleForGid(spreadsheet: Spreadsheet, gid: number): string {
  const sheets = spreadsheet.sheets ?? [];
  const match = sheets.find((sheet) => sheet.properties?.sheetId === gid);
  const title = match?.properties?.title;
  if (!title) {
    const known = sheets
      .map((sheet) => `${sheet.properties?.title} (gid ${sheet.properties?.sheetId})`)
      .join(', ');
    throw new Error(
      `No tab with gid ${gid} in this spreadsheet. It has: ${known || '(no tabs reported)'}`
    );
  }
  return title;
}

/**
 * Turn what a caller gave us into one A1 range.
 *
 * A caller has one of three things, and all three are ordinary:
 *
 *   - an A1 range already, tab and all — `'Q1 2026'!A1:D50`
 *   - a `gid`, because that is what the URL in their browser carries
 *     (`...#gid=1680010701`), plus maybe a cell range within it
 *   - neither, meaning the first tab
 *
 * The gid path costs one extra metadata call, which is why it is only taken when
 * a gid is actually supplied.
 */
export async function resolveRange(
  client: IGoogleSheetsClient,
  spreadsheetId: string,
  input: { range?: string; sheetGid?: number }
): Promise<string> {
  const { range, sheetGid } = input;

  if (sheetGid === undefined) {
    if (range) return range;
    const spreadsheet = await client.getSpreadsheet(spreadsheetId);
    const first = spreadsheet.sheets?.[0]?.properties?.title;
    if (!first) throw new Error('This spreadsheet reports no tabs');
    return sheetRange(first);
  }

  // A gid was given. If the range already names a tab, the two disagree and the
  // caller should say which they meant rather than have one silently win.
  if (range?.includes('!')) {
    throw new Error(
      `Pass either sheet_gid or a range that names a tab, not both: "${range}" already names one.`
    );
  }

  const spreadsheet = await client.getSpreadsheet(spreadsheetId);
  return sheetRange(sheetTitleForGid(spreadsheet, sheetGid), range);
}
