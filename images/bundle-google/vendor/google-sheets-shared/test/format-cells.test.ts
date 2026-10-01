/**
 * format_cells: the A1-to-grid translation, the fields mask, and the tool over a
 * real MCP client into the same decorated client the bundle builds, with Google
 * stubbed at fetch.
 *
 * What it guards: a style lands on the cells the caller named and on no others
 * (an off-by-one here styles the wrong row of a financial model), only the keys
 * given are written (a mask of `userEnteredFormat` would wipe every format the
 * caller did not mention), and a request that cannot all land sends nothing.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createRegisterTools } from "../src/tools.js";
import { withOfficeFallback } from "../src/office/client.js";
import { OfficeWorkbookLoader } from "../src/office/load.js";
import {
  buildFormatRequests,
  formatCells,
  parseHexColor,
} from "../src/google-sheets-client/lib/format-cells.js";

const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
const SHEETS = {
  sheets: [
    { properties: { sheetId: 0, title: "Summary" } },
    { properties: { sheetId: 777, title: "Offer A" } },
    { properties: { sheetId: 42, title: "Q1" } },
  ],
};

const build = (entries, gid?) => buildFormatRequests(SHEETS, entries, gid);
const one = (range, format, gid?) => build([{ range, format }], gid).requests[0];

// --- A1 to GridRange --------------------------------------------------------

test("a bounded range becomes 0-based, end-EXCLUSIVE indexes on the right tab", () => {
  assert.deepEqual(one("'Offer A'!B2:D20", { bold: true }).repeatCell.range, {
    sheetId: 777,
    startRowIndex: 1,
    endRowIndex: 20,
    startColumnIndex: 1,
    endColumnIndex: 4,
  });
  assert.deepEqual(one("Summary!C5", { bold: true }).repeatCell.range, {
    sheetId: 0,
    startRowIndex: 4,
    endRowIndex: 5,
    startColumnIndex: 2,
    endColumnIndex: 3,
  });
});

test("open axes stay open: whole columns, whole rows, a whole tab", () => {
  assert.deepEqual(one("'Offer A'!C:E", { bold: true }).repeatCell.range, {
    sheetId: 777,
    startColumnIndex: 2,
    endColumnIndex: 5,
  });
  assert.deepEqual(one("'Offer A'!1:1", { bold: true }).repeatCell.range, {
    sheetId: 777,
    startRowIndex: 0,
    endRowIndex: 1,
  });
  assert.deepEqual(one("'Offer A'!B2:D", { bold: true }).repeatCell.range, {
    sheetId: 777,
    startRowIndex: 1,
    startColumnIndex: 1,
    endColumnIndex: 4,
  });
  assert.deepEqual(one("'Offer A'", { bold: true }).repeatCell.range, { sheetId: 777 });
  // A reversed range selects the same block.
  assert.deepEqual(
    one("'Offer A'!D20:B2", { bold: true }).repeatCell.range,
    one("'Offer A'!B2:D20", { bold: true }).repeatCell.range,
  );
});

test("a tab named like a cell (Q1) is the tab when one exists", () => {
  assert.deepEqual(one("Q1", { bold: true }).repeatCell.range, { sheetId: 42 });
});

test("a range with no tab is refused, unless sheet_gid says which tab", () => {
  assert.throws(() => one("B2:D5", { bold: true }), /does not name a tab/);
  assert.equal(one("B2:D5", { bold: true }, 777).repeatCell.range.sheetId, 777);
  // A range that names its own tab wins over the default.
  assert.equal(one("Summary!A1", { bold: true }, 777).repeatCell.range.sheetId, 0);
  assert.throws(() => one("B2", { bold: true }, 999), /No tab with gid 999/);
});

test("an unknown tab, a named range or row 0 is refused rather than guessed at", () => {
  assert.throws(() => one("'Offer B'!A1", { bold: true }), /no tab titled "Offer B".*"Offer A" \(gid 777\)/);
  assert.throws(() => one("'Offer A'!Totals", { bold: true }), /not an A1 cell range/);
  assert.throws(() => one("'Offer A'!A0:B3", { bold: true }), /not an A1 cell range/);
});

// --- the fields mask --------------------------------------------------------

test("only the keys given are in the fields mask, so other formatting stays", () => {
  const req = one("'Offer A'!A1:F1", { bold: true, horizontal_alignment: "CENTER" }).repeatCell;
  assert.equal(req.fields, "userEnteredFormat.textFormat.bold,userEnteredFormat.horizontalAlignment");
  assert.deepEqual(req.cell, {
    userEnteredFormat: { textFormat: { bold: true }, horizontalAlignment: "CENTER" },
  });
  // Never the whole object: that would reset every unnamed format to default.
  assert.doesNotMatch(req.fields, /(^|,)userEnteredFormat(,|$)/);
  assert.doesNotMatch(req.fields, /(^|,)userEnteredFormat\.textFormat(,|$)/);
});

test("a colour is written to the plain field AND its Style twin", () => {
  const req = one("Summary!A1", { background_color: "#1f4e79", text_color: "#fff" }).repeatCell;
  const navy = { red: 0.1216, green: 0.3059, blue: 0.4745 };
  assert.deepEqual(req.cell.userEnteredFormat.backgroundColor, navy);
  assert.deepEqual(req.cell.userEnteredFormat.backgroundColorStyle, { rgbColor: navy });
  assert.deepEqual(req.cell.userEnteredFormat.textFormat.foregroundColorStyle, {
    rgbColor: { red: 1, green: 1, blue: 1 },
  });
  assert.equal(
    req.fields,
    [
      "userEnteredFormat.backgroundColor",
      "userEnteredFormat.backgroundColorStyle",
      "userEnteredFormat.textFormat.foregroundColor",
      "userEnteredFormat.textFormat.foregroundColorStyle",
    ].join(","),
  );
});

test("number formats carry the type and the pattern verbatim", () => {
  for (const pattern of ["$#,##0", '$#,##0,,"M"', '0.0"x"', "0.0%"]) {
    const req = one("'Offer A'!B2:B9", { number_format: { type: "NUMBER", pattern } }).repeatCell;
    assert.deepEqual(req.cell.userEnteredFormat.numberFormat, { type: "NUMBER", pattern });
    assert.equal(req.fields, "userEnteredFormat.numberFormat");
  }
  const bare = one("'Offer A'!B2", { number_format: { type: "PERCENT" } }).repeatCell;
  assert.deepEqual(bare.cell.userEnteredFormat.numberFormat, { type: "PERCENT" });
});

test("every text and layout key maps to its API field", () => {
  const req = one("Summary!A1", {
    italic: true,
    underline: false,
    strikethrough: true,
    font_size: 14,
    font_family: "Roboto",
    vertical_alignment: "MIDDLE",
    wrap_strategy: "WRAP",
  }).repeatCell;
  assert.deepEqual(req.cell.userEnteredFormat, {
    textFormat: { italic: true, underline: false, strikethrough: true, fontSize: 14, fontFamily: "Roboto" },
    verticalAlignment: "MIDDLE",
    wrapStrategy: "WRAP",
  });
});

test("hex colours: #RRGGBB, #RGB, no hash; anything else is refused", () => {
  assert.deepEqual(parseHexColor("#ffffff"), { red: 1, green: 1, blue: 1 });
  assert.deepEqual(parseHexColor("f00"), { red: 1, green: 0, blue: 0 });
  assert.throws(() => parseHexColor("navy"), /not a colour/);
});

// --- borders ----------------------------------------------------------------

test("borders: outer and inner expand, a named side overrides, colour defaults to black", () => {
  const { requests, applied } = build([
    {
      range: "'Offer A'!A1:F20",
      format: {
        borders: {
          outer: { style: "SOLID_MEDIUM" },
          inner: { style: "SOLID", color: "#d9d9d9" },
          bottom: { style: "DOUBLE" },
        },
      },
    },
  ]);
  assert.equal(requests.length, 1, "borders alone send no repeatCell");
  const b = requests[0].updateBorders;
  const black = { red: 0, green: 0, blue: 0 };
  assert.deepEqual(b.top, { style: "SOLID_MEDIUM", color: black, colorStyle: { rgbColor: black } });
  assert.equal(b.left.style, "SOLID_MEDIUM");
  assert.equal(b.right.style, "SOLID_MEDIUM");
  assert.equal(b.bottom.style, "DOUBLE");
  assert.equal(b.innerHorizontal.style, "SOLID");
  assert.deepEqual(b.innerVertical.colorStyle, { rgbColor: { red: 0.851, green: 0.851, blue: 0.851 } });
  assert.deepEqual(b.range, {
    sheetId: 777,
    startRowIndex: 0,
    endRowIndex: 20,
    startColumnIndex: 0,
    endColumnIndex: 6,
  });
  assert.equal(applied[0].fields.length, 6);
});

test("an unnamed side is left out, so the API keeps it; NONE removes one", () => {
  const b = one("Summary!A1:B2", { borders: { bottom: { style: "NONE" } } }).updateBorders;
  assert.deepEqual(Object.keys(b).sort(), ["bottom", "range"]);
  assert.deepEqual(b.bottom, { style: "NONE" });
});

test("cell formats and borders in one entry are two requests, in that order", () => {
  const { requests } = build([
    { range: "Summary!A1:B2", format: { bold: true, borders: { outer: { style: "SOLID" } } } },
  ]);
  assert.deepEqual(requests.map((r) => Object.keys(r)[0]), ["repeatCell", "updateBorders"]);
});

test("an entry that sets nothing is refused", () => {
  assert.throws(() => build([{ range: "Summary!A1", format: {} }]), /sets no formatting/);
  assert.throws(() => build([{ range: "Summary!A1", format: { borders: {} } }]), /sets no formatting/);
});

// --- the wire ---------------------------------------------------------------

let calls = [];
let replies = [];
const realFetch = globalThis.fetch;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  replies = [() => json(SHEETS), () => json({ spreadsheetId: ID, replies: [] })];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    const next = replies.shift();
    return next ? next() : json({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the wire: one narrow tab read, then ONE batchUpdate carrying every entry", async () => {
  const result = await formatCells({ Authorization: "Bearer t" }, ID, [
    { range: "'Offer A'!A1:F1", format: { bold: true } },
    { range: "Summary!B2:B9", format: { number_format: { type: "CURRENCY", pattern: "$#,##0" } } },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(new URL(calls[0].url).searchParams.get("fields"), "sheets(properties(sheetId,title))");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url, `https://sheets.googleapis.com/v4/spreadsheets/${ID}:batchUpdate`);
  const body = JSON.parse(calls[1].body);
  assert.deepEqual(Object.keys(body), ["requests"]);
  assert.equal(body.requests.length, 2);
  assert.equal(result.requestCount, 2);
  // Only the two request kinds this module builds can ever be on the wire.
  for (const request of body.requests) {
    assert.ok(["repeatCell", "updateBorders"].includes(Object.keys(request)[0]));
  }
});

// --- over MCP ---------------------------------------------------------------

/** A Sheets client whose one method is the real wire, over the stubbed fetch. */
const wireClient = () =>
  withOfficeFallback(
    { formatCells: (id, entries, gid) => formatCells({ Authorization: "Bearer t" }, id, entries, gid) },
    new OfficeWorkbookLoader(async () => ({})),
  );

async function connect(client) {
  const server = new Server({ name: "test", version: "0" }, { capabilities: { tools: {} } });
  createRegisterTools(() => client)(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test-client", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

const textOf = (result) => result.content.map((part) => part.text).join("\n");

test("it styles a whole sheet in one call and says what it set where", async () => {
  const mcp = await connect(wireClient());
  const result = await mcp.callTool({
    name: "format_cells",
    arguments: {
      spreadsheet_id: `https://docs.google.com/spreadsheets/d/${ID}/edit`,
      formats: [
        {
          range: "'Offer A'!A1:F1",
          format: { background_color: "#1f4e79", text_color: "#fff", bold: true, horizontal_alignment: "CENTER" },
        },
        { range: "'Offer A'!B2:D20", format: { number_format: { type: "CURRENCY", pattern: "$#,##0" } } },
        { range: "'Offer A'!E2:E20", format: { number_format: { type: "NUMBER", pattern: '0.0"x"' } } },
        { range: "'Offer A'!A1:F20", format: { borders: { outer: { style: "SOLID_MEDIUM" } } } },
      ],
    },
  });

  assert.equal(result.isError, undefined, textOf(result));
  const text = textOf(result);
  assert.match(text, new RegExp(`Formatted 4 ranges in ${ID} \\(4 requests\\)`));
  assert.match(text, /- 'Offer A'!A1:F1 — backgroundColor, backgroundColorStyle, .*textFormat\.bold, horizontalAlignment/);
  assert.match(text, /- 'Offer A'!B2:D20 — numberFormat/);
  assert.match(text, /- 'Offer A'!A1:F20 — borders\.top, borders\.bottom, borders\.left, borders\.right/);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("a pasted URL's #gid= is the tab for a range that names none", async () => {
  const mcp = await connect(wireClient());
  const result = await mcp.callTool({
    name: "format_cells",
    arguments: {
      spreadsheet_id: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=777`,
      formats: [{ range: "B2:B9", format: { italic: true } }],
    },
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /'Offer A'!B2:B9 — textFormat\.italic/);
  assert.equal(JSON.parse(calls[1].body).requests[0].repeatCell.range.sheetId, 777);
});

test("one bad entry sends NOTHING: the sheet is styled whole or not at all", async () => {
  const mcp = await connect(wireClient());
  const result = await mcp.callTool({
    name: "format_cells",
    arguments: {
      spreadsheet_id: ID,
      formats: [
        { range: "'Offer A'!A1:F1", format: { bold: true } },
        { range: "'Offer Z'!A1", format: { bold: true } },
      ],
    },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /formats\[1\] \("'Offer Z'!A1"\): no tab titled "Offer Z"/);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("an unknown format key is refused by name rather than ignored", async () => {
  const mcp = await connect(wireClient());
  const result = await mcp.callTool({
    name: "format_cells",
    arguments: { spreadsheet_id: ID, formats: [{ range: "Summary!A1", format: { fill_color: "#fff" } }] },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /formats\.0\.format: Unrecognized key\(s\) in object: 'fill_color'/);
  assert.deepEqual(calls, []);
});

test("a bad colour or enum is refused before anything is read", async () => {
  const mcp = await connect(wireClient());
  for (const format of [
    { background_color: "navy" },
    { horizontal_alignment: "JUSTIFY" },
    { number_format: { type: "MONEY" } },
    { borders: { outer: { style: "THICK" } } },
  ]) {
    const result = await mcp.callTool({
      name: "format_cells",
      arguments: { spreadsheet_id: ID, formats: [{ range: "Summary!A1", format }] },
    });
    assert.equal(result.isError, true, JSON.stringify(format));
  }
  assert.deepEqual(calls, []);
});

test("Google refusing the batch is a tool error with its reason", async () => {
  replies = [
    () => json(SHEETS),
    () =>
      json(
        { error: { code: 403, status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes." } },
        403,
      ),
  ];
  const mcp = await connect(wireClient());
  const result = await mcp.callTool({
    name: "format_cells",
    arguments: { spreadsheet_id: ID, formats: [{ range: "Summary!A1", format: { bold: true } }] },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Permission denied \(Format cells in /);
  assert.match(textOf(result), /https:\/\/www\.googleapis\.com\/auth\/spreadsheets\b/);
});

test("an Office file is refused on the tab read, before any batchUpdate", async () => {
  replies = [
    () =>
      json(
        {
          error: {
            code: 400,
            status: "FAILED_PRECONDITION",
            message: "This operation is not supported for this document",
          },
        },
        400,
      ),
  ];
  const mcp = await connect(wireClient());
  const result = await mcp.callTool({
    name: "format_cells",
    arguments: { spreadsheet_id: ID, formats: [{ range: "Summary!A1", format: { bold: true } }] },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /format_cells cannot edit .*Office-format file/s);
  assert.equal(calls.length, 1);
});
