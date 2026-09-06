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
 * That is measured against the sandbox, and it is the reason every date filter
 * on this server was broken: an ISO-8601 instant is four colons long, so
 * `occurred_after`, `occurred_before`, `updated_after` and `updated_before` each
 * sent a term BILL rejected outright. A merchant name containing a colon fails
 * the same way, for the same reason.
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
 * the answer. It moves each bound a day OUTWARD, which is wider than any zone
 * offset, and the window this server asks BILL for can therefore only be too
 * wide, never too narrow. Too wide is a row a caller can see and discard against
 * its own `occurred_time`; too narrow is a transaction nobody learns about.
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
 * The `yyyy-MM-dd` BILL accepts for a time field, widened a day outward.
 *
 * The instant the caller asked for is always INSIDE the window this returns,
 * whatever zone BILL resolves the date in. See the header for the measurements.
 */
export function billFilterDate(instant: string, bound: Bound): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    // Unreachable through the tools — `isoInstant` parses first — and cheap
    // insurance against a future caller handing this a string BILL would 400 on.
    throw new InputError(`"${instant}" is not a date-time.`);
  }
  const shifted = new Date(ms + (bound === "from" ? -DAY_MS : DAY_MS));
  return shifted.toISOString().slice(0, 10);
}

/**
 * One `{field}:{gte|lte}:{yyyy-MM-dd}` term for a time field.
 *
 * `gte` and `lte` are the only two operators BILL supports on `occurredTime` and
 * `updatedTime`, which is why the bound picks the operator rather than the
 * caller.
 */
export function dateFilterTerm(
  field: string,
  bound: Bound,
  instant: string,
): string {
  return `${field}:${bound === "from" ? "gte" : "lte"}:${billFilterDate(instant, bound)}`;
}
