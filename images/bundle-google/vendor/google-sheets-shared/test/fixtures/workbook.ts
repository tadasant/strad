/**
 * One .xlsx fixture, carrying every shape the parser has a branch for.
 *
 * Read it as the specification of what an Excel workbook puts on disk:
 *
 *   - THE TABS ARE OUT OF ORDER relative to their part filenames. `Summary` is
 *     first and lives in `sheet7.xml`; `Q1 2026` is second and lives in
 *     `sheet1.xml`. That is what Excel leaves behind after a tab is deleted or
 *     moved, and a reader that maps tab n to sheetN.xml serves the wrong tab's
 *     numbers under the right tab's name — silently.
 *   - A HIDDEN tab, which `find_in_spreadsheet` skips by default.
 *   - Shared strings, including one split into RUNS by formatting and one
 *     carrying an XML entity.
 *   - An inline string, a boolean, a formula, a formula whose result is text,
 *     an error literal, a date (built-in format 14) and a currency number
 *     (a custom format, which must NOT be mistaken for a date).
 *   - A ragged row, a gap in the row numbering, and a styled-but-empty cell.
 */
import { makeZip } from "./zip.js";

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Excel serial 45678 in the default 1900 system. */
export const DATE_SERIAL = 45678;
export const DATE_SERIAL_AS_TEXT = "2025-01-21";

const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr/>
  <sheets>
    <sheet name="Summary" sheetId="4" r:id="rId3"/>
    <sheet name="Q1 2026" sheetId="1" r:id="rId1"/>
    <sheet name="Archive" sheetId="9" state="hidden" r:id="rId2"/>
  </sheets>
</workbook>`;

const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet7.xml"/>
  <Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

// si 0 is split into runs by formatting — "Net " bold, "worth" not — which is
// what Excel writes for a partially styled cell.
const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5">
  <si><r><rPr><b/></rPr><t xml:space="preserve">Net </t></r><r><t>worth</t></r></si>
  <si><t>Roth IRA</t></si>
  <si><t>Brokerage &amp; Cash</t></si>
  <si><t>Date</t></si>
  <si><t>Total</t></si>
</sst>`;

// numFmtId 14 is the built-in short date. 164 is this workbook's own currency
// format, and the letters in it are inside quotes — the case a naive
// "does the format code contain a d or an m" test gets wrong.
const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00_);[Red](&quot;$&quot;#,##0.00)"/>
  </numFmts>
  <cellStyleXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" xfId="0"/>
    <xf numFmtId="14" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="164" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" xfId="0"/>
  </cellXfs>
</styleSheet>`;

const q1SheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:D6"/>
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="inlineStr"><is><t>Q1</t></is></c>
      <c r="C1" t="s"><v>3</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>1</v></c>
      <c r="B2" s="2"><v>12345.67</v></c>
      <c r="C2" s="1"><v>${DATE_SERIAL}</v></c>
      <c r="D2" s="3"/>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>2</v></c>
      <c r="B3" s="2"><f>SUM(B2:B2)</f><v>12345.67</v></c>
      <c r="C3" t="b"><v>1</v></c>
    </row>
    <row r="6">
      <c r="A6" t="s"><v>4</v></c>
      <c r="B6" t="str"><f>TEXT(B2,"0")</f><v>12346</v></c>
      <c r="C6" t="e"><v>#REF!</v></c>
    </row>
  </sheetData>
</worksheet>`;

const summarySheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Headline</t></is></c></row>
    <row r="2"><c r="A2"><v>42</v></c></row>
  </sheetData>
</worksheet>`;

const archiveSheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Roth IRA</t></is></c></row>
  </sheetData>
</worksheet>`;

/** The fixture's bytes. `sharedStrings` is deflated, the rest stored. */
export function xlsxFixture() {
  return makeZip(
    {
      "[Content_Types].xml": '<?xml version="1.0"?><Types/>',
      "xl/workbook.xml": workbookXml,
      "xl/_rels/workbook.xml.rels": relsXml,
      "xl/sharedStrings.xml": sharedStringsXml,
      "xl/styles.xml": stylesXml,
      "xl/worksheets/sheet1.xml": q1SheetXml,
      "xl/worksheets/sheet2.xml": archiveSheetXml,
      "xl/worksheets/sheet7.xml": summarySheetXml,
    },
    { deflate: ["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"] },
  );
}
