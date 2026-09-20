/**
 * Read an .xlsx / .xlsm workbook into {@link OfficeWorkbook}.
 *
 * The parts that matter, and why each one is needed:
 *
 *   xl/workbook.xml          tab names, order, hidden state, the 1904 date base
 *   xl/_rels/workbook.xml.rels   which part holds which tab — NOT the filename
 *   xl/sharedStrings.xml     every string in the file, by index
 *   xl/styles.xml            which numbers are dates
 *   xl/worksheets/sheetN.xml the cells
 *
 * The relationship indirection is the one that catches people out: a tab's part
 * is named by `r:id`, and `sheet1.xml` is NOT reliably the first tab. Excel
 * renumbers parts on a tab delete and leaves the relationship correct, so a
 * reader that goes by filename silently serves the wrong tab's data under the
 * right tab's name.
 */
import { ZipArchive, ZipFormatError } from './zip.js';
import { attributes, innerXml, tags, textContent } from './xml.js';
import {
  MAX_PARSED_CELLS,
  OfficeWorkbookTooLargeError,
  trimTrailingEmpties,
  type OfficeCell,
  type OfficeSheet,
  type OfficeWorkbook,
} from './workbook.js';
import { renderNumber, type NumberFormats } from './number-format.js';

/** The two mime types Drive reports for an OOXML workbook this can read. */
export const XLSX_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
] as const;

/** `A1` / `BC27` -> a 0-based column index. Returns undefined for junk. */
function columnIndexOf(reference: string): number | undefined {
  const match = /^([A-Za-z]+)/.exec(reference);
  if (!match) return undefined;
  let column = 0;
  for (const ch of match[1].toUpperCase()) column = column * 26 + (ch.charCodeAt(0) - 64);
  return column - 1;
}

function decode(bytes: Buffer | undefined): string | undefined {
  return bytes === undefined ? undefined : bytes.toString('utf8');
}

/**
 * The shared string table.
 *
 * Every repeated string in a workbook is stored once here and referenced by
 * index from the cells, which is why a 40MB workbook's worksheet parts are
 * mostly integers.
 */
function readSharedStrings(archive: ZipArchive): string[] {
  const xml = decode(archive.read('xl/sharedStrings.xml'));
  if (xml === undefined) return [];
  const strings: string[] = [];
  for (const tag of tags(xml)) {
    if (tag.name !== 'si') continue;
    strings.push(textContent(innerXml(xml, tag)));
  }
  return strings;
}

function readNumberFormats(archive: ZipArchive): NumberFormats {
  const xml = decode(archive.read('xl/styles.xml'));
  const formats: NumberFormats = { styleFormatIds: [], customFormats: new Map() };
  if (xml === undefined) return formats;

  // `<xf>` appears in BOTH `<cellStyleXfs>` and `<cellXfs>`, and a cell's `s`
  // indexes the second. Tracking which block we are in is the whole reason this
  // is not a single `<xf>` sweep.
  let inCellXfs = false;
  for (const tag of tags(xml)) {
    if (tag.name === 'cellXfs') {
      inCellXfs = true;
      continue;
    }
    if (tag.name === 'cellStyleXfs') {
      inCellXfs = false;
      continue;
    }
    if (tag.name === 'numFmt') {
      const attrs = attributes(tag);
      const id = Number(attrs.numFmtId);
      if (Number.isFinite(id) && attrs.formatCode !== undefined) {
        formats.customFormats.set(id, attrs.formatCode);
      }
      continue;
    }
    if (tag.name === 'xf' && inCellXfs) {
      const id = Number(attributes(tag).numFmtId ?? 0);
      formats.styleFormatIds.push(Number.isFinite(id) ? id : 0);
    }
  }
  return formats;
}

interface SheetEntry {
  title: string;
  gid: number;
  hidden: boolean;
  relationshipId: string;
}

function readWorkbookPart(archive: ZipArchive): {
  sheets: SheetEntry[];
  date1904: boolean;
} {
  const xml = decode(archive.read('xl/workbook.xml'));
  if (xml === undefined) {
    throw new ZipFormatError(
      'This ZIP has no xl/workbook.xml, so it is not an Excel workbook. Parts found: ' +
        `${archive.names().slice(0, 8).join(', ') || '(none)'}`
    );
  }

  const sheets: SheetEntry[] = [];
  let date1904 = false;
  for (const tag of tags(xml)) {
    if (tag.name === 'workbookPr') {
      const attrs = attributes(tag);
      date1904 = attrs.date1904 === '1' || attrs.date1904 === 'true';
      continue;
    }
    if (tag.name !== 'sheet') continue;
    const attrs = attributes(tag);
    if (!attrs.name) continue;
    const gid = Number(attrs.sheetId);
    sheets.push({
      title: attrs.name,
      gid: Number.isFinite(gid) ? gid : sheets.length,
      // `hidden` and `veryHidden` are both hidden as far as a reader cares.
      hidden: attrs.state === 'hidden' || attrs.state === 'veryHidden',
      relationshipId: attrs.id ?? '',
    });
  }
  return { sheets, date1904 };
}

/** relationship id -> the part path a tab's cells live in. */
function readWorkbookRelationships(archive: ZipArchive): Map<string, string> {
  const xml = decode(archive.read('xl/_rels/workbook.xml.rels'));
  const targets = new Map<string, string>();
  if (xml === undefined) return targets;
  for (const tag of tags(xml)) {
    if (tag.name !== 'Relationship') continue;
    const attrs = attributes(tag);
    if (!attrs.Id || !attrs.Target) continue;
    // A target is relative to the workbook part's folder, or absolute from the
    // package root.
    const target = attrs.Target.startsWith('/')
      ? attrs.Target.slice(1)
      : `xl/${attrs.Target.replace(/^\.\//, '')}`;
    targets.set(attrs.Id, target);
  }
  return targets;
}

interface CellReader {
  sharedStrings: string[];
  formats: NumberFormats;
  date1904: boolean;
}

/** One `<c>` element's value, in the shape a ValueRange carries. */
function readCell(cellXml: string, type: string, styleIndex: number | undefined, reader: CellReader): {
  value: OfficeCell;
  formula?: string;
} {
  let formula: string | undefined;
  let rawValue: string | undefined;
  let inlineText: string | undefined;

  for (const tag of tags(cellXml)) {
    if (tag.name === 'f' && formula === undefined) {
      const text = textContent(innerXml(cellXml, tag));
      // A shared formula's slave cells carry `<f t="shared" si="3"/>` with no
      // text. Reporting an empty formula would be worse than reporting none.
      if (text) formula = `=${text}`;
    } else if (tag.name === 'v' && rawValue === undefined) {
      rawValue = textContent(innerXml(cellXml, tag));
    } else if (tag.name === 'is' && inlineText === undefined) {
      inlineText = textContent(innerXml(cellXml, tag));
    }
  }

  if (type === 'inlineStr') return { value: inlineText ?? '', formula };
  if (rawValue === undefined) return { value: inlineText ?? null, formula };

  switch (type) {
    case 's': {
      const index = Number(rawValue);
      return { value: reader.sharedStrings[index] ?? '', formula };
    }
    // `str` is a formula whose RESULT is text; `e` is an error literal such as
    // `#REF!`. Both are already the string they should render as.
    case 'str':
    case 'e':
      return { value: rawValue, formula };
    case 'b':
      return { value: rawValue === '1' || rawValue.toLowerCase() === 'true', formula };
    // ECMA-376 strict writes dates as ISO text rather than as serials.
    case 'd':
      return { value: rawValue, formula };
    default: {
      const numeric = Number(rawValue);
      if (!Number.isFinite(numeric)) return { value: rawValue, formula };
      return { value: renderNumber(numeric, reader.formats, styleIndex, reader.date1904), formula };
    }
  }
}

function readWorksheet(
  xml: string,
  entry: SheetEntry,
  index: number,
  reader: CellReader,
  budget: { cells: number }
): OfficeSheet {
  const rows: OfficeCell[][] = [];
  const formulas: (string | undefined)[][] = [];
  let anyFormula = false;

  let rowIndex = -1;
  let columnCursor = 0;
  for (const tag of tags(xml)) {
    if (tag.name === 'row') {
      const reference = Number(attributes(tag).r);
      // `r` is 1-based and OPTIONAL: a row without it is the one after the last.
      rowIndex = Number.isFinite(reference) && reference > 0 ? reference - 1 : rowIndex + 1;
      columnCursor = 0;
      continue;
    }
    if (tag.name !== 'c' || rowIndex < 0) continue;

    const attrs = attributes(tag);
    // `r` is optional on a cell too, in which case cells run left to right.
    const column = attrs.r !== undefined ? columnIndexOf(attrs.r) : columnCursor;
    if (column === undefined || column < 0) continue;
    columnCursor = column + 1;

    const styleIndex = attrs.s === undefined ? undefined : Number(attrs.s);
    const { value, formula } = readCell(innerXml(xml, tag), attrs.t ?? 'n', styleIndex, reader);

    // An empty styled cell is written out in full and carries nothing. Skipping
    // it keeps a sheet with formatted-but-blank columns from claiming a width it
    // does not have.
    if (value === null && formula === undefined) continue;

    budget.cells -= 1;
    if (budget.cells < 0) {
      throw new OfficeWorkbookTooLargeError(
        `This workbook has more than ${MAX_PARSED_CELLS.toLocaleString('en-US')} non-empty ` +
          'cells, which is more than this server will parse in one call. Open it in Google ' +
          'Sheets and use File > Save as Google Sheets; the Sheets API reads a native ' +
          'spreadsheet a range at a time rather than whole.'
      );
    }

    while (rows.length <= rowIndex) {
      rows.push([]);
      formulas.push([]);
    }
    const row = rows[rowIndex];
    while (row.length < column) row.push(null);
    row[column] = value;
    if (formula !== undefined) {
      const formulaRow = formulas[rowIndex];
      while (formulaRow.length < column) formulaRow.push(undefined);
      formulaRow[column] = formula;
      anyFormula = true;
    }
  }

  return {
    title: entry.title,
    index,
    gid: entry.gid,
    hidden: entry.hidden,
    rows: trimTrailingEmpties(rows),
    formulas: anyFormula ? formulas : undefined,
  };
}

/** Parse a whole .xlsx into the model the tools read. */
export function parseXlsx(bytes: Uint8Array, options: { title: string; mimeType: string }): OfficeWorkbook {
  const archive = ZipArchive.open(bytes);
  const { sheets: entries, date1904 } = readWorkbookPart(archive);
  const relationships = readWorkbookRelationships(archive);
  const reader: CellReader = {
    sharedStrings: readSharedStrings(archive),
    formats: readNumberFormats(archive),
    date1904,
  };

  const budget = { cells: MAX_PARSED_CELLS };
  const sheets: OfficeSheet[] = [];
  for (const [index, entry] of entries.entries()) {
    const path = relationships.get(entry.relationshipId);
    const xml = path === undefined ? undefined : decode(archive.read(path));
    if (xml === undefined) {
      // A tab whose part is missing is not a reason to fail the whole read: the
      // other tabs are still the data the caller asked for, and an empty tab
      // reports as an empty tab.
      sheets.push({ title: entry.title, index, gid: entry.gid, hidden: entry.hidden, rows: [] });
      continue;
    }
    sheets.push(readWorksheet(xml, entry, index, reader, budget));
  }

  return { title: options.title, mimeType: options.mimeType, sheets };
}
