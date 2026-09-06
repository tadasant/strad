import {
  args,
  guard,
  ok,
  requiredString,
  type GatewayFactory,
  type ToolDefinition,
} from "./shared.js";

/**
 * The verification primitive, and the tool `set_transaction_coding` is built out
 * of.
 *
 * It reads `GET /v3/spend/transactions/{id}/custom-fields`, which is the ONE
 * endpoint that returns both identifier forms for both the field and its
 * selected values — `list_transactions` carries uuids only. That is what makes
 * it the read-back: a diff that could only see one form could not tell a write
 * that landed from a write that was discarded.
 *
 * It also reads `isLocked` off the transaction itself, because the coding
 * endpoint does not carry it and "here is the coding" without "and you cannot
 * change it" sends a caller into a refusal it could have known about.
 */
export function getTransactionCodingTool(
  gateway: GatewayFactory,
): ToolDefinition {
  return {
    name: "get_transaction_coding",
    description:
      "The full coding of ONE transaction — every custom field that applies to " +
      "it, what is currently selected, and whether the transaction can still be " +
      "changed. Use it to verify a write, to see which fields a transaction " +
      "actually offers, or to get a field's base64 `id` before writing.\n\n" +
      'Example: {"transaction_id":"txn_1a2b","is_locked":false,"writable":true,' +
      '"fields":[{"id":"Y3VzdG9tZmllbGQ6MTIz","uuid":"tty_1a2b3c",' +
      '"name":"GL Account","is_required":true,"selected_values":[' +
      '{"id":"Y3VzdG9tZmllbGR2YWx1ZTo0NTY","uuid":"tvl_9z8y","value":"Internet/Phone"}]}]}\n\n' +
      "`writable: false` means BILL will refuse a coding change (the " +
      "transaction is locked, usually because an accounting sync already " +
      "exported it). Only a human can unlock it, in the BILL web app.\n\n" +
      "A field that is missing from `fields` does not apply to this " +
      "transaction's budget. Writing to it is accepted by BILL and then " +
      "discarded, so check here first when a write reports that nothing changed.\n\n" +
      "Unlike list_transactions, this returns BOTH the base64 `id` and the " +
      "`uuid` for every field and value — which is why it is the read this " +
      "server verifies writes against.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: {
          type: "string",
          description:
            "The transaction's `uuid` (or base64 `id`) from list_transactions.",
        },
      },
      required: ["transaction_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        return ok(
          await (
            await gateway()
          ).getTransactionCoding(requiredString(input, "transaction_id")),
        );
      }),
  };
}
