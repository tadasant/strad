import { throwForGoogleApiError } from './api-errors.js';
import type { Spreadsheet } from '../../types.js';

export const SHEETS_BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * `spreadsheets.get` WITHOUT grid data.
 *
 * The default response for a large spreadsheet is enormous, because
 * `includeGridData` defaults to false but the properties of every sheet, every
 * conditional format and every filter view still come back. `fields` narrows it
 * to what get_spreadsheet actually renders: the file's own properties, each
 * tab's identity and size, and the named ranges.
 */
const METADATA_FIELDS =
  'spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),' +
  'sheets(properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))),' +
  'namedRanges(namedRangeId,name,range)';

export async function getSpreadsheet(
  headers: Record<string, string>,
  spreadsheetId: string
): Promise<Spreadsheet> {
  const url = `${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(METADATA_FIELDS)}`;
  const response = await fetch(url, { method: 'GET', headers });

  if (!response.ok) {
    await throwForGoogleApiError(response, `Get spreadsheet ${spreadsheetId}`);
  }

  return (await response.json()) as Spreadsheet;
}
