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
import {
  MAX_PARSED_CELLS,
  OfficeWorkbookTooLargeError,
  trimTrailingEmpties,
  type OfficeCell,
  type OfficeWorkbook,
} from './workbook.js';

/** The delimited mime types Drive reports. */
export const DELIMITED_MIME_TYPES = ['text/csv', 'text/tab-separated-values'] as const;

export function delimiterFor(mimeType: string): string {
  return mimeType === 'text/tab-separated-values' ? '\t' : ',';
}

export function parseDelimited(
  text: string,
  delimiter: string,
  /**
   * The same cell budget the .xlsx path spends, and for the same reason.
   *
   * A 19MB CSV of one-character fields is ten million cells and several hundred
   * megabytes of live arrays, held for the cache's lifetime — comfortably inside
   * the 20MB download cap and comfortably past what this container can hold. A
   * caller with no budget to spend gets the whole file, which is what the unit
   * tests want.
   */
  budget: { cells: number } = { cells: Number.POSITIVE_INFINITY }
): OfficeCell[][] {
  const rows: OfficeCell[][] = [];
  let row: OfficeCell[] = [];
  let field = '';
  let quoted = false;

  const spend = () => {
    budget.cells -= 1;
    if (budget.cells < 0) {
      throw new OfficeWorkbookTooLargeError(
        `This file has more than ${MAX_PARSED_CELLS.toLocaleString('en-US')} cells, which is ` +
          'more than this server will parse in one call. Import it into Google Sheets; the ' +
          'Sheets API then reads it a range at a time rather than whole.'
      );
    }
  };

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
      spend();
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      spend();
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
    spend();
    row.push(field);
    rows.push(row);
  }

  return trimTrailingEmpties(rows);
}

export function delimitedWorkbook(
  bytes: Uint8Array,
  options: { title: string; mimeType: string; budget?: { cells: number } }
): OfficeWorkbook {
  const text = decodeText(bytes, options.title);
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
        rows: parseDelimited(text, delimiterFor(options.mimeType), options.budget),
      },
    ],
  };
}

/**
 * The file's text, refusing an encoding that would decode to nonsense.
 *
 * UTF-8 is what Sheets, Drive and every modern exporter write, and it is the
 * only encoding this reads. A UTF-16 file decoded as UTF-8 is not an error —
 * it is a workbook full of `\u0000`-separated characters, which the caller
 * would take at face value — so it is refused by its byte-order mark rather
 * than served.
 */
function decodeText(bytes: Uint8Array, title: string): string {
  const utf16 =
    (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  if (utf16) {
    throw new Error(
      `"${title}" is UTF-16 encoded, which this server does not read — it would decode to ` +
        'nonsense rather than to an error. Re-save it as UTF-8, or import it into Google ' +
        'Sheets, which the Sheets API can then read directly.'
    );
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}
