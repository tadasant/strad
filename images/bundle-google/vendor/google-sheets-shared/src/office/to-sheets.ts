/**
 * A parsed Office workbook, dressed as the Sheets API resources.
 *
 * This is the whole reason the Office path costs four small modules and not a
 * second server: everything downstream — `resolveRange`, `sheetTitleForGid`,
 * `findCells`, `renderValueRange`, and all four read tools — already speaks
 * `Spreadsheet` and `ValueRange`. Adapting here means the tools do not learn
 * that Office files exist, beyond printing the provenance note.
 *
 * SLICING IS OURS NOW. On a native spreadsheet Google resolves `'Q1 2026'!B4:D9`
 * and returns the block; on a workbook this process parsed, that resolution has
 * to happen here, and it has to agree with the API's conventions — trailing
 * empties trimmed, out-of-bounds windows returning no values rather than an
 * error, the echoed `range` telling the renderer where the block starts.
 */
import { cellAddress, parseA1Range, quoteSheetTitle } from '../utils/a1.js';
import type {
  BatchGetValuesResponse,
  OfficeSource,
  Spreadsheet,
  ValueRange,
  ValueRenderOption,
} from '../types.js';
import type { OfficeCell, OfficeSheet, OfficeWorkbook } from './workbook.js';

/**
 * The line every Office-backed tool result carries.
 *
 * A caller has to be able to tell the two paths apart, because they are not the
 * same read: these values are what the file was last SAVED with, formulas are
 * their cached results, and no write tool can touch the file at all. Silence
 * here would be the dishonest part of an otherwise honest feature.
 */
export function officeSource(workbook: OfficeWorkbook): OfficeSource {
  return {
    mimeType: workbook.mimeType,
    note:
      'Read from an Office-format file in Drive, not through the Google Sheets API — ' +
      'strad downloaded the file and parsed it. Values are as the file was last saved; ' +
      'formula cells show their stored result, currency and percentages come back as raw ' +
      'numbers, and no write tool can edit this file. Convert it in Sheets ' +
      '(File > Save as Google Sheets) for a live, writable spreadsheet.',
  };
}

/** The tab a range names, or the first tab when it names none. */
export function sheetFor(workbook: OfficeWorkbook, title: string | undefined): OfficeSheet {
  if (title === undefined) {
    const first = workbook.sheets[0];
    if (!first) throw new Error(`"${workbook.title}" has no tabs to read.`);
    return first;
  }
  const match = workbook.sheets.find((sheet) => sheet.title === title);
  if (match) return match;
  // Case-insensitive second pass, because Sheets itself resolves a tab name
  // case-insensitively and a caller retyping a title should not be punished.
  const lowered = title.toLowerCase();
  const insensitive = workbook.sheets.find((sheet) => sheet.title.toLowerCase() === lowered);
  if (insensitive) return insensitive;
  throw new Error(
    `No tab called "${title}" in "${workbook.title}". It has: ` +
      `${workbook.sheets.map((sheet) => sheet.title).join(', ') || '(no tabs)'}`
  );
}

/**
 * How far the sheet's data reaches — over the VALUE grid and the FORMULA grid.
 *
 * Both, because a formula whose cached result is absent or empty occupies a cell
 * that the value grid does not know about. Measuring only values would leave
 * `=A1` in an otherwise-blank row invisible to a `FORMULA` read, and would
 * report a `gridProperties` a row short of the truth.
 */
function sheetExtent(sheet: OfficeSheet): { rows: number; columns: number } {
  const grids = [sheet.rows, sheet.formulas ?? []];
  return {
    rows: Math.max(...grids.map((grid) => grid.length)),
    columns: Math.max(
      0,
      ...grids.map((grid) => grid.reduce((max, row) => Math.max(max, row.length), 0))
    ),
  };
}

/** The `Spreadsheet` resource `get_spreadsheet` renders, from a workbook. */
export function workbookToSpreadsheet(
  spreadsheetId: string,
  workbook: OfficeWorkbook
): Spreadsheet {
  return {
    spreadsheetId,
    // Drive opens an uploaded workbook at the same /spreadsheets/d/<id>/edit URL
    // a native file uses, so this link is the one a human wants.
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    properties: { title: workbook.title },
    sheets: workbook.sheets.map((sheet) => {
      const extent = sheetExtent(sheet);
      return {
        properties: {
          sheetId: sheet.gid,
          title: sheet.title,
          index: sheet.index,
          sheetType: 'GRID',
          hidden: sheet.hidden,
          // The extent of the DATA, not of the grid. An .xlsx records no grid
          // size the way a Sheets tab does, and "1000 x 26" invented to look
          // like one would be a number a caller could act on and be wrong about.
          gridProperties: { rowCount: extent.rows, columnCount: extent.columns },
        },
      };
    }),
    // An .xlsx does carry defined names, but they are formulas over tabs rather
    // than the grid ranges `namedRanges` models, so none are reported.
    namedRanges: [],
    officeSource: officeSource(workbook),
  };
}

/**
 * One cell, under the render option asked for.
 *
 * The three options mean here what they mean on a native spreadsheet, as far as
 * a stored workbook can carry them. `FORMULA` is the formula text where there is
 * one. `UNFORMATTED_VALUE` is the STORED NUMBER — the date serial rather than
 * the rendered date, which is exactly what the Sheets API returns under that
 * option. `FORMATTED_VALUE`, the default, is the rendered one; it is not the
 * full render the Sheets API would do (see the provenance note), but for dates
 * and durations, which are the values a raw number cannot express, it is.
 */
function renderCell(
  sheet: OfficeSheet,
  row: number,
  column: number,
  renderOption: ValueRenderOption | undefined
): OfficeCell {
  if (renderOption === 'FORMULA') {
    const formula = sheet.formulas?.[row]?.[column];
    if (formula !== undefined) return formula;
  }
  if (renderOption === 'UNFORMATTED_VALUE') {
    const raw = sheet.raw?.[row]?.[column];
    if (raw !== undefined) return raw;
  }
  return sheet.rows[row]?.[column] ?? null;
}

/** The `ValueRange` one A1 range yields, sliced out of a parsed workbook. */
export function workbookValueRange(
  workbook: OfficeWorkbook,
  range: string,
  options?: { valueRenderOption?: ValueRenderOption }
): ValueRange {
  const parsed = parseA1Range(range, (title) =>
    workbook.sheets.some((sheet) => sheet.title.toLowerCase() === title.toLowerCase())
  );
  const sheet = sheetFor(workbook, parsed.title);
  const extent = sheetExtent(sheet);

  const startRow = parsed.start.row;
  const startColumn = parsed.start.column;
  const endRow = Math.min(parsed.end.row ?? extent.rows - 1, extent.rows - 1);
  const endColumn = Math.min(parsed.end.column ?? extent.columns - 1, extent.columns - 1);

  const values: unknown[][] = [];
  for (let row = startRow; row <= endRow; row += 1) {
    const out: OfficeCell[] = [];
    for (let column = startColumn; column <= endColumn; column += 1) {
      out.push(renderCell(sheet, row, column, options?.valueRenderOption));
    }
    // The values API omits trailing empty cells in a row and trailing empty
    // rows in a range. Matching it is what keeps `renderValueRange`'s ragged-row
    // handling and its truncation counts honest.
    let width = out.length;
    while (width > 0 && (out[width - 1] === null || out[width - 1] === '')) width -= 1;
    values.push(out.slice(0, width));
  }
  while (values.length > 0 && values[values.length - 1].length === 0) values.pop();

  // The echoed range is what the renderer addresses its table with, so it must
  // name the block actually returned — a caller that reads `'Q1'!B4:D9` and then
  // writes to the address the table shows depends on this being the real origin.
  const empty = endRow < startRow || endColumn < startColumn;
  const bounded =
    `${quoteSheetTitle(sheet.title)}!${cellAddress(startRow, startColumn)}:` +
    // An out-of-bounds window has no data to clamp to, so it echoes the window
    // that was ASKED for rather than one clamped to nothing. Either way the
    // start cell is real, which is what the renderer addresses its table from.
    (empty
      ? cellAddress(parsed.end.row ?? startRow, parsed.end.column ?? startColumn)
      : cellAddress(endRow, endColumn));

  const valueRange: ValueRange = {
    range: bounded,
    majorDimension: 'ROWS',
    officeSource: officeSource(workbook),
  };
  if (values.length > 0) valueRange.values = values;
  return valueRange;
}

/** The `batchGet` response several ranges yield, in the order requested. */
export function workbookBatchValueRanges(
  spreadsheetId: string,
  workbook: OfficeWorkbook,
  ranges: string[],
  options?: { valueRenderOption?: ValueRenderOption }
): BatchGetValuesResponse {
  return {
    spreadsheetId,
    valueRanges: ranges.map((range) => workbookValueRange(workbook, range, options)),
    officeSource: officeSource(workbook),
  };
}

/**
 * The provenance line a tool appends, or nothing at all.
 *
 * Nothing at all is the common case: a native spreadsheet carries no
 * `officeSource`, and its output is exactly what it always was.
 */
export function officeNote(source: OfficeSource | undefined): string {
  return source ? `\n---\n\n_${source.note}_\n` : '';
}
