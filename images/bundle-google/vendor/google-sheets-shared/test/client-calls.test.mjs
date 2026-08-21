/**
 * What actually goes on the wire.
 *
 * Every failure this file guards is invisible to a credential-free smoke test
 * and silent in production: a comma-joined `ranges` reads one range instead of
 * three, an `:append` without INSERT_ROWS overwrites the rows below a table, an
 * unencoded range 400s on every tab whose title has a space. None of it can be
 * caught by listing tools, and all of it decides which cells a caller touches.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { getSpreadsheet } from "../build/google-sheets-client/lib/get-spreadsheet.js";
import {
  appendValues,
  batchGetValues,
  clearValues,
  getValues,
  updateValues,
} from "../build/google-sheets-client/lib/values.js";
import { addSheet } from "../build/google-sheets-client/lib/batch-update.js";

const HEADERS = { Authorization: "Bearer test", "Content-Type": "application/json" };
const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

let calls = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    return new Response(JSON.stringify({ replies: [{ addSheet: { properties: {} } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a tab title with a space survives as an encoded range, not a 400", async () => {
  await getValues(HEADERS, ID, "'Q1 2026'!A1:D50");
  const { url } = calls[0];
  // encodeURIComponent leaves `'` alone — it is an unreserved mark — so the tab
  // quotes survive literally. What matters is that the SPACE and the colon do not.
  assert.match(url, /\/values\/'Q1%202026'!A1%3AD50$/);
  assert.doesNotMatch(url, /Q1 2026/);
});

test("valueRenderOption rides as a query parameter when asked for, and not otherwise", async () => {
  await getValues(HEADERS, ID, "A1:B2", { valueRenderOption: "FORMULA" });
  assert.match(calls[0].url, /[?&]valueRenderOption=FORMULA/);

  await getValues(HEADERS, ID, "A1:B2");
  assert.doesNotMatch(calls[1].url, /valueRenderOption/);
});

test("batchGet repeats `ranges`, and does not comma-join them", async () => {
  // A comma-joined list is ONE range as far as the API is concerned: the caller
  // would silently get one block back where it asked for three.
  await batchGetValues(HEADERS, ID, ["'A'!A1:B2", "'B'!A1:B2", "'C'!A1:B2"]);
  const url = new URL(calls[0].url);
  assert.deepEqual(url.searchParams.getAll("ranges"), ["'A'!A1:B2", "'B'!A1:B2", "'C'!A1:B2"]);
});

test("update is a PUT that carries the range it was told to write", async () => {
  await updateValues(HEADERS, ID, "'Ledger'!B4:C5", [["a", 1]], "USER_ENTERED");
  const call = calls[0];
  assert.equal(call.method, "PUT");
  assert.match(call.url, /valueInputOption=USER_ENTERED/);
  const body = JSON.parse(call.body);
  assert.equal(body.range, "'Ledger'!B4:C5");
  assert.equal(body.majorDimension, "ROWS");
  assert.deepEqual(body.values, [["a", 1]]);
});

test("append INSERTS rows rather than overwriting what sits below the table", async () => {
  await appendValues(HEADERS, ID, "'Ledger'!A1:D1", [["2026-08-01", "Rent", -2400]], "RAW");
  const call = calls[0];
  assert.equal(call.method, "POST");
  assert.match(call.url, /:append\?/);
  assert.match(call.url, /insertDataOption=INSERT_ROWS/);
  assert.match(call.url, /valueInputOption=RAW/);
});

test("clear posts to :clear with an empty body", async () => {
  await clearValues(HEADERS, ID, "'Scratch'!A2:D100");
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /:clear$/);
  assert.equal(calls[0].body, "{}");
});

test("addSheet sends exactly one addSheet request and nothing else", async () => {
  await addSheet(HEADERS, ID, { title: "August", index: 2, rowCount: 100 });
  const body = JSON.parse(calls[0].body);
  assert.equal(body.requests.length, 1);
  assert.deepEqual(body.requests[0].addSheet.properties, {
    title: "August",
    index: 2,
    gridProperties: { rowCount: 100 },
  });
});

test("the metadata read asks for a fields mask, so a huge workbook stays small", async () => {
  await getSpreadsheet(HEADERS, ID);
  const url = new URL(calls[0].url);
  const fields = url.searchParams.get("fields");
  assert.ok(fields.includes("sheets(properties(sheetId,title"));
  assert.ok(!fields.includes("includeGridData"));
});

test("a non-OK response becomes a categorised error, with the file-type hint", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: { status: "FAILED_PRECONDITION", message: "This operation is not supported" },
      }),
      { status: 400, statusText: "Bad Request" },
    );

  // The 33-character-id case: the API says nothing about file types, so the hint
  // is the only thing that tells a human what to actually do.
  await assert.rejects(() => getValues(HEADERS, ID, "A1:B2"), (error) => {
    assert.equal(error.name, "GoogleApiError");
    assert.equal(error.category, "client");
    assert.match(error.message, /Save as Google Sheets/);
    return true;
  });
});
