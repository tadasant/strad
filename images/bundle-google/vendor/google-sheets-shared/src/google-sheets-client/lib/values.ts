import { throwForGoogleApiError } from './api-errors.js';
import { SHEETS_BASE_URL } from './get-spreadsheet.js';
import type {
  BatchGetValuesResponse,
  DateTimeRenderOption,
  ValueRange,
  ValueRenderOption,
} from '../../types.js';

export interface ReadValuesOptions {
  valueRenderOption?: ValueRenderOption;
  dateTimeRenderOption?: DateTimeRenderOption;
}

function readQuery(options?: ReadValuesOptions): URLSearchParams {
  const query = new URLSearchParams();
  if (options?.valueRenderOption) query.set('valueRenderOption', options.valueRenderOption);
  if (options?.dateTimeRenderOption)
    query.set('dateTimeRenderOption', options.dateTimeRenderOption);
  return query;
}

export async function getValues(
  headers: Record<string, string>,
  spreadsheetId: string,
  range: string,
  options?: ReadValuesOptions
): Promise<ValueRange> {
  const query = readQuery(options);
  const url =
    `${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}` +
    (query.size > 0 ? `?${query.toString()}` : '');
  const response = await fetch(url, { method: 'GET', headers });

  if (!response.ok) {
    await throwForGoogleApiError(response, `Get values ${range}`);
  }

  return (await response.json()) as ValueRange;
}

export async function batchGetValues(
  headers: Record<string, string>,
  spreadsheetId: string,
  ranges: string[],
  options?: ReadValuesOptions
): Promise<BatchGetValuesResponse> {
  const query = readQuery(options);
  // `ranges` repeats, one parameter per range — not a comma-joined list.
  for (const range of ranges) query.append('ranges', range);
  const url = `${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}/values:batchGet?${query.toString()}`;
  const response = await fetch(url, { method: 'GET', headers });

  if (!response.ok) {
    await throwForGoogleApiError(response, `Batch get ${ranges.length} range(s)`);
  }

  return (await response.json()) as BatchGetValuesResponse;
}

/** How a written value is parsed by Sheets. */
export type ValueInputOption = 'RAW' | 'USER_ENTERED';

export interface UpdateValuesResponse {
  spreadsheetId?: string;
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
  [k: string]: unknown;
}

export async function updateValues(
  headers: Record<string, string>,
  spreadsheetId: string,
  range: string,
  values: unknown[][],
  valueInputOption: ValueInputOption
): Promise<UpdateValuesResponse> {
  const url =
    `${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}` +
    `?valueInputOption=${valueInputOption}&includeValuesInResponse=false`;
  const response = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
  });

  if (!response.ok) {
    await throwForGoogleApiError(response, `Update values ${range}`);
  }

  return (await response.json()) as UpdateValuesResponse;
}

export interface AppendValuesResponse {
  spreadsheetId?: string;
  tableRange?: string;
  updates?: UpdateValuesResponse;
  [k: string]: unknown;
}

export async function appendValues(
  headers: Record<string, string>,
  spreadsheetId: string,
  range: string,
  values: unknown[][],
  valueInputOption: ValueInputOption
): Promise<AppendValuesResponse> {
  // INSERT_ROWS, not OVERWRITE: appending must never land on top of data that
  // happens to sit below the table Sheets found.
  const url =
    `${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append` +
    `?valueInputOption=${valueInputOption}&insertDataOption=INSERT_ROWS`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
  });

  if (!response.ok) {
    await throwForGoogleApiError(response, `Append rows to ${range}`);
  }

  return (await response.json()) as AppendValuesResponse;
}

export interface ClearValuesResponse {
  spreadsheetId?: string;
  clearedRange?: string;
  [k: string]: unknown;
}

export async function clearValues(
  headers: Record<string, string>,
  spreadsheetId: string,
  range: string
): Promise<ClearValuesResponse> {
  const url = `${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`;
  const response = await fetch(url, { method: 'POST', headers, body: '{}' });

  if (!response.ok) {
    await throwForGoogleApiError(response, `Clear values ${range}`);
  }

  return (await response.json()) as ClearValuesResponse;
}
