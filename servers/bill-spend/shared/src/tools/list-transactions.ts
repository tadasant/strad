import { InputError } from "../errors.js";
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
            "Only transactions changed at or after this instant, ISO-8601 with " +
            'a zone, e.g. "2026-09-01T00:00:00Z". This is the incremental-sweep ' +
            "filter: it catches a transaction whose coding or status changed " +
            "since the last run, not just newly-occurred ones.",
        },
        updated_before: {
          type: "string",
          description: "Only transactions changed at or before this instant (ISO-8601).",
        },
        occurred_after: {
          type: "string",
          description:
            "Only purchases made at or after this instant (ISO-8601). Use this " +
            "for a date-bounded backfill; use `updated_after` for a sweep.",
        },
        occurred_before: {
          type: "string",
          description: "Only purchases made at or before this instant (ISO-8601).",
        },
        is_locked: {
          type: "boolean",
          description:
            "Restrict to locked (true) or unlocked (false) transactions. Pass " +
            "false to see only what can still be re-coded. Omit for both.",
        },
        merchant_name: {
          type: "string",
          description:
            'Exact merchant name, e.g. "Comcast" — BILL matches this with `eq`, ' +
            "not a substring. Use the `merchant_name` from a previous result.",
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
        const filters: string[] = [];
        const updatedAfter = isoInstant(input, "updated_after");
        const updatedBefore = isoInstant(input, "updated_before");
        const occurredAfter = isoInstant(input, "occurred_after");
        const occurredBefore = isoInstant(input, "occurred_before");
        if (updatedAfter) filters.push(`updatedTime:gte:${updatedAfter}`);
        if (updatedBefore) filters.push(`updatedTime:lte:${updatedBefore}`);
        if (occurredAfter) filters.push(`occurredTime:gte:${occurredAfter}`);
        if (occurredBefore) filters.push(`occurredTime:lte:${occurredBefore}`);

        const isLocked = optionalBool(input, "is_locked");
        if (isLocked !== undefined) filters.push(`isLocked:eq:${isLocked}`);

        const merchant = optionalString(input, "merchant_name");
        if (merchant !== undefined) {
          // A comma is the term separator in BILL's filter grammar, so a
          // merchant name containing one would split into two malformed terms —
          // and a malformed term BILL ignores is a filter that silently does
          // nothing, which is the failure this whole tool is careful about.
          if (merchant.includes(",")) {
            throw new InputError(
              `\`merchant_name\`="${merchant}" contains a comma, which is the ` +
                `separator in BILL's filter syntax and cannot be escaped. ` +
                `Filter by date instead and match the name in the results.`,
            );
          }
          filters.push(`merchantName:eq:${merchant}`);
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
        return ok({ ...result, returned: result.transactions.length });
      }),
  };
}
