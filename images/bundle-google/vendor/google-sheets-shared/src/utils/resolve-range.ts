import type { IGoogleSheetsClient } from '../server.js';
import type { Spreadsheet } from '../types.js';
import { sheetRange } from './a1.js';
import { parseSheetGid } from './parse-spreadsheet-id.js';

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
  input: { range?: string; sheetGid?: number; requireTab?: boolean }
): Promise<string> {
  const { range, sheetGid, requireTab } = input;

  if (sheetGid === undefined) {
    if (range?.includes('!')) return range;

    // NOTHING NAMES A TAB. Sheets resolves a bare `B4:D6` against the FIRST tab,
    // which is a fine default for a read and a bad one for a write: a caller who
    // read gid 1680010701 and then writes `B4:D6` would silently write to a
    // different tab. So the write tools ask for `requireTab` and get an error
    // instead of a default.
    if (requireTab) {
      throw new Error(
        `The range "${range ?? '(none)'}" does not name a tab, so this write would land on the ` +
          "FIRST tab of the spreadsheet. Name the tab (\"'Q1 2026'!B4:D6\") or pass sheet_gid."
      );
    }
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

/**
 * The tab a caller meant, from an explicit `sheet_gid` or from a pasted URL.
 *
 * A URL carries `#gid=…`, and pasting one is the ordinary way a human names a
 * tab. That is an INFERENCE though, so an explicit tab inside `range` outranks
 * it — treating the two as a conflict would reject a perfectly clear call.
 */
export function intendedSheetGid(input: {
  spreadsheetIdOrUrl: string;
  range?: string;
  sheetGid?: number;
}): number | undefined {
  if (input.sheetGid !== undefined) return input.sheetGid;
  if (input.range?.includes('!')) return undefined;
  return parseSheetGid(input.spreadsheetIdOrUrl);
}
