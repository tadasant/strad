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

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

/**
 * The legal values of one coding field — the chart of accounts, as BILL carries
 * it.
 *
 * THE `id` IS WHY THIS TOOL EXISTS IN THIS SHAPE. Every other read in this
 * server can get away with returning a `uuid`; this one must return the base64
 * `id` beside it, because the `id` is the form `set_transaction_coding` sends
 * first, and it is the only form anyone has reported the write endpoint actually
 * honouring. A caller that takes a value's `uuid` out of a `list_transactions`
 * result and writes with it is walking straight into the 200-SUCCESS-and-nothing-
 * happened failure. See wire.ts.
 *
 * BILL marks `id` DEPRECATED in its own schema, which is worth knowing and does
 * not change the recommendation: a deprecated field that writes beats a current
 * one that is silently dropped, and the write path tries both regardless.
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
      "PASS THE `id`, not the `uuid`, to set_transaction_coding. BILL's write " +
      "endpoint documents both as acceptable and is reported to accept the uuid " +
      "form, answer SUCCESS, and discard the update. The write verifies itself " +
      "by re-reading either way, so a uuid costs you retries rather than " +
      "silence — but the `id` is the one to send.\n\n" +
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
