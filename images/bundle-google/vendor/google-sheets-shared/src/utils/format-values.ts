import { columnLetter, rangeOrigin } from './a1.js';
import type { ValueRange } from '../types.js';

/**
 * How much of a range one tool call may return.
 *
 * A financial model is tens of thousands of cells and a caller asking for a whole
 * tab does not know that. Returning all of it burns a context window on data
 * nobody asked for; returning a silent prefix is worse. So: a cap, and a line
 * that says what was left out and how to ask for the rest.
 */
export const MAX_CELLS = 5000;
export const MAX_CHARS = 60_000;

export interface RenderedValues {
  text: string;
  rows: number;
  truncated: boolean;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Render a ValueRange as a table addressed the way the spreadsheet is: real A1
 * column letters across the top, real row numbers down the side.
 *
 * That addressing is the point. A caller that reads a block and then wants to
 * write one cell of it needs the cell's A1 address, and a 1..n table forces it to
 * do offset arithmetic against the range it asked for — which is exactly the
 * arithmetic that writes to the wrong row.
 */
export function renderValueRange(valueRange: ValueRange): RenderedValues {
  const range = valueRange.range ?? '';
  const origin = rangeOrigin(range);
  const rows = valueRange.values ?? [];

  if (rows.length === 0) {
    return { text: '_(no values in this range)_', rows: 0, truncated: false };
  }

  // Sheets omits trailing empty cells, so rows are ragged: the widest one decides
  // the table, and every short row is padded rather than indexed past its end.
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);

  const lines: string[] = [];
  const header = ['', ...Array.from({ length: width }, (_, i) => columnLetter(origin.column + i))];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);

  let cells = 0;
  let chars = 0;
  let emitted = 0;
  let truncated = false;

  for (const [index, row] of rows.entries()) {
    if (cells + width > MAX_CELLS || chars > MAX_CHARS) {
      truncated = true;
      break;
    }
    const label = String(origin.row + index + 1);
    const rendered = Array.from({ length: width }, (_, i) =>
      // A literal pipe would break the table this is rendered into.
      cellText(row[i]).split('|').join('\\|')
    );
    const line = `| ${[label, ...rendered].join(' | ')} |`;
    lines.push(line);
    cells += width;
    chars += line.length;
    emitted += 1;
  }

  if (truncated) {
    lines.push('');
    lines.push(
      `_Truncated: showing ${emitted} of ${rows.length} rows (cap: ${MAX_CELLS} cells). ` +
        'Ask for a narrower A1 range to see the rest._'
    );
  }

  return { text: lines.join('\n'), rows: emitted, truncated };
}
