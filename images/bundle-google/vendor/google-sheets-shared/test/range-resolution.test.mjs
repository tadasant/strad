/**
 * Which TAB a call lands on.
 *
 * The dangerous case is a caller that reads gid 1680010701 and then writes a
 * bare `B4:D6`: Sheets resolves that against the FIRST tab, so the write goes
 * somewhere the caller never looked. The write tools therefore refuse a range
 * that names no tab, and both read and write accept the gid a pasted URL
 * carries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { intendedSheetGid, resolveRange } from "../build/utils/resolve-range.js";

const SPREADSHEET = {
  spreadsheetId: "abc",
  sheets: [
    { properties: { sheetId: 0, title: "Summary" } },
    { properties: { sheetId: 1680010701, title: "Q1 2026" } },
  ],
};

const client = { getSpreadsheet: async () => SPREADSHEET };

test("a range naming its own tab is used verbatim", async () => {
  assert.equal(
    await resolveRange(client, "abc", { range: "'Q1 2026'!A1:D50" }),
    "'Q1 2026'!A1:D50",
  );
});

test("a gid resolves to that tab's title, quoted", async () => {
  assert.equal(
    await resolveRange(client, "abc", { sheetGid: 1680010701, range: "A1:D50" }),
    "'Q1 2026'!A1:D50",
  );
  assert.equal(await resolveRange(client, "abc", { sheetGid: 1680010701 }), "'Q1 2026'");
});

test("an unknown gid says which tabs exist rather than guessing", async () => {
  await assert.rejects(
    () => resolveRange(client, "abc", { sheetGid: 999 }),
    /No tab with gid 999.*Q1 2026/s,
  );
});

test("a gid and a range that names a different tab is a conflict, not a coin toss", async () => {
  await assert.rejects(
    () => resolveRange(client, "abc", { sheetGid: 0, range: "'Q1 2026'!A1" }),
    /Pass either sheet_gid or a range that names a tab/,
  );
});

test("a read with no tab at all falls back to the first tab", async () => {
  assert.equal(await resolveRange(client, "abc", {}), "'Summary'");
});

test("a WRITE with no tab is refused, because Sheets would pick the first one", async () => {
  await assert.rejects(
    () => resolveRange(client, "abc", { range: "B4:D6", requireTab: true }),
    /does not name a tab.*FIRST tab/s,
  );
  // …and is fine as soon as something names the tab.
  assert.equal(
    await resolveRange(client, "abc", {
      range: "B4:D6",
      sheetGid: 1680010701,
      requireTab: true,
    }),
    "'Q1 2026'!B4:D6",
  );
});

test("a pasted URL's gid is used, unless the caller named a tab explicitly", () => {
  const url = "https://docs.google.com/spreadsheets/d/abc/edit?gid=1680010701#gid=1680010701";

  assert.equal(intendedSheetGid({ spreadsheetIdOrUrl: url, range: "A1:D50" }), 1680010701);
  // An explicit tab in the range outranks the URL — the URL is an inference.
  assert.equal(intendedSheetGid({ spreadsheetIdOrUrl: url, range: "'Summary'!A1" }), undefined);
  // And an explicit sheet_gid outranks both.
  assert.equal(intendedSheetGid({ spreadsheetIdOrUrl: url, sheetGid: 7 }), 7);
});
