/**
 * Reading an .xlsx the Sheets API refuses.
 *
 * Every assertion here is one of the silent failures: a workbook whose tabs are
 * mapped to the wrong parts reports the right tab names over the wrong numbers,
 * a shared string read as its first run truncates every styled label, a date
 * read as a serial is five digits nobody can act on, and a currency format
 * mistaken for a date turns $12,345.67 into a day in 1933.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { parseXlsx } from "../src/office/xlsx.js";
import { ZipArchive } from "../src/office/zip.js";
import { isDateFormatCode, serialToDateString } from "../src/office/number-format.js";
import { parseDelimited } from "../src/office/delimited.js";
import {
  DATE_SERIAL,
  DATE_SERIAL_AS_TEXT,
  XLSX_MIME,
  xlsxFixture,
} from "./fixtures/workbook.js";

const parse = () =>
  parseXlsx(xlsxFixture(), { title: "Master tracker.xlsx", mimeType: XLSX_MIME });

test("both ZIP compression methods an OOXML package uses are readable", () => {
  const archive = ZipArchive.open(xlsxFixture());
  // styles.xml is STORED, sharedStrings.xml is DEFLATEd — see the fixture.
  assert.match(archive.read("xl/styles.xml").toString("utf8"), /numFmtId="164"/);
  assert.match(archive.read("xl/sharedStrings.xml").toString("utf8"), /Roth IRA/);
  assert.equal(archive.read("xl/nothing-here.xml"), undefined);
});

test("a file that is not a ZIP says so rather than throwing a parse error", () => {
  assert.throws(
    () => ZipArchive.open(new Uint8Array(Buffer.from("not a zip at all, plainly"))),
    /not a ZIP archive/i,
  );
});

test("tabs come from the relationships, not from the part filenames", () => {
  // Summary is FIRST in the workbook and lives in sheet7.xml; Q1 2026 is second
  // and lives in sheet1.xml. A reader that went by filename would report
  // Summary's name over Q1's cells.
  const workbook = parse();
  assert.deepEqual(
    workbook.sheets.map((sheet) => sheet.title),
    ["Summary", "Q1 2026", "Archive"],
  );
  assert.deepEqual(workbook.sheets[0].rows, [["Headline"], [42]]);
  assert.equal(workbook.sheets[1].rows[0][0], "Net worth");
});

test("a tab's hidden state and its workbook id survive", () => {
  const workbook = parse();
  assert.deepEqual(
    workbook.sheets.map((sheet) => [sheet.title, sheet.gid, sheet.hidden]),
    [
      ["Summary", 4, false],
      ["Q1 2026", 1, false],
      ["Archive", 9, true],
    ],
  );
});

test("a shared string split into formatting runs is ONE value, not its first run", () => {
  const [row] = parse().sheets[1].rows;
  assert.equal(row[0], "Net worth");
});

test("an XML entity in a shared string comes back as the character", () => {
  assert.equal(parse().sheets[1].rows[2][0], "Brokerage & Cash");
});

test("every cell type an Excel sheet carries reads as the value it displays", () => {
  const rows = parse().sheets[1].rows;
  assert.equal(rows[0][1], "Q1"); // inlineStr
  assert.equal(rows[1][1], 12345.67); // number, currency-formatted
  assert.equal(rows[1][2], DATE_SERIAL_AS_TEXT); // number, date-formatted
  assert.equal(rows[2][2], true); // boolean
  assert.equal(rows[5][1], "12346"); // formula whose result is text
  assert.equal(rows[5][2], "#REF!"); // error literal
});

test("a currency format is not mistaken for a date", () => {
  // The fixture's custom format is `"$"#,##0.00_);[Red]("$"#,##0.00)`. Its
  // letters are all inside quotes or brackets, and a naive test for d/m/y in the
  // raw code would read $12,345.67 as a day in 1933.
  assert.equal(isDateFormatCode('"$"#,##0.00_);[Red]("$"#,##0.00)'), false);
  assert.equal(isDateFormatCode("General"), false);
  assert.equal(isDateFormatCode("0.00%"), false);
  assert.equal(isDateFormatCode('0.0" kg"'), false);
  assert.equal(isDateFormatCode("yyyy-mm-dd"), true);
  assert.equal(isDateFormatCode("[$-409]h:mm:ss AM/PM"), true);
});

test("the date epoch is 1899-12-30, and 1904 workbooks count from 1904", () => {
  assert.equal(serialToDateString(DATE_SERIAL, { date1904: false, timeOnly: false }), "2025-01-21");
  // The same day in the Mac 1904 system is 1462 days lower.
  assert.equal(
    serialToDateString(DATE_SERIAL - 1462, { date1904: true, timeOnly: false }),
    "2025-01-21",
  );
  // A fractional serial carries a time, and dropping it would turn a timestamped
  // ledger row into a bare date.
  assert.equal(serialToDateString(45678.5, { date1904: false, timeOnly: false }), "2025-01-21 12:00:00");
  assert.equal(serialToDateString(0.25, { date1904: false, timeOnly: true }), "06:00:00");
});

test("a styled-but-empty cell claims no width, and a row gap is preserved", () => {
  const sheet = parse().sheets[1];
  // D2 exists in the XML with a style and no value; the row must stay 3 wide.
  assert.equal(sheet.rows[1].length, 3);
  // Rows 4 and 5 are absent from the file; row 6 must still be row 6.
  assert.deepEqual(sheet.rows[3], []);
  assert.deepEqual(sheet.rows[4], []);
  assert.equal(sheet.rows[5][0], "Total");
});

test("formulas are kept beside the values, for FORMULA reads", () => {
  const sheet = parse().sheets[1];
  assert.equal(sheet.formulas?.[2]?.[1], "=SUM(B2:B2)");
  assert.equal(sheet.formulas?.[1]?.[1], undefined);
});

test("a delimited file parses RFC 4180, and its values stay strings", () => {
  const rows = parseDelimited('a,b,c\n"x,1","he said ""hi""",007\n', ",");
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["x,1", 'he said "hi"', "007"],
  ]);
  // An embedded newline inside quotes is one cell, not two rows.
  assert.deepEqual(parseDelimited('"one\ntwo",b\n', ","), [["one\ntwo", "b"]]);
  // A byte-order mark must not become part of the first heading.
  assert.deepEqual(parseDelimited("﻿head,x\n", ","), [["head", "x"]]);
});
