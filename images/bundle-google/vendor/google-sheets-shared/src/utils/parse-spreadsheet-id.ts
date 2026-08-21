/**
 * Accepts either a raw spreadsheet id or a full Sheets URL, such as:
 *   https://docs.google.com/spreadsheets/d/{ID}/edit#gid=0
 *   https://docs.google.com/spreadsheets/d/{ID}
 *   https://docs.google.com/spreadsheets/u/0/d/{ID}/edit
 *   https://drive.google.com/open?id={ID}
 * and returns the bare id.
 *
 * A native spreadsheet id is 44 characters. This does NOT enforce that: an id of
 * any other length is passed through to Google, whose answer ("this operation is
 * not supported for this document") is more informative than a guess here would
 * be, and is turned into a recovery hint in api-errors.ts.
 */
export function parseSpreadsheetId(input: string): string {
  if (!input || typeof input !== 'string') {
    throw new Error('Spreadsheet ID or URL is required');
  }

  const trimmed = input.trim();

  const pathMatch = trimmed.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
  if (pathMatch) {
    return pathMatch[1];
  }

  const queryMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (queryMatch) {
    return queryMatch[1];
  }

  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) {
    return trimmed;
  }

  throw new Error(
    `Could not parse a Google Sheets spreadsheet ID from "${input}". ` +
      'Expected a URL like https://docs.google.com/spreadsheets/d/{ID}/edit or a raw ID.'
  );
}

/**
 * The `gid` of a Sheets URL, when it carries one.
 *
 * A URL a human copies out of their browser points at ONE TAB — `#gid=1680010701`
 * — and a caller who pastes that URL means that tab. The gid is a sheetId, not a
 * title, so resolving it to an A1 range needs the spreadsheet's metadata; the
 * tools that accept a gid do that lookup.
 */
export function parseSheetGid(input: string): number | undefined {
  if (typeof input !== 'string') return undefined;
  const match = input.match(/[#&?]gid=(\d+)/);
  return match ? Number(match[1]) : undefined;
}
