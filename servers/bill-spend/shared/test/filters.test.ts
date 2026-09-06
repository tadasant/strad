import { describe, expect, it } from "vitest";

import { billFilterDate, dateFilterTerm, filterValue } from "../src/filters.js";

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
    expect(billFilterDate("2026-09-06T06:03:37.000Z", "from")).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("moves a lower bound back a day and an upper bound forward a day", () => {
    expect(billFilterDate("2026-09-06T12:00:00Z", "from")).toBe("2026-09-05");
    expect(billFilterDate("2026-09-06T12:00:00Z", "to")).toBe("2026-09-07");
  });

  it("crosses a month and a year boundary correctly", () => {
    expect(billFilterDate("2026-09-01T00:00:00Z", "from")).toBe("2026-08-31");
    expect(billFilterDate("2026-08-31T23:59:59Z", "to")).toBe("2026-09-01");
    expect(billFilterDate("2026-01-01T00:00:00Z", "from")).toBe("2025-12-31");
    expect(billFilterDate("2026-12-31T23:59:59Z", "to")).toBe("2027-01-01");
  });

  it("brackets the caller's instant whatever zone BILL resolves the date in", () => {
    // The widening exists because BILL does not document the zone its midnight
    // is in. A day either way is wider than any zone offset, so the instant is
    // inside the window under every one of them.
    const instant = "2026-09-06T06:03:37.000Z";
    const from = Date.parse(`${billFilterDate(instant, "from")}T00:00:00Z`);
    const to = Date.parse(`${billFilterDate(instant, "to")}T00:00:00Z`);
    const asked = Date.parse(instant);
    const maxOffsetMs = 14 * 60 * 60 * 1000;
    expect(from + maxOffsetMs).toBeLessThanOrEqual(asked);
    expect(to - maxOffsetMs).toBeGreaterThanOrEqual(asked);
  });
});

describe("dateFilterTerm", () => {
  it("picks the only two operators BILL supports on a time field", () => {
    // `gt`, `lt`, `eq`, `in` and `isnull` are each a 400 naming the operator.
    expect(dateFilterTerm("occurredTime", "from", "2026-09-06T00:00:00Z")).toBe(
      "occurredTime:gte:2026-09-05",
    );
    expect(dateFilterTerm("updatedTime", "to", "2026-09-06T00:00:00Z")).toBe(
      "updatedTime:lte:2026-09-07",
    );
  });
});
