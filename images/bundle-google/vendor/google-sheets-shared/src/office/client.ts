/**
 * The Office-file behaviour, as a DECORATOR over a plain Sheets API client.
 *
 * Kept out of the OAuth client on purpose. That class's job is a credential —
 * one Google account's refresh token, its access-token cache, and its
 * single-flight refresh — and it is the one part of this server that cannot be
 * exercised without talking to Google. Everything decided here is decided
 * without a credential: whether a failure means "Office file", whether to reach
 * for Drive, what a write is told. Wrapping rather than subclassing is what
 * lets a test drive all four read tools over a fake workbook and a stub Drive.
 *
 * Reads fall back. Writes to an existing file refuse; a create has none. See `readWithOfficeFallback` and
 * `writeRefusingOfficeFiles` in ./load.ts for why the two differ.
 */
import type { IGoogleSheetsClient } from '../server.js';
import type { SheetProperties, Spreadsheet, ValueRange, BatchGetValuesResponse } from '../types.js';
import type {
  ReadValuesOptions,
  ValueInputOption,
  UpdateValuesResponse,
  AppendValuesResponse,
  ClearValuesResponse,
} from '../google-sheets-client/lib/values.js';
import type { CreateSpreadsheetRequest } from '../google-sheets-client/lib/create-spreadsheet.js';
import {
  OfficeWorkbookLoader,
  readWithOfficeFallback,
  writeRefusingOfficeFiles,
} from './load.js';
import {
  workbookBatchValueRanges,
  workbookToSpreadsheet,
  workbookValueRange,
} from './to-sheets.js';

/**
 * A Sheets client that also serves Office files, wrapping one that does not.
 *
 * A class rather than an object literal so that the thing it wraps stays
 * reachable and named: `createDefaultClient` caches one of these per credential,
 * and what that cache must never do is share an account's workbook with another
 * account's mount.
 */
class OfficeAwareClient implements IGoogleSheetsClient {
  constructor(
    private readonly sheets: IGoogleSheetsClient,
    private readonly office: OfficeWorkbookLoader
  ) {}

  getSpreadsheet(spreadsheetId: string): Promise<Spreadsheet> {
    return readWithOfficeFallback(
      () => this.sheets.getSpreadsheet(spreadsheetId),
      async () => workbookToSpreadsheet(spreadsheetId, await this.office.load(spreadsheetId))
    );
  }

  getValues(
    spreadsheetId: string,
    range: string,
    options?: ReadValuesOptions
  ): Promise<ValueRange> {
    return readWithOfficeFallback(
      () => this.sheets.getValues(spreadsheetId, range, options),
      async () => workbookValueRange(await this.office.load(spreadsheetId), range, options)
    );
  }

  batchGetValues(
    spreadsheetId: string,
    ranges: string[],
    options?: ReadValuesOptions
  ): Promise<BatchGetValuesResponse> {
    return readWithOfficeFallback(
      () => this.sheets.batchGetValues(spreadsheetId, ranges, options),
      async () =>
        workbookBatchValueRanges(spreadsheetId, await this.office.load(spreadsheetId), ranges, options)
    );
  }

  updateValues(
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    valueInputOption: ValueInputOption
  ): Promise<UpdateValuesResponse> {
    return writeRefusingOfficeFiles('update_sheet_values', spreadsheetId, () =>
      this.sheets.updateValues(spreadsheetId, range, values, valueInputOption)
    );
  }

  appendValues(
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    valueInputOption: ValueInputOption
  ): Promise<AppendValuesResponse> {
    return writeRefusingOfficeFiles('append_sheet_rows', spreadsheetId, () =>
      this.sheets.appendValues(spreadsheetId, range, values, valueInputOption)
    );
  }

  clearValues(spreadsheetId: string, range: string): Promise<ClearValuesResponse> {
    return writeRefusingOfficeFiles('clear_sheet_values', spreadsheetId, () =>
      this.sheets.clearValues(spreadsheetId, range)
    );
  }

  addSheet(
    spreadsheetId: string,
    properties: { title: string; index?: number; rowCount?: number; columnCount?: number }
  ): Promise<SheetProperties> {
    return writeRefusingOfficeFiles('add_sheet', spreadsheetId, () =>
      this.sheets.addSheet(spreadsheetId, properties)
    );
  }

  /**
   * Straight through. There is no existing file to be an Office one: what
   * `spreadsheets.create` makes is always a native Google Sheet.
   */
  createSpreadsheet(request: CreateSpreadsheetRequest): Promise<Spreadsheet> {
    return this.sheets.createSpreadsheet(request);
  }
}

export function withOfficeFallback(
  inner: IGoogleSheetsClient,
  office: OfficeWorkbookLoader
): IGoogleSheetsClient {
  return new OfficeAwareClient(inner, office);
}
