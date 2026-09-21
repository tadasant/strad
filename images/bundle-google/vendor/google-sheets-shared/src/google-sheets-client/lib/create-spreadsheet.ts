import { throwForGoogleApiError } from './api-errors.js';
import { SHEETS_BASE_URL } from './get-spreadsheet.js';
import type { Spreadsheet } from '../../types.js';

/** One tab of a new spreadsheet, and the row of headers to put in it, if any. */
export interface NewSheet {
  title: string;
  headers?: string[];
}

export interface CreateSpreadsheetRequest {
  title: string;
  /** Omit or leave empty and Google makes one tab, `Sheet1`. */
  sheets?: NewSheet[];
}

/** Sheets' default grid for a new tab. Only the column count is ever widened. */
const DEFAULT_COLUMN_COUNT = 26;

/**
 * What the reply is narrowed to: the file's id, its URL and title, and each
 * tab's identity. The default reply is the whole spreadsheet resource.
 */
const CREATED_FIELDS = 'spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title,index))';

/**
 * `spreadsheets.create`, which needs nothing wider than the `spreadsheets` scope
 * every `-rw` slug already holds. Google's discovery document lists `drive`,
 * `drive.file` and `spreadsheets` as each sufficient, and the file lands in the
 * account's Drive root. Putting it in a FOLDER is a Drive API call, which is why
 * no parameter here asks for one.
 *
 * ONE request, so the file, its tabs and their header rows exist together or not
 * at all: a create followed by a separate values write could leave a spreadsheet
 * behind with no headers and report a failure, and a caller retrying that would
 * make a second file.
 */
export async function createSpreadsheet(
  headers: Record<string, string>,
  request: CreateSpreadsheetRequest
): Promise<Spreadsheet> {
  const body: Record<string, unknown> = { properties: { title: request.title } };
  if (request.sheets && request.sheets.length > 0) {
    body.sheets = request.sheets.map(newSheetBody);
  }

  const response = await fetch(`${SHEETS_BASE_URL}?fields=${encodeURIComponent(CREATED_FIELDS)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await throwForGoogleApiError(response, `Create spreadsheet "${request.title}"`);
  }

  return (await response.json()) as Spreadsheet;
}

/**
 * A `Sheet` resource for one tab: its title and, given headers, a frozen first
 * row holding them. The grid is widened when there are more headers than
 * Sheets' default 26 columns, rather than trusting the API to grow it.
 */
function newSheetBody(sheet: NewSheet, index: number): Record<string, unknown> {
  const properties: Record<string, unknown> = { title: sheet.title, index };
  const headers = sheet.headers ?? [];
  if (headers.length === 0) return { properties };

  properties.gridProperties = {
    frozenRowCount: 1,
    ...(headers.length > DEFAULT_COLUMN_COUNT ? { columnCount: headers.length } : {}),
  };
  return {
    properties,
    data: [
      {
        startRow: 0,
        startColumn: 0,
        rowData: [
          { values: headers.map((header) => ({ userEnteredValue: { stringValue: header } })) },
        ],
      },
    ],
  };
}
