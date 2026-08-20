/**
 * What a caller SEES, and what it can safely do next with what it saw.
 *
 * The table these render is addressed with real A1 coordinates on purpose: a
 * caller that reads a block and then writes one cell of it uses those addresses
 * verbatim. A table numbered 1..n instead would be an invitation to write to the
 * wrong row, and it would look perfectly reasonable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderValueRange, MAX_CELLS } from "../build/utils/format-values.js";
import { findCells } from "../build/utils/find-cells.js";

test("a rendered range is addressed where it actually lives", () => {
  const { text } = renderValueRange({
    range: "'Q1 2026'!B4:D5",
    values: [
      ["Rent", 2400, "paid"],
      ["Groceries", 812, "paid"],
    ],
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "|  | B | C | D |");
  assert.equal(lines[2], "| 4 | Rent | 2400 | paid |");
  assert.equal(lines[3], "| 5 | Groceries | 812 | paid |");
});

test("ragged rows are padded, not indexed past their end", () => {
  // Sheets omits trailing empty cells, so row 2 here is genuinely shorter.
  const { text } = renderValueRange({
    range: "'Ledger'!A1:C2",
    values: [["a", "b", "c"], ["d"]],
  });
  assert.match(text, /\| 2 \| d \|  \|  \|/);
});

test("an empty range says so rather than rendering an empty table", () => {
  const rendered = renderValueRange({ range: "'Ledger'!A1:C10" });
  assert.equal(rendered.rows, 0);
  assert.match(rendered.text, /no values/);
});

test("a pipe in a cell cannot break the table it is rendered into", () => {
  const { text } = renderValueRange({ range: "'S'!A1", values: [["a|b"]] });
  assert.match(text, /a\\\|b/);
});

test("a range past the cap is truncated, and says how much it withheld", () => {
  const values = Array.from({ length: 4000 }, (_, i) => [i, i * 2]);
  const rendered = renderValueRange({ range: "'Big'!A1:B4000", values });
  assert.equal(rendered.truncated, true);
  assert.equal(rendered.rows, MAX_CELLS / 2);
  assert.match(rendered.text, /Truncated: showing 2500 of 4000 rows/);
});

test("findCells reports addresses a write tool can use unchanged", () => {
  const ranges = [
    {
      range: "'Q1 2026'!B4:D5",
      values: [
        ["Roth IRA", 12000, ""],
        ["Brokerage", 4000, ""],
      ],
    },
  ];
  const { hits } = findCells(ranges, "roth", { maxResults: 10 });
  assert.deepEqual(hits, [{ address: "'Q1 2026'!B4", value: "Roth IRA" }]);
});

test("findCells honours case, exactness and the result cap", () => {
  const ranges = [{ range: "'S'!A1:A3", values: [["alpha"], ["Alpha"], ["alphabet"]] }];

  assert.equal(findCells(ranges, "alpha", { maxResults: 10 }).hits.length, 3);
  assert.equal(findCells(ranges, "alpha", { matchCase: true, maxResults: 10 }).hits.length, 2);
  assert.equal(findCells(ranges, "alpha", { exact: true, maxResults: 10 }).hits.length, 2);

  const capped = findCells(ranges, "alpha", { maxResults: 2 });
  assert.equal(capped.hits.length, 2);
  assert.equal(capped.truncated, true);
});

test("a range wider than the whole cap still shows its first row", () => {
  // 6000 columns is a legal Sheets range and more than MAX_CELLS by itself.
  // "showing 0 of 3 rows" would be true and useless.
  const wide = Array.from({ length: 3 }, () => Array.from({ length: 6000 }, () => "x"));
  const rendered = renderValueRange({ range: "'Wide'!A1", values: wide });
  assert.equal(rendered.rows, 1);
  assert.equal(rendered.truncated, true);
});
