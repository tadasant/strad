import {
  args,
  boundedInt,
  guard,
  ok,
  optionalBool,
  optionalString,
  type GatewayFactory,
  type ToolDefinition,
} from "./shared.js";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * The entry point of this server: which custom field carries the coding.
 *
 * It exists because BILL's model is not the one anybody expects. There is no
 * `glAccount` on a Spend & Expense transaction and no `chartOfAccounts`
 * endpoint that this token can reach — coding lives on a CUSTOM FIELD, and which
 * field that is differs per company. So the first thing any caller has to do is
 * find out, and the answer has to come from the API rather than from a constant
 * baked into this server.
 */
export function listCodingFieldsTool(gateway: GatewayFactory): ToolDefinition {
  return {
    name: "list_coding_fields",
    description:
      "The custom fields this BILL Spend & Expense company tags transactions " +
      "with. START HERE: BILL has no native chart-of-accounts field, so GL " +
      "coding is carried on one of these, and the `id`/`uuid` in the result is " +
      "what list_coding_options and set_transaction_coding take as `field`.\n\n" +
      'Example: {"fields":[{"id":"Y3VzdG9tZmllbGQ6MTIz","uuid":"tty_1a2b3c",' +
      '"name":"GL Account","type":"CUSTOM_SELECTOR","multi_select":false,' +
      '"required":true,"applies_to_all_budgets":true,"likely_coding_field":true}],' +
      '"returned":1}\n\n' +
      "`type` is one of: CUSTOM_SELECTOR (pick from a list of values — this is " +
      "what a chart of accounts looks like) or NOTE (free text). Those are the " +
      "only two BILL defines; there is NO GL-account type and nothing in the " +
      "payload says a field's values came from an accounting integration.\n\n" +
      "`likely_coding_field` is therefore a GUESS made from the field's name, " +
      "not something BILL told us. Confirm the field by looking at its values " +
      "with list_coding_options — the GL field is the one whose values are " +
      'account names like "Internet/Phone".',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Case-insensitive substring of the field name, e.g. "account". ' +
            "Matched locally over what BILL returned, so it narrows this " +
            "page rather than searching the whole company.",
        },
        include_retired: {
          type: "boolean",
          description:
            "Include retired fields. Default: false — a retired field cannot " +
            "be used for new coding, and including them costs a second call.",
        },
        limit: {
          type: "integer",
          description: `How many fields to return (1-${MAX_LIMIT}). Default: ${DEFAULT_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const query = optionalString(input, "query");
        const { fields, truncated } = await (
          await gateway()
        ).listCodingFields({
          limit: boundedInt(input, "limit", DEFAULT_LIMIT, MAX_LIMIT),
          include_retired: optionalBool(input, "include_retired") ?? false,
          ...(query === undefined ? {} : { query }),
        });
        return ok({
          fields,
          returned: fields.length,
          // Said rather than implied. A caller that reads a truncated list and
          // concludes the GL field does not exist is the failure this prevents.
          ...(truncated ? { truncated: true } : {}),
        });
      }),
  };
}
