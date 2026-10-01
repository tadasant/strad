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
  // A range with no `!` is a whole tab, and a tab title is not a cell address:
  // `Ledger` would otherwise parse as column 3,231,000. Only something shaped
  // like an actual A1 reference is read as one; everything else is A1.
  if (!/^\$?[A-Za-z]{0,3}\$?\d*(:|$)/.test(cells)) return { row: 0, column: 0 };
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

/** A1 range split into the tab it names and the cell window it selects. */
export interface ParsedA1Range {
  /** The tab, unquoted. Absent when the range names none. */
  title?: string;
  /** 0-based first row and column. A range naming no cells starts at A1. */
  start: { row: number; column: number };
  /**
   * 0-based last row and column, INCLUSIVE. Either may be absent, which is what
   * an open range means: `A:D` is every row of four columns, `2:10` is nine
   * whole rows, and a bare tab is both.
   */
  end: { row?: number; column?: number };
}

/** Undo {@link quoteSheetTitle}: strip the quotes and halve the doubled ones. */
export function unquoteSheetTitle(title: string): string {
  if (!title.startsWith("'")) return title;
  return title.slice(1, -1).split("''").join("'");
}

/**
 * Split an A1 range at the `!` that separates its tab from its cells.
 *
 * Quote-aware, because a tab title may itself contain a `!` and then it is
 * quoted — `'Done!'!A1:B2`. Splitting at the first `!` would take the tab to be
 * `'Done`, and splitting at the last one works for that example and breaks on
 * `'A!B'` with no cell range at all.
 */
export function splitA1(range: string, isKnownTab?: (title: string) => boolean): { title?: string; cells: string } {
  if (range.startsWith("'")) {
    let i = 1;
    for (;;) {
      const quote = range.indexOf("'", i);
      if (quote === -1) return { title: range, cells: '' };
      if (range[quote + 1] === "'") {
        i = quote + 2;
        continue;
      }
      const title = range.slice(0, quote + 1);
      const rest = range.slice(quote + 1);
      return { title, cells: rest.startsWith('!') ? rest.slice(1) : '' };
    }
  }
  const bang = range.indexOf('!');
  if (bang === -1) {
    // No `!` at all: either a bare tab name or a bare cell range, and mostly
    // only the shape tells them apart. `Ledger` is a tab; `A1:D50` is not.
    //
    // `Q1`, `H1` and `FY26` are BOTH, and a financial workbook is full of tabs
    // named exactly that. Sheets resolves the ambiguity in favour of the sheet
    // when one of that name exists, and here the workbook is in hand, so the
    // same question can simply be asked rather than guessed at.
    if (!CELL_RANGE.test(range)) return { title: range, cells: '' };
    return isKnownTab?.(range) ? { title: range, cells: '' } : { cells: range };
  }
  return { title: range.slice(0, bang), cells: range.slice(bang + 1) };
}

const CELL_RANGE = /^\$?[A-Za-z]{0,3}\$?\d*(?::\$?[A-Za-z]{0,3}\$?\d*)?$/;

/**
 * Whether a cell range (the part after the `!`) is A1 that {@link parseA1Range}
 * reads as written. Anything else — a named range, a typo — parses as A1 there,
 * which a read can live with and a write that styles cells cannot.
 */
export function isCellRange(cells: string): boolean {
  return CELL_RANGE.test(cells) && !/(^|[^\d])0+(:|$)/.test(cells);
}

/** One end of a cell range: column letters, row digits, either may be absent. */
function parseCorner(cell: string): { row?: number; column?: number } {
  const match = /^\$?([A-Za-z]*)\$?(\d*)$/.exec(cell);
  if (!match) return {};
  const [, letters, digits] = match;
  let column: number | undefined;
  if (letters) {
    column = 0;
    for (const ch of letters.toUpperCase()) column = column * 26 + (ch.charCodeAt(0) - 64);
    column -= 1;
  }
  return { row: digits ? Number(digits) - 1 : undefined, column };
}

/**
 * Parse an A1 range the way the Sheets values API reads one.
 *
 * Needed only on the Office path: a native spreadsheet's ranges are resolved by
 * Google, and a workbook this server parsed itself has to be sliced here.
 */
export function parseA1Range(
  range: string,
  /**
   * Whether the workbook has a tab of this name. Optional: a caller that cannot
   * answer gets the shape-only reading, which is what the Sheets API falls back
   * to when no sheet matches.
   */
  isKnownTab?: (title: string) => boolean
): ParsedA1Range {
  const { title, cells } = splitA1(range.trim(), isKnownTab);
  const parsed: ParsedA1Range = {
    title: title === undefined ? undefined : unquoteSheetTitle(title),
    start: { row: 0, column: 0 },
    end: {},
  };
  if (!cells) return parsed;

  const [left, right] = cells.includes(':') ? cells.split(':', 2) : [cells, cells];
  const from = parseCorner(left);
  const to = parseCorner(right);

  // A range may be written either way round — `D10:A1` selects the same block as
  // `A1:D10`, and Sheets normalises it. Each axis normalises independently.
  const rows = [from.row, to.row].filter((n): n is number => n !== undefined).sort((a, b) => a - b);
  const columns = [from.column, to.column]
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b);

  parsed.start = { row: rows[0] ?? 0, column: columns[0] ?? 0 };
  // An axis is bounded only when BOTH corners named it. `A1:D` bounds the
  // columns and leaves the rows open, which is the whole point of the form.
  parsed.end = {
    row: rows.length === 2 ? rows[1] : undefined,
    column: columns.length === 2 ? columns[1] : undefined,
  };
  return parsed;
}

/** `0, 0` -> `A1`. The inverse of {@link parseCorner} for a complete corner. */
export function cellAddress(row: number, column: number): string {
  return `${columnLetter(column)}${row + 1}`;
}
