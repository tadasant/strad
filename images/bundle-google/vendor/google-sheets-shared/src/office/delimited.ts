/**
 * A .csv or .tsv uploaded to Drive, read as a one-tab workbook.
 *
 * Drive treats an uploaded delimited file exactly as it treats an uploaded
 * .xlsx — it opens in the Sheets UI, and the Sheets API refuses it — so it fails
 * in the same way and is worth fixing in the same place. The parse is RFC 4180:
 * quotes, doubled quotes inside quotes, and embedded newlines.
 *
 * Values stay STRINGS. A CSV has no types, and guessing them is how a ZIP code
 * becomes a number and a leading zero disappears.
 */
import { trimTrailingEmpties, type OfficeCell, type OfficeWorkbook } from './workbook.js';

/** The delimited mime types Drive reports. */
export const DELIMITED_MIME_TYPES = ['text/csv', 'text/tab-separated-values'] as const;

export function delimiterFor(mimeType: string): string {
  return mimeType === 'text/tab-separated-values' ? '\t' : ',';
}

export function parseDelimited(text: string, delimiter: string): OfficeCell[][] {
  const rows: OfficeCell[][] = [];
  let row: OfficeCell[] = [];
  let field = '';
  let quoted = false;

  // A byte-order mark survives an upload and would otherwise become part of the
  // first column heading, which then matches nothing a caller searches for.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  // A file not ending in a newline still has a last row; one that does must not
  // gain an empty one.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return trimTrailingEmpties(rows);
}

export function delimitedWorkbook(
  bytes: Uint8Array,
  options: { title: string; mimeType: string }
): OfficeWorkbook {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  return {
    title: options.title,
    mimeType: options.mimeType,
    sheets: [
      {
        // The tab has to be CALLED something, because every range in this server
        // is A1 notation and A1 notation names a tab. The file's own name is the
        // only title there is, and it is what `get_spreadsheet` reports.
        title: options.title,
        index: 0,
        gid: 0,
        hidden: false,
        rows: parseDelimited(text, delimiterFor(options.mimeType)),
      },
    ],
  };
}
