import {
  args,
  boundedInt,
  guard,
  ok,
  optionalBool,
  optionalString,
  requiredString,
  FIELD_DESCRIPTION,
  type GatewayFactory,
  type ToolDefinition,
} from "./shared.js";

// Five pages of 100 per walk, and `fetchValues` may walk twice for retired
// values — so at most ten of the sixty calls a minute inside one tool call.
// `paginate`'s own bound exists to stop a single call eating the budget.
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

/**
 * The legal values of one coding field — the chart of accounts, as BILL carries
 * it.
 *
 * THE `id` IS WHY THIS TOOL EXISTS IN THIS SHAPE. Every other read in this
 * server can get away with returning a `uuid`; this one returns the base64 `id`
 * beside it, because the `id` is the form `set_transaction_coding` sends first
 * and the form its ladder's first rung needs. Both forms were measured to
 * persist, so a `uuid` is not a silent failure — but a caller taking a value's
 * `uuid` out of a `list_transactions` result has skipped the catalog lookup that
 * refuses an id belonging to the WRONG field, which is the likeliest real cause
 * of a write BILL answers 200 to and drops. See wire.ts.
 *
 * BILL marks `id` DEPRECATED in its own schema, which is worth knowing and does
 * not change the recommendation: it is what the write sends first, and this is
 * the only endpoint that hands it out beside the uuid.
 */
export function listCodingOptionsTool(gateway: GatewayFactory): ToolDefinition {
  return {
    name: "list_coding_options",
    description:
      "The values a coding field can be set to — for a GL field, this is the " +
      "chart of accounts as BILL holds it. Call this before every write: " +
      "set_transaction_coding takes value IDS from here, never account names.\n\n" +
      'Example: {"field":"Y3VzdG9tZmllbGQ6MTIz","options":[' +
      '{"id":"Y3VzdG9tZmllbGR2YWx1ZTo0NTY","uuid":"tvl_9z8y7x",' +
      '"value":"Internet/Phone"}],"returned":1}\n\n' +
      "PASS THE `id` to set_transaction_coding. BILL's write endpoint accepts " +
      "the uuid form too — that was measured, not assumed — so a uuid is not a " +
      "silent failure; the `id` is simply the form the write sends first. What " +
      "matters more is that the value belongs to THIS field: an id from a " +
      "different custom field is accepted by the write endpoint and then " +
      "discarded, so call this tool for the exact field you are about to " +
      "write.\n\n" +
      "What you get is the display string and nothing else. BILL returns no " +
      "account number, no account type, and no link back to the QuickBooks or " +
      "NetSuite account these values were imported from, so a merchant can be " +
      "mapped to a label but the account structure cannot be reasoned about.",
    inputSchema: {
      type: "object",
      properties: {
        field: { type: "string", description: FIELD_DESCRIPTION },
        query: {
          type: "string",
          description:
            'Case-insensitive substring of the value, e.g. "internet". ' +
            "Matched locally over what BILL returned, so pair it with a " +
            "generous `limit` on a long chart of accounts.",
        },
        include_retired: {
          type: "boolean",
          description:
            "Include retired values. Default: false — a retired value should " +
            "not be coded to, and including them costs a second call.",
        },
        limit: {
          type: "integer",
          description:
            `How many values to return (1-${MAX_LIMIT}). Default: ${DEFAULT_LIMIT}. ` +
            "BILL pages these 100 at a time, so a large number is several calls " +
            "against a 60-calls-per-minute budget.",
        },
      },
      required: ["field"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const field = requiredString(input, "field");
        const query = optionalString(input, "query");
        const { options, truncated } = await (
          await gateway()
        ).listCodingOptions({
          field,
          limit: boundedInt(input, "limit", DEFAULT_LIMIT, MAX_LIMIT),
          include_retired: optionalBool(input, "include_retired") ?? false,
          ...(query === undefined ? {} : { query }),
        });
        return ok({
          field,
          options,
          returned: options.length,
          ...(truncated ? { truncated: true } : {}),
        });
      }),
  };
}
