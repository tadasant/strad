/**
 * What this server knows about a workbook it parsed itself.
 *
 * Deliberately the SMALLEST shape the four read tools need, because everything
 * downstream of it — `resolveRange`, `findCells`, `renderValueRange` — already
 * speaks the Sheets API's `Spreadsheet` and `ValueRange`. This model exists only
 * to be adapted into those two, in `to-sheets.ts`.
 *
 * A cell is `string | number | boolean | null`. That is the same set the Sheets
 * values API returns, which is why the renderers need no cases for anything
 * else.
 */

export type OfficeCell = string | number | boolean | null;

export interface OfficeSheet {
  /** Tab title, as the workbook spells it. */
  title: string;
  /** 0-based position, as `Spreadsheet.sheets[].properties.index` means it. */
  index: number;
  /**
   * The workbook's own id for the tab, reported as the `gid`.
   *
   * It is NOT a Sheets gid — an .xlsx has no gids — but it is stable within the
   * file, and `get_spreadsheet` reports the same number `sheet_gid` then
   * resolves, so a caller that reads the map and asks for a tab by number gets
   * the tab it read about.
   */
  gid: number;
  hidden: boolean;
  /** Rows, ragged, trailing empties trimmed the way the Sheets API trims them. */
  rows: OfficeCell[][];
  /**
   * Formula text per cell, where the cell has one. Sparse and parallel to
   * {@link rows}; `undefined` everywhere else. Only `FORMULA` reads it.
   */
  formulas?: (string | undefined)[][];
}

export interface OfficeWorkbook {
  /** The Drive file's name, used as the spreadsheet title. */
  title: string;
  /** The Drive mime type it was read as. */
  mimeType: string;
  sheets: OfficeSheet[];
}

/**
 * How many non-empty cells one workbook may parse to before this server gives up.
 *
 * Sized against the container for the same reason the ZIP bounds are: the parsed
 * rows are live JavaScript arrays in a process twenty-one other MCP servers
 * share. Half a million is a very large workbook — forty tabs of twelve thousand
 * filled cells — and past it the right answer is "convert this to a native
 * spreadsheet", which the refusal says.
 */
export const MAX_PARSED_CELLS = 500_000;

export class OfficeWorkbookTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeWorkbookTooLargeError';
  }
}

/** Drop trailing empty cells from a row, and trailing empty rows from a sheet. */
export function trimTrailingEmpties(rows: OfficeCell[][]): OfficeCell[][] {
  const trimmed = rows.map((row) => {
    let end = row.length;
    while (end > 0 && (row[end - 1] === null || row[end - 1] === '')) end -= 1;
    return row.slice(0, end);
  });
  let last = trimmed.length;
  while (last > 0 && trimmed[last - 1].length === 0) last -= 1;
  return trimmed.slice(0, last);
}
