import { columnLetter, rangeOrigin } from './a1.js';
import type { ValueRange } from '../types.js';

export interface CellHit {
  /** The A1 address of the cell, tab included: `'Q1 2026'!C14`. */
  address: string;
  /** The cell's rendered text. */
  value: string;
}

export interface FindOptions {
  matchCase?: boolean;
  /** Whole-cell equality rather than substring. */
  exact?: boolean;
  maxResults: number;
}

/**
 * Scan already-fetched ranges for a query string.
 *
 * Client-side, because the Sheets API has no search: the only way to find a
 * label in a model is to read the cells and look. That is why find_in_spreadsheet
 * fetches whole tabs and why it caps what it will scan — the cost is real and
 * belongs where a caller can see it, not hidden in a "search" that quietly reads
 * a megabyte.
 */
export function findCells(
  valueRanges: readonly ValueRange[],
  query: string,
  options: FindOptions
): { hits: CellHit[]; truncated: boolean } {
  const needle = options.matchCase ? query : query.toLowerCase();
  const hits: CellHit[] = [];

  for (const valueRange of valueRanges) {
    const range = valueRange.range ?? '';
    // `'Tab'!A1:Z999` -> `'Tab'`, kept quoted exactly as the API returned it.
    const tab = range.includes('!') ? range.slice(0, range.lastIndexOf('!')) : '';
    const origin = rangeOrigin(range);

    for (const [rowIndex, row] of (valueRange.values ?? []).entries()) {
      for (const [columnIndex, raw] of row.entries()) {
        if (raw === null || raw === undefined) continue;
        const value = String(raw);
        const haystack = options.matchCase ? value : value.toLowerCase();
        const found = options.exact ? haystack === needle : haystack.includes(needle);
        if (!found) continue;

        const address =
          `${columnLetter(origin.column + columnIndex)}${origin.row + rowIndex + 1}`;
        hits.push({ address: tab ? `${tab}!${address}` : address, value });
        if (hits.length >= options.maxResults) {
          return { hits, truncated: true };
        }
      }
    }
  }

  return { hits, truncated: false };
}
