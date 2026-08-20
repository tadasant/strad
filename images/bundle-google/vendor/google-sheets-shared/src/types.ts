/**
 * The slice of the Google Sheets API v4 surface this server reads.
 *
 * Only the READ shapes exist here. There is no batchUpdate request type and no
 * values.update body, because this server has no code that could send one — see
 * the note at the top of server.ts.
 *
 * The real resources are much larger than these interfaces; every one of them
 * keeps an index signature so a caller asking for the raw JSON gets the whole
 * payload rather than the fields that happened to be modelled.
 */

export interface GridProperties {
  rowCount?: number;
  columnCount?: number;
  frozenRowCount?: number;
  frozenColumnCount?: number;
  [k: string]: unknown;
}

export interface SheetProperties {
  sheetId?: number;
  title?: string;
  index?: number;
  sheetType?: string;
  hidden?: boolean;
  gridProperties?: GridProperties;
  [k: string]: unknown;
}

export interface Sheet {
  properties?: SheetProperties;
  [k: string]: unknown;
}

export interface GridRange {
  sheetId?: number;
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
  [k: string]: unknown;
}

export interface NamedRange {
  namedRangeId?: string;
  name?: string;
  range?: GridRange;
  [k: string]: unknown;
}

export interface SpreadsheetProperties {
  title?: string;
  locale?: string;
  timeZone?: string;
  [k: string]: unknown;
}

export interface Spreadsheet {
  spreadsheetId: string;
  properties?: SpreadsheetProperties;
  sheets?: Sheet[];
  namedRanges?: NamedRange[];
  spreadsheetUrl?: string;
  [k: string]: unknown;
}

/**
 * A `spreadsheets.values.get` response.
 *
 * `values` is a ragged array: Sheets omits trailing empty cells in a row and
 * trailing empty rows in a range, so row `n` is not guaranteed to have the same
 * length as row `n-1`, and an entirely blank range comes back with no `values`
 * key at all. Every consumer here treats a missing cell as empty rather than
 * indexing blindly.
 */
export interface ValueRange {
  range?: string;
  majorDimension?: string;
  values?: unknown[][];
  [k: string]: unknown;
}

export interface BatchGetValuesResponse {
  spreadsheetId?: string;
  valueRanges?: ValueRange[];
  [k: string]: unknown;
}

/** How a cell's value is rendered by the API. */
export type ValueRenderOption = 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA';

/** How a date/time cell is rendered by the API. */
export type DateTimeRenderOption = 'FORMATTED_STRING' | 'SERIAL_NUMBER';
