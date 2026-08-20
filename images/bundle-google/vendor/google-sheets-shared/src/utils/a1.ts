/**
 * A1 notation: the string form of a range, and the only address the values API
 * speaks.
 *
 * Sheets is unforgiving here in one specific way — a sheet TITLE goes inside the
 * range string, and a title with a space, a quote or an exclamation mark in it
 * breaks the parse unless it is quoted the way Sheets quotes it. `'Q1 2026'!A1:D`
 * works; `Q1 2026!A1:D` is a 400. Every range this server sends is built here.
 */

/** Quote a sheet title for A1 notation, the way the Sheets UI does. */
export function quoteSheetTitle(title: string): string {
  // Sheets accepts an unquoted title only when it is a bare word that cannot be
  // read as a cell reference. Quoting always is legal and never ambiguous, so
  // that is what this does — except that a single quote inside a title has to be
  // doubled, which is the one escape A1 notation has.
  return `'${title.split("'").join("''")}'`;
}

/**
 * Join a sheet title and an optional cell range into one A1 range.
 *
 * With no cell range this is the WHOLE sheet, which is what a caller naming only
 * a tab means.
 */
export function sheetRange(title: string, cells?: string): string {
  const quoted = quoteSheetTitle(title);
  return cells ? `${quoted}!${cells}` : quoted;
}

/** Column index (0-based) to its A1 letters: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Column index must be a non-negative integer, got ${index}`);
  }
  let n = index;
  let out = '';
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    if (n < 26) return out;
    n = Math.floor(n / 26) - 1;
  }
}

/**
 * The first cell of a range, as (row, column) 0-based offsets.
 *
 * The API echoes back the range it actually read (`'Sheet1'!B4:D9`), and a table
 * rendered without that offset labels its rows 1..n — which is wrong for every
 * range that does not start at A1, and wrong in the way that makes a caller write
 * to the wrong cell afterwards.
 */
export function rangeOrigin(range: string): { row: number; column: number } {
  const cells = range.includes('!') ? range.slice(range.lastIndexOf('!') + 1) : range;
  // Every part is optional, so this matches anything — including a whole-tab
  // range, which names no cell and correctly yields A1.
  const [, letters, digits] = cells.match(/^\$?([A-Za-z]*)\$?(\d*)/)!;
  let column = 0;
  if (letters) {
    for (const ch of letters.toUpperCase()) {
      column = column * 26 + (ch.charCodeAt(0) - 64);
    }
    column -= 1;
  }
  const row = digits ? Number(digits) - 1 : 0;
  return { row: Math.max(0, row), column: Math.max(0, column) };
}
