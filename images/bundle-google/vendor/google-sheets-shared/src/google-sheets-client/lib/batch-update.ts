import { throwForGoogleApiError } from './api-errors.js';
import { SHEETS_BASE_URL } from './get-spreadsheet.js';
import type { SheetProperties } from '../../types.js';

export interface BatchUpdateResponse {
  spreadsheetId?: string;
  replies?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

/**
 * `spreadsheets.batchUpdate`, with ONE request type reachable from a tool:
 * `addSheet`. The endpoint itself can delete sheets, rewrite protected ranges and
 * move a file's data around; nothing here builds those requests and no tool takes
 * a raw request object, so the write surface is exactly what tools/ exposes.
 */
export async function addSheet(
  headers: Record<string, string>,
  spreadsheetId: string,
  properties: { title: string; index?: number; rowCount?: number; columnCount?: number }
): Promise<SheetProperties> {
  const addSheetRequest: Record<string, unknown> = { title: properties.title };
  if (properties.index !== undefined) addSheetRequest.index = properties.index;
  if (properties.rowCount !== undefined || properties.columnCount !== undefined) {
    addSheetRequest.gridProperties = {
      ...(properties.rowCount !== undefined ? { rowCount: properties.rowCount } : {}),
      ...(properties.columnCount !== undefined ? { columnCount: properties.columnCount } : {}),
    };
  }

  const response = await fetch(
    `${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ requests: [{ addSheet: { properties: addSheetRequest } }] }),
    }
  );

  if (!response.ok) {
    await throwForGoogleApiError(response, `Add sheet "${properties.title}"`);
  }

  const body = (await response.json()) as BatchUpdateResponse;
  const reply = body.replies?.[0] as { addSheet?: { properties?: SheetProperties } } | undefined;
  return reply?.addSheet?.properties ?? { title: properties.title };
}
