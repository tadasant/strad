import { InputError } from "../errors.js";
import { dateFilterTerm, filterValue } from "../filters.js";
import {
  args,
  boundedInt,
  guard,
  isoInstant,
  ok,
  optionalBool,
  optionalString,
  type GatewayFactory,
  type ToolDefinition,
} from "./shared.js";

/** BILL's own ceiling on this endpoint. Asking for more is a 400. */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

const TRANSACTION_TYPES = ["CLEAR", "AUTHORIZATION", "DECLINE", "OTHER"];

const SORTS = [
  "occurredTime:desc",
  "occurredTime:asc",
  "amount:desc",
  "amount:asc",
  "merchantName:asc",
  "merchantName:desc",
];

/** Refuse a window whose end precedes its start, naming both values. */
function assertOrdered(
  fromKey: string,
  from: string | undefined,
  toKey: string,
  to: string | undefined,
): void {
  if (from === undefined || to === undefined) return;
  if (Date.parse(from) <= Date.parse(to)) return;
  throw new InputError(
    `\`${fromKey}\`="${from}" is after \`${toKey}\`="${to}", so the window ` +
      `is empty. Swap them, or drop one.`,
  );
}

/**
 * The transactions to work on, and the state each one is already in.
 *
 * TWO FIELDS DECIDE WHETHER A SWEEP IS SAFE, and both are surfaced: `is_locked`
 * (BILL refuses a coding change on a locked transaction) and the current
 * `custom_fields`, so a caller can tell what is already coded correctly from
 * what is not without spending a read per transaction.
 *
 * `updated_after` is what makes an incremental sweep possible: run it, remember
 * the newest `updated_time` you saw, pass it back next time.
 */
export function listTransactionsTool(gateway: GatewayFactory): ToolDefinition {
  return {
    name: "list_transactions",
    description:
      "Card transactions in this BILL Spend & Expense company, newest first, " +
      "with the coding each one currently carries and whether it can still be " +
      "changed. This is what a re-coding sweep reads.\n\n" +
      'Example: {"transactions":[{"uuid":"txn_1a2b","occurred_time":' +
      '"2026-09-02T17:04:00Z","amount":89.99,"merchant_name":"Comcast",' +
      '"merchant_category_code":"4899","is_locked":false,"status":"CLEARED",' +
      '"transaction_type":"CLEAR","custom_fields":[{"uuid":"tty_1a2b3c",' +
      '"name":"GL Account","selected_values":[{"uuid":"tvl_9z8y",' +
      '"value":"Internet/Phone"}]}]}],"returned":1,"next_cursor":"eyJ…"}\n\n' +
      "FOR AN INCREMENTAL SWEEP, pass `updated_after` and remember the newest " +
      "`updated_time` you saw; next run starts there. Page with `cursor` from " +
      "`next_cursor` — BILL caps this endpoint at 50 per page and the whole " +
      "token is limited to 60 calls a minute.\n\n" +
      "DATE FILTERS ARE DAY-GRANULAR and the window comes back WIDER than you " +
      "ask for: BILL takes only `yyyy-MM-dd` on a time field and reads it as " +
      "that day's START, so each bound is rounded outward to whole days. " +
      "`filters_applied` is what was actually sent. Rows outside your instant " +
      "can appear; none inside it are dropped. Narrow against each row's own " +
      "`occurred_time` if you need the instant rather than the day.\n\n" +
      "REVIEW STATUS IS NOT SETTABLE through this API — no endpoint does it, so " +
      "a sweep that re-codes transactions cannot also tick them off; a human " +
      "does that in the BILL web app. `is_reviewed` filters but is not returned " +
      "on a row, so it says what to skip, not what you have.\n\n" +
      "`is_locked: true` means BILL will refuse a coding change on that " +
      "transaction; filter them out with `is_locked: false` rather than " +
      "discovering it one write at a time.\n\n" +
      "The `uuid` inside `custom_fields` is the ONLY identifier form this " +
      "endpoint returns — there are no base64 `id`s here. Do not write from " +
      "these: get the value ids from list_coding_options, which returns both.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: `How many transactions (1-${MAX_LIMIT}, BILL's own cap). Default: ${DEFAULT_LIMIT}.`,
        },
        cursor: {
          type: "string",
          description:
            "The `next_cursor` from a previous result, to fetch the next page. " +
            "Omit for the first page. A result with no `next_cursor` is the last.",
        },
        updated_after: {
          type: "string",
          description:
            "Only transactions changed at or after this time. A date " +
            '("2026-09-01") or a full ISO-8601 instant ("2026-09-01T00:00:00Z") ' +
            "— BILL filters BY DAY, so an instant is rounded outward, never in. " +
            "This is the incremental-sweep filter: it catches a transaction " +
            "whose coding or status changed since the last run, not just " +
            "newly-occurred ones.",
        },
        updated_before: {
          type: "string",
          description:
            "Only transactions changed at or before this time (date or ISO-8601 " +
            "instant, rounded outward to whole days).",
        },
        occurred_after: {
          type: "string",
          description:
            "Only purchases made at or after this time (date or ISO-8601 " +
            "instant, rounded outward to whole days). Use this for a " +
            "date-bounded backfill; use `updated_after` for a sweep.",
        },
        occurred_before: {
          type: "string",
          description:
            "Only purchases made at or before this time (date or ISO-8601 " +
            "instant, rounded outward to whole days).",
        },
        is_locked: {
          type: "boolean",
          description:
            "Restrict to locked (true) or unlocked (false) transactions. Pass " +
            "false to see only what can still be re-coded. Omit for both.",
        },
        is_reviewed: {
          type: "boolean",
          description:
            "Restrict to transactions a human has (true) or has not (false) " +
            "marked reviewed in the BILL web app. Pass false to see only what " +
            "still needs a look. BILL FILTERS ON THIS AND DOES NOT RETURN IT, " +
            "so a row in the result does not say which side it fell on, and " +
            "nothing in this API can SET it — see the tool description.",
        },
        merchant_name: {
          type: "string",
          description:
            'Exact merchant name, e.g. "Comcast" — BILL matches this with `eq`, ' +
            "not a substring. Use the `merchant_name` from a previous result. A " +
            "name containing a comma or a colon is refused: BILL's filter " +
            "grammar is split on both and has no escape.",
        },
        transaction_type: {
          type: "string",
          enum: TRANSACTION_TYPES,
          description:
            "CLEAR (settled — the usual thing to code), AUTHORIZATION (pending " +
            "or a reversal), DECLINE (never happened), OTHER. Omit for all.",
        },
        sort: {
          type: "string",
          enum: SORTS,
          description: `Order the results. Default: ${SORTS[0]}.`,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);

        // Composed here, one `{field}:{op}:{value}` term per argument, and the
        // gateway joins them with commas — which is exactly the grammar BILL
        // documents. The composition is deliberately NOT exposed as a
        // pass-through `filters` string: this token is unscoped ADMIN, and a
        // free-text filter parameter is a surface an agent can put anything into.
        //
        // Every value that reaches a term goes through `filters.ts`, which owns
        // the one rule the grammar has: `,` and `:` are structural and have no
        // escape. A time field additionally collapses to the `yyyy-MM-dd` BILL
        // accepts, widened outward so the window can only be too wide.
        const filters: string[] = [];
        const updatedAfter = isoInstant(input, "updated_after");
        const updatedBefore = isoInstant(input, "updated_before");
        const occurredAfter = isoInstant(input, "occurred_after");
        const occurredBefore = isoInstant(input, "occurred_before");
        // AN INVERTED WINDOW IS REFUSED, not sent. BILL answers one with zero
        // rows, which is indistinguishable from "nothing matched" — and once the
        // bounds are widened it can answer with a WIDE result instead, which is
        // worse. Both are a caller reading the wrong thing about somebody's
        // books and being told nothing went wrong.
        assertOrdered("updated_after", updatedAfter, "updated_before", updatedBefore);
        assertOrdered(
          "occurred_after",
          occurredAfter,
          "occurred_before",
          occurredBefore,
        );

        if (updatedAfter)
          filters.push(
            dateFilterTerm("updated_after", "updatedTime", "from", updatedAfter),
          );
        if (updatedBefore)
          filters.push(
            dateFilterTerm("updated_before", "updatedTime", "to", updatedBefore),
          );
        if (occurredAfter)
          filters.push(
            dateFilterTerm(
              "occurred_after",
              "occurredTime",
              "from",
              occurredAfter,
            ),
          );
        if (occurredBefore)
          filters.push(
            dateFilterTerm(
              "occurred_before",
              "occurredTime",
              "to",
              occurredBefore,
            ),
          );

        const isLocked = optionalBool(input, "is_locked");
        if (isLocked !== undefined) filters.push(`isLocked:eq:${isLocked}`);

        // The ONLY review-related thing this API offers. BILL filters on
        // `isReviewed` and does not return it on a transaction, and there is no
        // endpoint that sets it — see the tool description.
        const isReviewed = optionalBool(input, "is_reviewed");
        if (isReviewed !== undefined) filters.push(`isReviewed:eq:${isReviewed}`);

        const merchant = optionalString(input, "merchant_name");
        if (merchant !== undefined) {
          filters.push(`merchantName:eq:${filterValue("merchant_name", merchant)}`);
        }

        const type = optionalString(input, "transaction_type");
        if (type !== undefined) {
          if (!TRANSACTION_TYPES.includes(type)) {
            throw new InputError(
              `\`transaction_type\`="${type}" is not a BILL transaction type. ` +
                `Use one of: ${TRANSACTION_TYPES.join(", ")}.`,
            );
          }
          filters.push(`transactionType:eq:${type}`);
        }

        const sort = optionalString(input, "sort") ?? SORTS[0]!;
        if (!SORTS.includes(sort)) {
          throw new InputError(
            `\`sort\`="${sort}" is not a supported ordering. Use one of: ` +
              `${SORTS.join(", ")}.`,
          );
        }

        const cursor = optionalString(input, "cursor");
        const result = await (
          await gateway()
        ).listTransactions({
          limit: boundedInt(input, "limit", DEFAULT_LIMIT, MAX_LIMIT),
          filters,
          sort,
          ...(cursor === undefined ? {} : { cursor }),
        });
        // THE WINDOW ACTUALLY ASKED FOR, verbatim, because it is not the one the
        // caller named: a date filter is rounded outward to whole days. A caller
        // that needs the exact instant it asked for narrows the rows itself
        // against their own `occurred_time` / `updated_time`, and this is what
        // tells it that it has to.
        return ok({
          ...result,
          returned: result.transactions.length,
          ...(filters.length > 0 ? { filters_applied: filters } : {}),
        });
      }),
  };
}
