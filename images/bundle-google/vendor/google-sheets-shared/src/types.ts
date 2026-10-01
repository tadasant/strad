/**
 * The slice of the Google Sheets API v4 surface this server reads.
 *
 * The shapes are narrow on purpose. Reads model only what the renderers touch;
 * the write side models one batchUpdate reply (`addSheet`) and nothing else,
 * because no tool takes a raw request object — see batch-update.ts. The create
 * body is built, and typed, in create-spreadsheet.ts, and the formatting
 * requests in format-cells.ts.
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

/**
 * Where a result came from, when it did not come from the Sheets API.
 *
 * Present ONLY on the Office path — a Drive file strad downloaded and parsed
 * itself because the Sheets API refuses it. Absent means the ordinary thing
 * happened, which is why every tool prints {@link note} whenever it is there:
 * the two reads are not equivalent, and a caller has to be able to tell.
 */
export interface OfficeSource {
  /** The Drive mime type the file was parsed as. */
  mimeType: string;
  /** One line the tools append to their output verbatim. */
  note: string;
}

export interface Spreadsheet {
  spreadsheetId: string;
  properties?: SpreadsheetProperties;
  sheets?: Sheet[];
  namedRanges?: NamedRange[];
  spreadsheetUrl?: string;
  officeSource?: OfficeSource;
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
  officeSource?: OfficeSource;
  [k: string]: unknown;
}

export interface BatchGetValuesResponse {
  spreadsheetId?: string;
  valueRanges?: ValueRange[];
  officeSource?: OfficeSource;
  [k: string]: unknown;
}

/** How a cell's value is rendered by the API. */
export type ValueRenderOption = 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA';
