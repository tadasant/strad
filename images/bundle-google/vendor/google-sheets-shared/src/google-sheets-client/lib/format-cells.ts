import { throwForGoogleApiError } from './api-errors.js';
import { SHEETS_BASE_URL, getSpreadsheet } from './get-spreadsheet.js';
import type { Spreadsheet, GridRange } from '../../types.js';
import { isCellRange, parseA1Range, splitA1, sheetRange } from '../../utils/a1.js';

/** `#RRGGBB` or `#RGB`. */
export type HexColor = string;

export const NUMBER_FORMAT_TYPES = [
  'TEXT',
  'NUMBER',
  'PERCENT',
  'CURRENCY',
  'DATE',
  'TIME',
  'DATE_TIME',
  'SCIENTIFIC',
] as const;
export const HORIZONTAL_ALIGNMENTS = ['LEFT', 'CENTER', 'RIGHT'] as const;
export const VERTICAL_ALIGNMENTS = ['TOP', 'MIDDLE', 'BOTTOM'] as const;
export const WRAP_STRATEGIES = ['OVERFLOW_CELL', 'CLIP', 'WRAP'] as const;
export const BORDER_STYLES = [
  'SOLID',
  'SOLID_MEDIUM',
  'SOLID_THICK',
  'DASHED',
  'DOTTED',
  'DOUBLE',
  'NONE',
] as const;
export const BORDER_SIDES = [
  'top',
  'bottom',
  'left',
  'right',
  'inner_horizontal',
  'inner_vertical',
] as const;

export type BorderSide = (typeof BORDER_SIDES)[number];

export interface BorderSpec {
  style: (typeof BORDER_STYLES)[number];
  /** Default black. Ignored for `NONE`. */
  color?: HexColor;
}

/**
 * The formatting one entry sets. Every key is optional and only the keys given
 * are written: the `fields` mask names exactly them, so a cell's other
 * formatting — a colour set by hand, a format from an earlier call — stays.
 */
export interface CellFormat {
  background_color?: HexColor;
  text_color?: HexColor;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  font_size?: number;
  font_family?: string;
  number_format?: { type: (typeof NUMBER_FORMAT_TYPES)[number]; pattern?: string };
  horizontal_alignment?: (typeof HORIZONTAL_ALIGNMENTS)[number];
  vertical_alignment?: (typeof VERTICAL_ALIGNMENTS)[number];
  wrap_strategy?: (typeof WRAP_STRATEGIES)[number];
  /**
   * `outer` sets top, bottom, left and right; `inner` sets both inner sides. A
   * side named on its own wins over the shorthand that also covers it.
   */
  borders?: Partial<Record<BorderSide | 'outer' | 'inner', BorderSpec>>;
}

export interface FormatEntry {
  /** A1, naming its tab unless `defaultSheetId` is given: `'Offer A'!B2:D20`. */
  range: string;
  format: CellFormat;
}

/** What one entry turned into: the range it hit, and the fields it set. */
export interface AppliedFormat {
  range: string;
  fields: string[];
}

export interface FormatCellsResult {
  spreadsheetId: string;
  applied: AppliedFormat[];
  requestCount: number;
}

/** Only the tab identities. The default metadata read carries named ranges too. */
const TAB_FIELDS = 'sheets(properties(sheetId,title))';

/**
 * `spreadsheets.batchUpdate` with `repeatCell` and `updateBorders`, and nothing
 * else. The endpoint can also delete tabs and rows; no tool reaches that,
 * because what goes in `requests` is built here from a closed vocabulary and
 * never taken from a caller.
 *
 * Every entry goes in ONE call, so a whole sheet is styled together or not at
 * all: Google applies a batchUpdate atomically, and one bad request (a font size
 * it refuses, say) fails the lot rather than leaving half a sheet styled.
 *
 * The tab metadata read comes first and is what an Office file fails on, so
 * an uploaded .xlsx is refused before anything is sent.
 */
export async function formatCells(
  headers: Record<string, string>,
  spreadsheetId: string,
  entries: FormatEntry[],
  defaultSheetId?: number
): Promise<FormatCellsResult> {
  const spreadsheet = await getSpreadsheet(headers, spreadsheetId, TAB_FIELDS);
  const { requests, applied } = buildFormatRequests(spreadsheet, entries, defaultSheetId);

  const response = await fetch(
    `${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    { method: 'POST', headers, body: JSON.stringify({ requests }) }
  );
  if (!response.ok) {
    await throwForGoogleApiError(response, `Format cells in ${spreadsheetId}`);
  }

  return { spreadsheetId, applied, requestCount: requests.length };
}

/**
 * The `requests` array for {@link formatCells}, from a spreadsheet's tab list.
 * Pure, so the whole translation — A1 to grid indexes, a format to a fields
 * mask — is testable without a wire.
 */
export function buildFormatRequests(
  spreadsheet: Pick<Spreadsheet, 'sheets'>,
  entries: FormatEntry[],
  defaultSheetId?: number
): { requests: Array<Record<string, unknown>>; applied: AppliedFormat[] } {
  const tabs = (spreadsheet.sheets ?? [])
    .map((sheet) => sheet.properties)
    .filter((p): p is { sheetId: number; title: string } =>
      typeof p?.sheetId === 'number' && typeof p?.title === 'string'
    );
  const known = () => tabs.map((t) => `"${t.title}" (gid ${t.sheetId})`).join(', ') || '(none)';
  // Sheets matches a tab title ignoring case, and refuses two titles that differ
  // only by it, so an exact match first and then a case-blind one is unambiguous.
  const tabNamed = (title: string) =>
    tabs.find((t) => t.title === title) ??
    tabs.find((t) => t.title.toLowerCase() === title.toLowerCase());
  const isKnownTab = (title: string) => tabNamed(title) !== undefined;

  const requests: Array<Record<string, unknown>> = [];
  const applied: AppliedFormat[] = [];

  entries.forEach((entry, i) => {
    const where = `formats[${i}] ("${entry.range}")`;
    const trimmed = entry.range.trim();
    // A quoted title must be followed by `!` or nothing: `'Offer A'B2:D20`
    // would otherwise lose its cells and style the whole tab.
    if (trimmed.startsWith("'") && !/^'(?:[^']|'')*'(!|$)/.test(trimmed)) {
      throw new Error(`${where}: a quoted tab title must be followed by "!" and the cells.`);
    }
    const { cells } = splitA1(trimmed, isKnownTab);
    if (cells && !isCellRange(cells)) {
      throw new Error(
        `${where}: "${cells}" is not an A1 cell range. Write it like B2:D20, A:C or 3:3; ` +
          'named ranges are not accepted here.'
      );
    }
    const parsed = parseA1Range(trimmed, isKnownTab);

    let tab: { sheetId: number; title: string } | undefined;
    if (parsed.title !== undefined) {
      tab = tabNamed(parsed.title);
      if (!tab) {
        throw new Error(`${where}: no tab titled "${parsed.title}". This spreadsheet has: ${known()}`);
      }
    } else if (defaultSheetId !== undefined) {
      // Checked only here, where it is used: a stale `#gid=` on a pasted URL
      // does not sink a call whose every range names its own tab.
      tab = tabs.find((t) => t.sheetId === defaultSheetId);
      if (!tab) {
        throw new Error(`${where}: no tab with gid ${defaultSheetId}. This spreadsheet has: ${known()}`);
      }
    } else {
      // The write tools' rule: a range with no tab lands on the FIRST tab, which
      // is rarely the one a caller who read some other gid meant to style.
      throw new Error(
        `${where} does not name a tab. Name it ("'Offer A'!B2:D20") or pass sheet_gid.`
      );
    }

    const range = toGridRange(tab!.sheetId, parsed);
    const { cell, fields } = cellFormat(entry.format, where);
    const borders = updateBorders(range, entry.format.borders, where);

    if (fields.length === 0 && !borders) {
      throw new Error(`${where} sets no formatting. Give it at least one property.`);
    }
    if (fields.length > 0) {
      requests.push({
        repeatCell: { range, cell: { userEnteredFormat: cell }, fields: fields.join(',') },
      });
    }
    if (borders) requests.push({ updateBorders: borders.request });

    applied.push({
      range: sheetRange(tab!.title, cells || undefined),
      fields: [...fields.map((f) => f.replace(/^userEnteredFormat\./, '')), ...(borders?.sides ?? [])],
    });
  });

  return { requests, applied };
}

/**
 * A1 to a `GridRange`: 0-based, end-EXCLUSIVE, and an open axis left unbounded
 * by omitting its end, which is how the API spells `A:C` or a whole tab.
 */
function toGridRange(sheetId: number, parsed: ReturnType<typeof parseA1Range>): GridRange {
  const range: GridRange = { sheetId };
  const { start, end } = parsed;
  if (end.row !== undefined) {
    range.startRowIndex = start.row;
    range.endRowIndex = end.row + 1;
  } else if (start.row > 0) {
    range.startRowIndex = start.row;
  }
  if (end.column !== undefined) {
    range.startColumnIndex = start.column;
    range.endColumnIndex = end.column + 1;
  } else if (start.column > 0) {
    range.startColumnIndex = start.column;
  }
  return range;
}

/** `#1a73e8` or `#fff` to the API's 0..1 floats. */
export function parseHexColor(hex: string): { red: number; green: number; blue: number } {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`"${hex}" is not a colour. Use hex: "#1a73e8" or "#fff".`);
  const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const channel = (at: number) => Math.round((parseInt(digits.slice(at, at + 2), 16) / 255) * 1e4) / 1e4;
  return { red: channel(0), green: channel(2), blue: channel(4) };
}

/**
 * A colour is written to BOTH the plain field and its `…Style` twin. The API
 * reads the `Style` one first when a cell has it — a theme colour picked in the
 * UI sets only that — so writing the plain field alone would be accepted and
 * change nothing anyone can see.
 */
function colorPair(hex: string) {
  const rgb = parseHexColor(hex);
  return { plain: rgb, style: { rgbColor: rgb } };
}

function cellFormat(
  format: CellFormat,
  where: string
): { cell: Record<string, unknown>; fields: string[] } {
  const cell: Record<string, unknown> = {};
  const text: Record<string, unknown> = {};
  const fields: string[] = [];
  const set = (target: Record<string, unknown>, key: string, value: unknown, path: string) => {
    target[key] = value;
    fields.push(path);
  };

  try {
    if (format.background_color !== undefined) {
      const c = colorPair(format.background_color);
      set(cell, 'backgroundColor', c.plain, 'userEnteredFormat.backgroundColor');
      set(cell, 'backgroundColorStyle', c.style, 'userEnteredFormat.backgroundColorStyle');
    }
    if (format.text_color !== undefined) {
      const c = colorPair(format.text_color);
      set(text, 'foregroundColor', c.plain, 'userEnteredFormat.textFormat.foregroundColor');
      set(text, 'foregroundColorStyle', c.style, 'userEnteredFormat.textFormat.foregroundColorStyle');
    }
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`);
  }
  if (format.bold !== undefined) set(text, 'bold', format.bold, 'userEnteredFormat.textFormat.bold');
  if (format.italic !== undefined) set(text, 'italic', format.italic, 'userEnteredFormat.textFormat.italic');
  if (format.underline !== undefined) {
    set(text, 'underline', format.underline, 'userEnteredFormat.textFormat.underline');
  }
  if (format.strikethrough !== undefined) {
    set(text, 'strikethrough', format.strikethrough, 'userEnteredFormat.textFormat.strikethrough');
  }
  if (format.font_size !== undefined) {
    set(text, 'fontSize', format.font_size, 'userEnteredFormat.textFormat.fontSize');
  }
  if (format.font_family !== undefined) {
    set(text, 'fontFamily', format.font_family, 'userEnteredFormat.textFormat.fontFamily');
  }
  if (Object.keys(text).length > 0) cell.textFormat = text;

  if (format.number_format !== undefined) {
    const { type, pattern } = format.number_format;
    set(cell, 'numberFormat', pattern ? { type, pattern } : { type }, 'userEnteredFormat.numberFormat');
  }
  if (format.horizontal_alignment !== undefined) {
    set(cell, 'horizontalAlignment', format.horizontal_alignment, 'userEnteredFormat.horizontalAlignment');
  }
  if (format.vertical_alignment !== undefined) {
    set(cell, 'verticalAlignment', format.vertical_alignment, 'userEnteredFormat.verticalAlignment');
  }
  if (format.wrap_strategy !== undefined) {
    set(cell, 'wrapStrategy', format.wrap_strategy, 'userEnteredFormat.wrapStrategy');
  }
  return { cell, fields };
}

const API_SIDE: Record<BorderSide, string> = {
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right',
  inner_horizontal: 'innerHorizontal',
  inner_vertical: 'innerVertical',
};

/**
 * An `updateBorders` request, or nothing. It touches only the sides it names —
 * the API leaves an omitted side as it was — so `NONE` is how a border comes off.
 */
function updateBorders(
  range: GridRange,
  borders: CellFormat['borders'],
  where: string
): { request: Record<string, unknown>; sides: string[] } | undefined {
  if (!borders) return undefined;
  const resolved: Partial<Record<BorderSide, BorderSpec>> = {};
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const spec = borders[side] ?? borders.outer;
    if (spec) resolved[side] = spec;
  }
  for (const side of ['inner_horizontal', 'inner_vertical'] as const) {
    const spec = borders[side] ?? borders.inner;
    if (spec) resolved[side] = spec;
  }
  const sides = Object.keys(resolved) as BorderSide[];
  if (sides.length === 0) return undefined;

  const request: Record<string, unknown> = { range };
  for (const side of sides) {
    const spec = resolved[side]!;
    if (spec.style === 'NONE') {
      request[API_SIDE[side]] = { style: 'NONE' };
      continue;
    }
    let color: ReturnType<typeof colorPair>;
    try {
      color = colorPair(spec.color ?? '#000000');
    } catch (error) {
      throw new Error(`${where}: borders.${side}: ${(error as Error).message}`);
    }
    request[API_SIDE[side]] = { style: spec.style, color: color.plain, colorStyle: color.style };
  }
  return { request, sides: sides.map((side) => `borders.${side}`) };
}
