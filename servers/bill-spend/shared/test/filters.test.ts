import { describe, expect, it } from "vitest";

import { billFilterDate, dateFilterTerm, filterValue } from "../src/filters.js";

/** BILL resolves a filter date in a zone it does not name; this is every one. */
const OFFSETS_HOURS = Array.from({ length: 27 }, (_, i) => i - 12);

/** The instant BILL compares against, for a `yyyy-MM-dd` read in zone `offset`. */
function midnightAt(date: string, offsetHours: number): number {
  return Date.parse(`${date}T00:00:00Z`) - offsetHours * 3_600_000;
}

/**
 * BILL's filter grammar in isolation: what a value may contain, and what an
 * instant collapses to. The tool-level assertions are in `test/tools.test.ts`;
 * these are the arithmetic and the rule.
 */

describe("filterValue", () => {
  it("passes a value with neither separator through unchanged", () => {
    expect(filterValue("merchant_name", "Comcast")).toBe("Comcast");
  });

  it("names the character, so the caller knows which one to remove", () => {
    expect(() => filterValue("merchant_name", "Acme, Inc")).toThrow(/comma/);
    expect(() => filterValue("merchant_name", "Foo: Bar")).toThrow(/colon/);
  });

  it("refuses rather than dropping the filter, because a dropped filter widens the read", () => {
    // The alternative — sending it anyway, or silently omitting the term — turns
    // "this one merchant" into "every transaction", reported as a narrow read.
    expect(() => filterValue("merchant_name", "A:B")).toThrow(/cannot be escaped/);
  });
});

describe("billFilterDate", () => {
  it("reduces an instant to the yyyy-MM-dd BILL's time fields accept", () => {
    expect(billFilterDate("occurred_after", "2026-09-06T06:03:37.000Z", "from")).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("moves a lower bound a day back and an upper bound two days on", () => {
    // The sizes differ because flooring to a day has ALREADY moved the bound
    // backwards by its time of day — the safe direction for `from` and the
    // dangerous one for `to`. See the property test below, which is what makes
    // these two numbers the right ones rather than merely the current ones.
    expect(billFilterDate("k", "2026-09-06T12:00:00Z", "from")).toBe("2026-09-05");
    expect(billFilterDate("k", "2026-09-06T12:00:00Z", "to")).toBe("2026-09-08");
  });

  it("floors to the UTC day, so the shift does not vary with the time of day", () => {
    for (const time of ["00:00:00", "06:03:37", "23:59:59"]) {
      expect(billFilterDate("k", `2026-09-06T${time}Z`, "from")).toBe("2026-09-05");
      expect(billFilterDate("k", `2026-09-06T${time}Z`, "to")).toBe("2026-09-08");
    }
  });

  it("crosses a month and a year boundary correctly", () => {
    expect(billFilterDate("k", "2026-09-01T00:00:00Z", "from")).toBe("2026-08-31");
    expect(billFilterDate("k", "2026-08-31T23:59:59Z", "to")).toBe("2026-09-02");
    expect(billFilterDate("k", "2026-01-01T00:00:00Z", "from")).toBe("2025-12-31");
    expect(billFilterDate("k", "2026-12-31T23:59:59Z", "to")).toBe("2027-01-02");
  });

  it("brackets the caller's instant at EVERY hour and EVERY zone offset", () => {
    // THE PROPERTY THE WHOLE DESIGN RESTS ON, and the one an earlier revision
    // got wrong: a single day on the upper bound leaves 2026-09-06T23:00Z
    // bounded by midnight on the 7th — one hour of margin, which any zone east
    // of UTC eats. Checked over the day rather than at one instant, because one
    // instant is exactly what failed to catch it.
    const violations: string[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const instant = `2026-09-06T${String(hour).padStart(2, "0")}:30:00Z`;
      const asked = Date.parse(instant);
      const from = billFilterDate("k", instant, "from");
      const to = billFilterDate("k", instant, "to");
      for (const offset of OFFSETS_HOURS) {
        if (midnightAt(from, offset) > asked) {
          violations.push(`gte:${from} misses ${instant} at UTC${offset}`);
        }
        if (midnightAt(to, offset) < asked) {
          violations.push(`lte:${to} misses ${instant} at UTC${offset}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("refuses a date BILL could not render, rather than sending an odd one", () => {
    // `toISOString` renders a year outside 0000-9999 as `+275760-09-13`, which
    // carries neither separator and would sail past every other guard here.
    expect(() =>
      billFilterDate("occurred_after", "+275760-09-13T00:00:00.000Z", "from"),
    ).toThrow(/occurred_after/);
    // And the `to` shift pushes that same instant out of Date's range entirely,
    // which would otherwise be a bare RangeError naming nothing.
    expect(() =>
      billFilterDate("occurred_before", "+275760-09-13T00:00:00.000Z", "to"),
    ).toThrow(/occurred_before/);
  });
});

describe("dateFilterTerm", () => {
  it("picks the only two operators BILL supports on a time field", () => {
    // `gt`, `lt`, `eq`, `in` and `isnull` are each a 400 naming the operator.
    expect(
      dateFilterTerm("occurred_after", "occurredTime", "from", "2026-09-06T00:00:00Z"),
    ).toBe("occurredTime:gte:2026-09-05");
    expect(
      dateFilterTerm("updated_before", "updatedTime", "to", "2026-09-06T00:00:00Z"),
    ).toBe("updatedTime:lte:2026-09-08");
  });
});
