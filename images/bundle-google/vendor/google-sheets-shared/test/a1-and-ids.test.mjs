/**
 * The pure address arithmetic. Everything here decides WHICH CELL a tool touches,
 * which is the class of bug that reads the wrong row or writes to the right sheet
 * at the wrong offset — and the class no smoke test can catch, because a
 * credential-free container never addresses a cell.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { columnLetter, quoteSheetTitle, rangeOrigin, sheetRange } from "../build/utils/a1.js";
import { parseSheetGid, parseSpreadsheetId } from "../build/utils/parse-spreadsheet-id.js";

test("columnLetter walks past Z the way Sheets does", () => {
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(25), "Z");
  assert.equal(columnLetter(26), "AA");
  assert.equal(columnLetter(51), "AZ");
  assert.equal(columnLetter(52), "BA");
  assert.equal(columnLetter(701), "ZZ");
  assert.equal(columnLetter(702), "AAA");
});

test("a tab title is quoted, and an apostrophe in it is doubled", () => {
  assert.equal(quoteSheetTitle("Ledger"), "'Ledger'");
  assert.equal(quoteSheetTitle("Q1 2026"), "'Q1 2026'");
  // The one escape A1 notation has. Without it this range is a 400.
  assert.equal(quoteSheetTitle("Tadas' model"), "'Tadas'' model'");
});

test("sheetRange with no cells means the whole tab", () => {
  assert.equal(sheetRange("Q1 2026"), "'Q1 2026'");
  assert.equal(sheetRange("Q1 2026", "A1:D50"), "'Q1 2026'!A1:D50");
});

test("rangeOrigin finds the first cell of a range, tab or no tab", () => {
  assert.deepEqual(rangeOrigin("'Q1 2026'!B4:D9"), { row: 3, column: 1 });
  assert.deepEqual(rangeOrigin("A1:Z100"), { row: 0, column: 0 });
  assert.deepEqual(rangeOrigin("'Sheet1'!AA12"), { row: 11, column: 26 });
  // A whole-tab range names no cell: the origin is A1.
  assert.deepEqual(rangeOrigin("'Ledger'"), { row: 0, column: 0 });
});

test("parseSpreadsheetId accepts every form a human pastes", () => {
  const id = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
  assert.equal(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
  assert.equal(parseSpreadsheetId(`https://docs.google.com/spreadsheets/u/0/d/${id}/edit`), id);
  assert.equal(parseSpreadsheetId(`https://drive.google.com/open?id=${id}`), id);
  assert.equal(parseSpreadsheetId(`  ${id}  `), id);
  assert.throws(() => parseSpreadsheetId("not an id"), /Could not parse/);
});

test("a 33-character id parses — the API, not this code, judges the file type", () => {
  // The finance tracker's id. 33 characters where a native sheet is 44, which is
  // the shape of a binary uploaded to Drive. If that is what it is, the Sheets
  // API answers `failedPrecondition` and api-errors turns that into a hint;
  // guessing here would be guessing.
  assert.equal(
    parseSpreadsheetId(
      "https://docs.google.com/spreadsheets/d/1-h0lSiJ6jEtCNqi3cnZamY4AUwpvoN37/edit?gid=1680010701#gid=1680010701",
    ),
    "1-h0lSiJ6jEtCNqi3cnZamY4AUwpvoN37",
  );
});

test("parseSheetGid reads the tab out of a pasted URL", () => {
  assert.equal(
    parseSheetGid("https://docs.google.com/spreadsheets/d/abc/edit#gid=1680010701"),
    1680010701,
  );
  assert.equal(parseSheetGid("https://docs.google.com/spreadsheets/d/abc/edit?gid=42#gid=42"), 42);
  assert.equal(parseSheetGid("https://docs.google.com/spreadsheets/d/abc/edit"), undefined);
});

test("rangeOrigin survives a range that names no cell at all", () => {
  assert.deepEqual(rangeOrigin(""), { row: 0, column: 0 });
  assert.deepEqual(rangeOrigin("'Tab'!"), { row: 0, column: 0 });
});
