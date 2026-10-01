/**
 * Every tool that takes an existing file, against an Office file, over a real MCP client.
 *
 * The other Office suites test the pieces. This one runs the thing a caller
 * runs: an MCP `tools/call` over an in-memory transport, into the same
 * `createRegisterTools` the bundle host registers, onto a client whose Sheets
 * half answers exactly as Google answers for an uploaded .xlsx and whose Drive
 * half serves the fixture's bytes. What it asserts is the output an agent would
 * actually read — including the line that tells it this was not a live read.
 *
 * The one seam is the OAuth token exchange, which is google-auth-library's and
 * is not reachable without talking to Google. Nothing in the Office path
 * depends on it beyond an Authorization header.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createRegisterTools } from "../src/tools.js";
import { withOfficeFallback } from "../src/office/client.js";
import { OfficeWorkbookLoader } from "../src/office/load.js";
import { GoogleApiError } from "../src/google-sheets-client/lib/api-errors.js";
import { XLSX_MIME, xlsxFixture } from "./fixtures/workbook.js";

const FILE_ID = "1qR8s_office_file_id";

const officeFileError = () =>
  new GoogleApiError(
    400,
    "client",
    "Bad request: 400 Bad Request - FAILED_PRECONDITION: This operation is not supported " +
      "for this document. The document must not be an Office file.",
  );

/** A Sheets client that answers every call the way Google answers for an .xlsx. */
const sheetsRefusingEverything = () =>
  new Proxy({}, { get: () => () => Promise.reject(officeFileError()) });

let driveCalls = [];
const realFetch = globalThis.fetch;

async function connect(client) {
  const server = new Server({ name: "test", version: "0" }, { capabilities: { tools: {} } });
  createRegisterTools(() => client)(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test-client", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

/** The real decorator over a real loader, with Drive stubbed at fetch. */
function officeClient() {
  return withOfficeFallback(
    sheetsRefusingEverything(),
    new OfficeWorkbookLoader(
      async () => ({ Authorization: "Bearer t" }),
      "https://strad.example/ui/google-sheets-tadas412-ro",
    ),
  );
}

const textOf = (result) => result.content.map((part) => part.text).join("\n");

beforeEach(() => {
  driveCalls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    driveCalls.push(target);
    if (target.includes("alt=media")) return new Response(xlsxFixture(), { status: 200 });
    return new Response(
      JSON.stringify({ id: FILE_ID, name: "Master tracker.xlsx", mimeType: XLSX_MIME }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("get_spreadsheet maps the tabs of an uploaded .xlsx", async () => {
  const mcp = await connect(officeClient());
  const text = textOf(
    await mcp.callTool({ name: "get_spreadsheet", arguments: { spreadsheet_id: FILE_ID } }),
  );

  assert.match(text, /# Master tracker\.xlsx/);
  assert.match(text, /\*\*Summary\*\* — gid 4, 2 rows x 1 columns/);
  assert.match(text, /\*\*Q1 2026\*\* — gid 1, 6 rows x 3 columns/);
  assert.match(text, /\*\*Archive\*\* — gid 9, 1 rows x 1 columns, hidden/);
  // The line that keeps this honest.
  assert.match(text, /Read from an Office-format file in Drive/);
  assert.match(text, /no write tool can edit this file/);
});

test("get_sheet_values reads a range, addressed the way the file is", async () => {
  const mcp = await connect(officeClient());
  const text = textOf(
    await mcp.callTool({
      name: "get_sheet_values",
      arguments: { spreadsheet_id: FILE_ID, range: "'Q1 2026'!A1:C3" },
    }),
  );

  assert.match(text, /\*\*Range:\*\* 'Q1 2026'!A1:C3/);
  assert.match(text, /\|\s*\|\s*A\s*\|\s*B\s*\|\s*C\s*\|/);
  assert.match(text, /\|\s*1\s*\|\s*Net worth\s*\|\s*Q1\s*\|\s*Date\s*\|/);
  // The currency cell is a number and the date cell is a date, not two serials.
  assert.match(text, /\|\s*2\s*\|\s*Roth IRA\s*\|\s*12345\.67\s*\|\s*2025-01-21\s*\|/);
  assert.match(text, /Read from an Office-format file in Drive/);
});

test("get_sheet_values takes the tab by gid, from a pasted URL", async () => {
  const mcp = await connect(officeClient());
  const text = textOf(
    await mcp.callTool({
      name: "get_sheet_values",
      arguments: {
        spreadsheet_id: `https://docs.google.com/spreadsheets/d/${FILE_ID}/edit#gid=4`,
        range: "A1:A2",
      },
    }),
  );
  assert.match(text, /\*\*Range:\*\* 'Summary'!A1:A2/);
  assert.match(text, /Headline/);
});

test("batch_get_sheet_values answers several ranges from one download", async () => {
  const mcp = await connect(officeClient());
  const text = textOf(
    await mcp.callTool({
      name: "batch_get_sheet_values",
      arguments: { spreadsheet_id: FILE_ID, ranges: ["'Summary'!A1:A2", "'Q1 2026'!A2:A3"] },
    }),
  );
  assert.match(text, /Read 2 range\(s\)/);
  assert.match(text, /## 'Summary'!A1:A2/);
  assert.match(text, /## 'Q1 2026'!A2:A3/);
  assert.match(text, /Roth IRA/);
  // One metadata call and one media call for the whole tool call.
  assert.equal(driveCalls.length, 2);
});

test("find_in_spreadsheet scans the visible tabs and reports A1 addresses", async () => {
  const mcp = await connect(officeClient());
  const text = textOf(
    await mcp.callTool({
      name: "find_in_spreadsheet",
      arguments: { spreadsheet_id: FILE_ID, query: "Roth" },
    }),
  );
  assert.match(text, /Searched 2 tab\(s\) for "Roth": 1 hit\(s\)/);
  assert.match(text, /- 'Q1 2026'!A2 — Roth IRA/);
  // The hidden Archive tab also contains "Roth IRA" and must not be searched.
  assert.doesNotMatch(text, /'Archive'/);
  // Two reads of one file — the map and the tabs — and still one download.
  assert.equal(driveCalls.filter((call) => call.includes("alt=media")).length, 1);
});

test("FORMULA returns the stored formula, not its cached result", async () => {
  const mcp = await connect(officeClient());
  const text = textOf(
    await mcp.callTool({
      name: "get_sheet_values",
      arguments: {
        spreadsheet_id: FILE_ID,
        range: "'Q1 2026'!B3",
        value_render_option: "FORMULA",
      },
    }),
  );
  assert.match(text, /=SUM\(B2:B2\)/);
});

test("every write tool refuses an Office file and says what to do", async () => {
  const mcp = await connect(officeClient());
  const calls = [
    { name: "update_sheet_values", arguments: { spreadsheet_id: FILE_ID, range: "'Q1 2026'!B2", values: [[1]] } },
    { name: "append_sheet_rows", arguments: { spreadsheet_id: FILE_ID, range: "'Q1 2026'!A:C", values: [[1]] } },
    { name: "clear_sheet_values", arguments: { spreadsheet_id: FILE_ID, range: "'Q1 2026'!B2" } },
    { name: "add_sheet", arguments: { spreadsheet_id: FILE_ID, title: "New" } },
    {
      name: "format_cells",
      arguments: { spreadsheet_id: FILE_ID, formats: [{ range: "'Q1 2026'!A1:C1", format: { bold: true } }] },
    },
  ];
  for (const call of calls) {
    const result = await mcp.callTool(call);
    assert.equal(result.isError, true, call.name);
    const text = textOf(result);
    assert.match(text, new RegExp(`${call.name} cannot edit`), call.name);
    assert.match(text, /File > Save as Google Sheets/, call.name);
  }
  // A refused write never downloads the file.
  assert.deepEqual(driveCalls, []);
});

test("a missing Drive scope reaches the caller as a tool error that names it", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: { code: 403, message: "Request had insufficient authentication scopes." },
      }),
      { status: 403, statusText: "Forbidden", headers: { "content-type": "application/json" } },
    );

  const mcp = await connect(officeClient());
  const result = await mcp.callTool({
    name: "get_sheet_values",
    arguments: { spreadsheet_id: FILE_ID, range: "'Q1 2026'!A1:C3" },
  });

  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /https:\/\/www\.googleapis\.com\/auth\/drive\.readonly/);
  assert.match(text, /Reconnect Google on https:\/\/strad\.example\/ui\/google-sheets-tadas412-ro/);
  assert.match(text, /File > Save as Google Sheets/);
});

test("a NATIVE spreadsheet is served exactly as before, and never touches Drive", async () => {
  const native = {
    getSpreadsheet: async () => ({
      spreadsheetId: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
      properties: { title: "A real Google Sheet" },
      sheets: [{ properties: { sheetId: 0, title: "Sheet1", index: 0, gridProperties: { rowCount: 100, columnCount: 26 } } }],
    }),
    getValues: async () => ({ range: "'Sheet1'!A1:B1", values: [["live", "data"]] }),
  };
  const mcp = await connect(withOfficeFallback(native, new OfficeWorkbookLoader(async () => ({}))));

  const map = textOf(await mcp.callTool({ name: "get_spreadsheet", arguments: { spreadsheet_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" } }));
  assert.match(map, /A real Google Sheet/);
  assert.match(map, /\*\*Sheet1\*\* — gid 0, 100 rows x 26 columns/);

  const values = textOf(
    await mcp.callTool({ name: "get_sheet_values", arguments: { spreadsheet_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms", range: "'Sheet1'!A1:B1" } }),
  );
  assert.match(values, /\|\s*live\s*\|\s*data\s*\|/);

  // No provenance note, and no Drive request: the native path is untouched.
  assert.doesNotMatch(map, /Office-format/);
  assert.doesNotMatch(values, /Office-format/);
  assert.deepEqual(driveCalls, []);
});
