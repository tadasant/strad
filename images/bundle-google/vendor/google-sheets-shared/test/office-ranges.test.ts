/**
 * Slicing a parsed workbook the way the values API slices a real one.
 *
 * On a native spreadsheet Google resolves the A1 range; on an Office file this
 * process does, and the two have to agree — because the table a caller reads is
 * addressed from the range that comes back, and an origin off by one row is how
 * a later write lands on the wrong line.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { parseA1Range, unquoteSheetTitle } from "../src/utils/a1.js";
import { renderValueRange } from "../src/utils/format-values.js";
import { findCells } from "../src/utils/find-cells.js";
import { parseXlsx } from "../src/office/xlsx.js";
import {
  officeNote,
  workbookBatchValueRanges,
  workbookToSpreadsheet,
  workbookValueRange,
} from "../src/office/to-sheets.js";
import { DATE_SERIAL_AS_TEXT, XLSX_MIME, xlsxFixture } from "./fixtures/workbook.js";

const workbook = () => parseXlsx(xlsxFixture(), { title: "Master.xlsx", mimeType: XLSX_MIME });

test("an A1 range splits into the tab it names and the block it selects", () => {
  assert.deepEqual(parseA1Range("'Q1 2026'!B4:D9"), {
    title: "Q1 2026",
    start: { row: 3, column: 1 },
    end: { row: 8, column: 3 },
  });
  // A bare tab name is the whole tab: both axes open.
  assert.deepEqual(parseA1Range("'Q1 2026'"), {
    title: "Q1 2026",
    start: { row: 0, column: 0 },
    end: {},
  });
  // Whole columns and whole rows leave the other axis open.
  assert.deepEqual(parseA1Range("'S'!A:D").end, { row: undefined, column: 3 });
  assert.deepEqual(parseA1Range("'S'!2:10").end, { row: 9, column: undefined });
  // A range with no tab resolves against the first tab, as Sheets does.
  assert.equal(parseA1Range("A1:D50").title, undefined);
  // Written backwards, it still selects the same block.
  assert.deepEqual(parseA1Range("'S'!D10:A1"), {
    title: "S",
    start: { row: 0, column: 0 },
    end: { row: 9, column: 3 },
  });
  // A `!` inside a quoted title is part of the title, not the separator.
  assert.equal(parseA1Range("'Done!'!A1").title, "Done!");
  assert.equal(unquoteSheetTitle("'Tadas''s tab'"), "Tadas's tab");
});

test("a bounded range returns that block, addressed from its real origin", () => {
  const valueRange = workbookValueRange(workbook(), "'Q1 2026'!B2:C3");
  assert.equal(valueRange.range, "'Q1 2026'!B2:C3");
  assert.deepEqual(valueRange.values, [
    [12345.67, DATE_SERIAL_AS_TEXT],
    [12345.67, true],
  ]);
  // The renderer addresses its table from that echoed range: B and C, rows 2-3.
  const table = renderValueRange(valueRange).text;
  assert.match(table, /\|\s*\|\s*B\s*\|\s*C\s*\|/);
  assert.match(table, /\|\s*2\s*\|\s*12345\.67/);
});

test("a whole-tab read is clamped to the data, not to an invented grid", () => {
  const valueRange = workbookValueRange(workbook(), "'Summary'");
  assert.equal(valueRange.range, "'Summary'!A1:A2");
  assert.deepEqual(valueRange.values, [["Headline"], [42]]);
});

test("a range past the end of the data comes back empty, not as an error", () => {
  const valueRange = workbookValueRange(workbook(), "'Summary'!A50:C60");
  assert.equal(valueRange.values, undefined);
  assert.match(renderValueRange(valueRange).text, /no values in this range/);
});

test("FORMULA returns the formula text; the default returns its result", () => {
  const formula = workbookValueRange(workbook(), "'Q1 2026'!B3", {
    valueRenderOption: "FORMULA",
  });
  assert.deepEqual(formula.values, [["=SUM(B2:B2)"]]);
  assert.deepEqual(workbookValueRange(workbook(), "'Q1 2026'!B3").values, [[12345.67]]);
});

test("trailing empties are trimmed the way the values API trims them", () => {
  // C1 is the last non-empty cell of row 1, and D is empty throughout: the rows
  // must be ragged rather than padded, which is what the renderer expects.
  const valueRange = workbookValueRange(workbook(), "'Q1 2026'!A1:D3");
  assert.deepEqual(valueRange.values?.[0], ["Net worth", "Q1", "Date"]);
});

test("a range naming a tab the workbook does not have says which tabs it has", () => {
  assert.throws(
    () => workbookValueRange(workbook(), "'Nope'!A1:B2"),
    /No tab called "Nope".*Summary, Q1 2026, Archive/s,
  );
  // Sheets resolves a tab name case-insensitively, and so does this.
  assert.deepEqual(workbookValueRange(workbook(), "'summary'!A1").values, [["Headline"]]);
});

test("the spreadsheet map reports the data extent and the hidden tab", () => {
  const spreadsheet = workbookToSpreadsheet("1abc", workbook());
  assert.equal(spreadsheet.spreadsheetId, "1abc");
  assert.equal(spreadsheet.properties?.title, "Master.xlsx");
  assert.equal(spreadsheet.spreadsheetUrl, "https://docs.google.com/spreadsheets/d/1abc/edit");
  const q1 = spreadsheet.sheets?.[1].properties;
  assert.equal(q1?.title, "Q1 2026");
  assert.equal(q1?.sheetId, 1);
  assert.deepEqual(q1?.gridProperties, { rowCount: 6, columnCount: 3 });
  assert.equal(spreadsheet.sheets?.[2].properties?.hidden, true);
});

test("batchGet answers in the order asked, and find_in_spreadsheet can scan it", () => {
  const response = workbookBatchValueRanges("1abc", workbook(), ["'Summary'", "'Q1 2026'!A1:A3"]);
  assert.deepEqual(
    response.valueRanges?.map((range) => range.range),
    ["'Summary'!A1:A2", "'Q1 2026'!A1:A3"],
  );
  // The whole point of adapting to ValueRange: the existing search works on it.
  const { hits } = findCells(response.valueRanges ?? [], "Roth", { maxResults: 10 });
  assert.deepEqual(
    hits.map((hit) => hit.address),
    ["'Q1 2026'!A2"],
  );
});

test("every Office-backed result carries the provenance note, and native ones do not", () => {
  const spreadsheet = workbookToSpreadsheet("1abc", workbook());
  assert.equal(spreadsheet.officeSource?.mimeType, XLSX_MIME);
  assert.match(officeNote(spreadsheet.officeSource), /downloaded the file and parsed it/);
  assert.match(officeNote(spreadsheet.officeSource), /no write tool can edit this file/);
  // A native spreadsheet has no officeSource, so its output is what it was.
  assert.equal(officeNote(undefined), "");
});
