/**
 * BILL's `filters` grammar, and the two characters that have no escape in it.
 *
 * The whole grammar is `filters={field}:{op}:{value},{field}:{op}:{value}` —
 * positional, split on `:` and `,`, with NO quoting and NO escape sequence. So a
 * VALUE containing either separator does not produce a filter BILL reads
 * differently; it produces a filter BILL cannot parse at all:
 *
 *     filters=occurredTime:gte:2026-09-01T00:00:00Z
 *     -> 422 "Invalid filter request format. Expect (field:operator:value)."
 *
 * An ISO-8601 instant is four colons long, so no date filter can be expressed as
 * an instant. A merchant name carrying a colon fails identically.
 *
 * WHAT BILL ACCEPTS FOR A TIME FIELD IS A BARE DATE, `yyyy-MM-dd`, and nothing
 * finer. Measured across the alternatives: an ISO instant is a 422; a
 * percent-encoded instant, epoch seconds, epoch millis, `2026/09/01`,
 * `09-01-2026` and `2026-9-1` are each a 400 naming the value; and the only
 * operators `occurredTime` and `updatedTime` accept are `gte` and `lte` — `gt`,
 * `lt`, `eq`, `in` and `isnull` are each a 400 naming the operator.
 *
 * A DATE MEANS THE INSTANT IT STARTS AT, not the day it covers. Also measured:
 * against a company whose transactions all occurred at 2026-09-06T06:03Z,
 * `occurredTime:lte:2026-09-06` matched NOTHING and `occurredTime:lte:2026-09-07`
 * matched all of them. So `lte:D` is `<= D 00:00`, which EXCLUDES the whole of
 * day D — the off-by-one that silently drops a sweep's most recent day.
 *
 * WHICH ZONE THAT MIDNIGHT IS IN, BILL DOES NOT DOCUMENT, and measuring it
 * against one company would not settle it for another — a Spend & Expense
 * company has its own locale, so the boundary is a per-company fact this server
 * cannot carry. (The sandbox's own data cannot even settle the sandbox: its
 * transactions share one timestamp, three minutes from the only boundary that
 * separates UTC from US Mountain.) So the conversion below does not depend on
 * the answer. Each bound is floored to its UTC day and then moved far enough
 * outward that the caller's instant is inside the window under EVERY zone
 * offset, and the window this server asks BILL for can therefore only be too
 * wide, never too narrow. Too wide is a row a caller can see and discard against
 * its own `occurred_time`; too narrow is a transaction nobody learns about.
 *
 * THE TWO SHIFTS ARE NOT THE SAME SIZE, and the asymmetry is the whole
 * correctness argument rather than a wart. Flooring to a day already moves a
 * bound BACKWARDS by the instant's time of day — which is the safe direction for
 * a lower bound and the dangerous one for an upper bound. So a lower bound needs
 * one whole day beyond the floor and an upper bound needs two: a single day
 * would leave `2026-09-06T23:00Z` bounded by midnight on the 7th, one hour of
 * margin, which any zone east of UTC eats. `SHIFT_DAYS` states the sizes and
 * `test/filters.test.ts` checks the property across every hour of the day and
 * every offset from UTC-12 to UTC+14.
 */

import { InputError } from "./errors.js";

/** `,` separates terms, `:` separates a term's parts. Neither can be escaped. */
const SEPARATORS: Array<{ char: string; name: string; role: string }> = [
  { char: ",", name: "comma", role: "separates one filter term from the next" },
  {
    char: ":",
    name: "colon",
    role: "separates a term's field, operator and value",
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which end of a range a date bound is, and therefore which way to widen it. */
export type Bound = "from" | "to";

/**
 * Whole days to move each bound past the UTC day it floors to. See the header:
 * the flooring is what makes the two numbers differ, and the widest zone offset
 * in existence (UTC+14) is what makes `to` two rather than one.
 */
const SHIFT_DAYS: Record<Bound, number> = { from: -1, to: 2 };

/** BILL's only two operators on a time field. */
const OPERATOR: Record<Bound, string> = { from: "gte", to: "lte" };

/**
 * A value safe to splice into a filter term, or an error naming the trap.
 *
 * REFUSED RATHER THAN SENT, because of the two ways BILL can fail this. A term
 * it cannot parse is a 422 and the caller learns something. A term it parses
 * WRONG — which is what a comma produces, by splitting one term into two — is a
 * filter that quietly matches something else, and this server's whole posture is
 * that a silently wrong read of somebody's books is the worst answer available.
 */
export function filterValue(key: string, value: string): string {
  for (const { char, name, role } of SEPARATORS) {
    if (value.includes(char)) {
      throw new InputError(
        `\`${key}\`="${value}" contains a ${name} ("${char}"), which ${role} ` +
          `in BILL's filter syntax and cannot be escaped. Filter by date ` +
          `instead and match the value in the results.`,
      );
    }
  }
  return value;
}

/**
 * The `yyyy-MM-dd` BILL accepts for a time field, widened outward.
 *
 * The instant the caller asked for is always INSIDE the window this returns,
 * whatever zone BILL resolves the date in. See the header for the measurements.
 */
export function billFilterDate(
  key: string,
  instant: string,
  bound: Bound,
): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    // Unreachable through the tools — `isoInstant` parses first — and cheap
    // insurance against a future caller handing this a string BILL would 400 on.
    throw new InputError(`\`${key}\`="${instant}" is not a date-time.`);
  }
  // Floor to the UTC day, then move whole days. Shifting the INSTANT instead
  // would make the size of the move depend on its time of day, which is the
  // bug this arithmetic is written to avoid.
  const day = Math.floor(ms / DAY_MS) + SHIFT_DAYS[bound];
  const date = new Date(day * DAY_MS);
  const rendered = Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 10)
    : "";
  // `toISOString` renders a year outside 0000-9999 in an expanded `+275760`
  // form, and throws outright once the shift leaves the representable range.
  // Either would reach BILL as a value it answers 400 to, in an error naming
  // neither the parameter nor what was wrong with it.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rendered)) {
    throw new InputError(
      `\`${key}\`="${instant}" is outside the range of dates BILL can filter ` +
        `on. Use a date between 0001-01-01 and 9999-12-31.`,
    );
  }
  return rendered;
}

/**
 * One `{field}:{gte|lte}:{yyyy-MM-dd}` term for a time field.
 *
 * `gte` and `lte` are the only two operators BILL supports on `occurredTime` and
 * `updatedTime`, which is why the bound picks the operator rather than the
 * caller.
 */
export function dateFilterTerm(
  key: string,
  field: string,
  bound: Bound,
  instant: string,
): string {
  return `${field}:${OPERATOR[bound]}:${billFilterDate(key, instant, bound)}`;
}
