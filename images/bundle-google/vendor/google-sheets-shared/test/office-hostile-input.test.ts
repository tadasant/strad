/**
 * The inputs that would produce a WRONG ANSWER rather than an error.
 *
 * Everything this server parses came off a Drive file it did not write, and the
 * population of files this path exists for is precisely the ones some other
 * program produced — an export, a bank's download, a third-party writer. The
 * failures below are the ones with no symptom: a cell that reads empty, a column
 * shifted by one, a duration short by a day. Each was found by review rather
 * than by a crash, which is the point.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { tags, textContent, unescapeXml } from "../src/office/xml.js";
import { parseXlsx } from "../src/office/xlsx.js";
import { parseDelimited, delimitedWorkbook } from "../src/office/delimited.js";
import { isElapsedFormatCode, serialToElapsedString } from "../src/office/number-format.js";
import { MAX_PARSED_CELLS } from "../src/office/workbook.js";
import { workbookValueRange } from "../src/office/to-sheets.js";
import { makeZip } from "./fixtures/zip.js";
import { XLSX_MIME } from "./fixtures/workbook.js";

/** A one-tab workbook from raw sheet XML, with optional styles. */
function oneTab(sheetXml, stylesXml = undefined, title = "S") {
  const parts = {
    "xl/workbook.xml":
      `<workbook><sheets><sheet name="${title}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${sheetXml}</sheetData></worksheet>`,
  };
  if (stylesXml) parts["xl/styles.xml"] = stylesXml;
  return parseXlsx(makeZip(parts), { title: "probe.xlsx", mimeType: XLSX_MIME });
}

test("a comment containing a tag does not inject a phantom row", () => {
  // `<!-- <row r="9"> -->` walked into as markup resets the row cursor, and
  // every cell after it lands nine rows down. LibreOffice and several exporters
  // emit comments in worksheet parts; Excel does not, which is why this is the
  // kind of bug that only shows up on somebody else's file.
  const workbook = oneTab(
    '<row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row>' +
      '<!-- <row r="9"><c r="A9"><v>999</v></c> -->' +
      '<row r="2"><c r="A2"><v>2</v></c></row>',
  );
  assert.deepEqual(workbook.sheets[0].rows, [["first"], [2]]);

  assert.deepEqual([...tags('<a><!-- <row r="9"> --><b/></a>')].map((t) => t.name), ["a", "b"]);
  assert.deepEqual([...tags('<?xml version="1.0"?><a/>')].map((t) => t.name), ["a"]);
});

test("a CDATA section is its contents, not an empty cell", () => {
  // `<![CDATA[Roth IRA]]>` opens with `<` and its first `>` is in `]]>`, so a
  // bare tag-strip deletes the label with the wrapper. The cell then reads empty
  // and find_in_spreadsheet honestly reports no hits.
  const workbook = parseXlsx(
    makeZip({
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/sharedStrings.xml":
        "<sst><si><t><![CDATA[Roth IRA]]></t></si><si><t>plain</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1">' +
        '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>' +
        "</row></sheetData></worksheet>",
    }),
    { title: "probe.xlsx", mimeType: XLSX_MIME },
  );
  assert.deepEqual(workbook.sheets[0].rows, [["Roth IRA", "plain"]]);

  // CDATA is literal: an entity inside it is text, not an entity.
  assert.equal(textContent("<t><![CDATA[a &amp; b]]></t>"), "a &amp; b");
  assert.equal(textContent("<t>a &amp; b</t>"), "a & b");
});

test("a character reference past the last code point degrades, and does not throw", () => {
  // String.fromCodePoint throws past U+10FFFF, so one malformed entity would
  // otherwise deny a whole workbook.
  assert.equal(unescapeXml("&#x110000;"), "&#x110000;");
  assert.equal(unescapeXml("&#99999999999;"), "&#99999999999;");
  assert.equal(unescapeXml("&#x41;&#66;"), "AB");
  assert.equal(unescapeXml("&notanentity;"), "&notanentity;");
});

test("an elapsed-time format counts hours, and does not wrap at midnight", () => {
  // `[h]:mm` on 1.5 is 36:00 — a day and a half. Read as a time of day it is
  // 12:00:00, wrong by exactly the whole days and silent about it. A timesheet
  // column is the ordinary case.
  assert.equal(isElapsedFormatCode("[h]:mm"), true);
  assert.equal(isElapsedFormatCode("h:mm"), false);
  assert.equal(serialToElapsedString(1.5, "[h]:mm"), "36:00:00");
  assert.equal(serialToElapsedString(0.25, "[mm]:ss"), "360:00");

  const styles =
    '<styleSheet><numFmts><numFmt numFmtId="165" formatCode="[h]:mm"/></numFmts>' +
    '<cellStyleXfs><xf numFmtId="0"/></cellStyleXfs>' +
    '<cellXfs><xf numFmtId="0"/><xf numFmtId="165"/><xf numFmtId="46"/><xf numFmtId="20"/></cellXfs>' +
    "</styleSheet>";
  const rows = oneTab(
    '<row r="1"><c r="A1" s="1"><v>1.5</v></c><c r="B1" s="2"><v>2.25</v></c>' +
      '<c r="C1" s="3"><v>2.25</v></c></row>',
    styles,
  ).sheets[0].rows;
  assert.deepEqual(rows, [["36:00:00", "54:00:00", "06:00:00"]]);
});

test("UNFORMATTED_VALUE serves the stored serial, as the Sheets API does", () => {
  const styles =
    '<styleSheet><cellStyleXfs><xf numFmtId="0"/></cellStyleXfs>' +
    '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
  const workbook = oneTab('<row r="1"><c r="A1" s="1"><v>45678</v></c></row>', styles);

  assert.deepEqual(workbookValueRange(workbook, "'S'!A1").values, [["2025-01-21"]]);
  assert.deepEqual(
    workbookValueRange(workbook, "'S'!A1", { valueRenderOption: "UNFORMATTED_VALUE" }).values,
    [[45678]],
  );
  // A cell whose rendering changed nothing has no raw twin to serve.
  const plain = oneTab('<row r="1"><c r="A1"><v>7</v></c></row>');
  assert.deepEqual(
    workbookValueRange(plain, "'S'!A1", { valueRenderOption: "UNFORMATTED_VALUE" }).values,
    [[7]],
  );
});

test("a formula whose cached result is absent is still reachable under FORMULA", () => {
  // Only the VALUE grid is trimmed, so a formula-only row would otherwise fall
  // off the sheet's extent and read as though the cell did not exist.
  const workbook = oneTab(
    '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1*2</f><v>2</v></c></row>' +
      '<row r="2"><c r="A2"><f>A1</f></c></row>',
  );
  assert.deepEqual(workbook.sheets[0].rows, [[1, 2]]);
  assert.deepEqual(
    workbookValueRange(workbook, "'S'!A1:B2", { valueRenderOption: "FORMULA" }).values,
    [[1, "=A1*2"], ["=A1"]],
  );
  // And the map reports the row, rather than a sheet one row short.
  assert.equal(workbookValueRange(workbook, "'S'", { valueRenderOption: "FORMULA" }).range,
    "'S'!A1:B2");
});

test("a tab whose name looks like a cell reference is still addressable by name", () => {
  // `Q1`, `H1`, `FY26` are all valid A1 cell references AND the names a
  // financial workbook gives its tabs. get_spreadsheet hands an agent the bare
  // title, so reading it back as cell Q1 turns a populated tab into "no values".
  const workbook = oneTab(
    '<row r="1"><c r="A1" t="inlineStr"><is><t>revenue</t></is></c></row>',
    undefined,
    "Q1",
  );
  assert.deepEqual(workbookValueRange(workbook, "Q1").values, [["revenue"]]);
  assert.deepEqual(workbookValueRange(workbook, "'Q1'").values, [["revenue"]]);
  // With no tab of that name, the shape still decides — as it does on a native
  // spreadsheet.
  const notes = oneTab('<row r="1"><c r="A1"><v>1</v></c></row>', undefined, "Notes");
  assert.equal(workbookValueRange(notes, "Q1").values, undefined);
});

test("an <xf> outside cellXfs does not shift the style table", () => {
  // A cell's `s` indexes cellXfs alone. Counting a later block's <xf> appends
  // bogus ids and moves every date detection after it by one.
  const styles =
    '<styleSheet><cellStyleXfs><xf numFmtId="0"/></cellStyleXfs>' +
    '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>' +
    '<dxfs><xf numFmtId="14"/></dxfs><cellStyles><xf numFmtId="14"/></cellStyles></styleSheet>';
  const rows = oneTab(
    '<row r="1"><c r="A1" s="0"><v>45678</v></c><c r="B1" s="1"><v>45678</v></c></row>',
    styles,
  ).sheets[0].rows;
  assert.deepEqual(rows, [[45678, "2025-01-21"]]);
});

test("the cell budget is one budget, and the delimited path spends it too", () => {
  // A 19MB CSV of one-character fields is ten million cells and several hundred
  // megabytes of live arrays — inside the download cap and far past what this
  // container holds. The docs promise one number for both formats.
  const wide = `${"a,".repeat(400)}a\n`.repeat(400);
  assert.throws(
    () => parseDelimited(wide, ",", { cells: 1000 }),
    new RegExp(`more than ${MAX_PARSED_CELLS.toLocaleString("en-US")} cells`),
  );
  // Through the workbook entry point, with the real budget, a small file passes.
  const small = delimitedWorkbook(Buffer.from("a,b\n1,2\n"), {
    title: "t.csv",
    mimeType: "text/csv",
    budget: { cells: MAX_PARSED_CELLS },
  });
  assert.deepEqual(small.sheets[0].rows, [["a", "b"], ["1", "2"]]);
});

test("an .xlsx past the cell budget is refused, and names the conversion", () => {
  const cells = Array.from({ length: 20 }, (_, i) => `<c r="${String.fromCharCode(65 + i)}1"><v>${i}</v></c>`);
  const sheet = Array.from({ length: 20 }, (_, r) =>
    `<row r="${r + 1}">${cells.join("").replace(/1"><v>/g, `${r + 1}"><v>`)}</row>`,
  ).join("");
  assert.throws(
    () =>
      parseXlsx(
        makeZip({
          "xl/workbook.xml":
            '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
          "xl/_rels/workbook.xml.rels":
            '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
          "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
        }),
        { title: "big.xlsx", mimeType: XLSX_MIME, budget: { cells: 100 } },
      ),
    /more than 500,000 non-empty cells.*Save as Google Sheets/s,
  );
});

test("a UTF-16 delimited file is refused rather than decoded to nonsense", () => {
  // Decoded as UTF-8 it is not an error, it is a workbook full of NUL-separated
  // characters — which a caller would take at face value.
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,b\n", "utf16le")]);
  assert.throws(
    () => delimitedWorkbook(utf16, { title: "x.csv", mimeType: "text/csv" }),
    /UTF-16 encoded/,
  );
});
