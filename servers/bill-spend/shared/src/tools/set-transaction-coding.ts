import { InputError } from "../errors.js";
import {
  args,
  guard,
  ok,
  optionalString,
  requiredString,
  FIELD_DESCRIPTION,
  type GatewayFactory,
  type ToolDefinition,
} from "./shared.js";

/** More than this on one field is a caller pasting the wrong thing. */
const MAX_VALUES = 25;

/**
 * The only tool in this server that changes anything, and the reason the read
 * tools return the identifier forms they do.
 *
 * IT DOES NOT BELIEVE BILL. `PUT /v3/spend/transactions/{id}/custom-fields` can
 * answer HTTP 200 `{"status":"SUCCESS"}` having discarded the update, so this
 * tool re-reads the transaction after every attempt and diffs it, and reports
 * success only on a change it observed. `verified: true` in a result means the
 * read-back was done, not that BILL said so — and `wire_variant` names the body
 * shape that actually worked, so which one BILL honours stops being folklore.
 * See wire.ts for the shapes and why there is more than one.
 *
 * IT TAKES IDS, NOT NAMES, and that is the fix for the trap rather than a
 * convenience: an account NAME would have to be resolved to an id somewhere, and
 * a resolution this tool did silently is exactly how the wrong-form identifier
 * gets sent. The ids come from list_coding_options, which returns them.
 */
export function setTransactionCodingTool(
  gateway: GatewayFactory,
): ToolDefinition {
  return {
    name: "set_transaction_coding",
    description:
      "Re-code ONE transaction: set which values of one custom field it is " +
      "tagged with. This CHANGES a financial record in BILL — it is the same " +
      "edit a person makes in the Spend & Expense web app, and it feeds the " +
      "accounting sync.\n\n" +
      "THE WRITE IS VERIFIED. BILL's update endpoint can answer 200 SUCCESS " +
      "and silently discard the change, so this tool re-reads the transaction " +
      "afterwards and compares. It reports success only on a change it " +
      "observed; if nothing moved it fails with `persisted: false` and the " +
      "transaction should be treated as UNCODED. Never infer from a bare " +
      "SUCCESS anywhere else in BILL's API that a coding change landed.\n\n" +
      'Success: {"transaction_id":"txn_1a2b","field":{"id":"Y3VzdG9tZmllbGQ6MTIz",' +
      '"name":"GL Account"},"before":[{"value":"Internet/Phone"}],' +
      '"after":[{"value":"Software & Subscriptions"}],"changed":true,' +
      '"verified":true,"wire_variant":"customFieldId/id"}\n\n' +
      "PASS `value_ids` FROM list_coding_options, using the `id` it returns. " +
      "Account names are not accepted, and a uuid taken from a " +
      "list_transactions result is the identifier form BILL is reported to " +
      "accept and drop. An id that belongs to a different field is refused here " +
      "before anything is written.\n\n" +
      "An empty `value_ids` array CLEARS the field's coding. A transaction that " +
      "already carries exactly these values is left alone and comes back with " +
      "`changed: false` — re-running a sweep costs reads, not writes.\n\n" +
      "A LOCKED transaction is refused without a write attempt: BILL does not " +
      "accept coding changes on one, and only a human can unlock it in the web " +
      "app. Check `is_locked` in list_transactions to avoid the round trip.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: {
          type: "string",
          description:
            "The transaction's `uuid` (or base64 `id`) from list_transactions.",
        },
        field: { type: "string", description: FIELD_DESCRIPTION },
        value_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "The values to set, as the `id` strings from list_coding_options " +
            "FOR THIS FIELD. Not account names, and not values from another " +
            "field. Pass one for a single-select field, several only if the " +
            "field's `multi_select` is true, and an EMPTY ARRAY to clear the " +
            "coding entirely.",
        },
        note: {
          type: "string",
          description:
            "Free text for a NOTE-type field. BILL accepts this only on a " +
            "field whose `type` is NOTE — on a CUSTOM_SELECTOR field it is " +
            "ignored, and it is `value_ids` that does the work.",
        },
      },
      required: ["transaction_id", "field", "value_ids"],
      additionalProperties: false,
    },
    // Not destructive: this replaces one field's selection on one transaction
    // and the previous selection is in `before`, so it is reversible with
    // another call. It is not idempotent-safe to call blindly, though — the
    // openWorld hint and the description carry that.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const valueIds = input.value_ids;
        if (!Array.isArray(valueIds)) {
          throw new InputError(
            "`value_ids` is required and must be an array of value id strings " +
              "from list_coding_options. Pass [] to clear the field.",
          );
        }
        if (valueIds.length > MAX_VALUES) {
          throw new InputError(
            `\`value_ids\` has ${valueIds.length} entries; ${MAX_VALUES} is the ` +
              `most this tool will send for one field. A list that long is ` +
              `usually a whole chart of accounts pasted in by mistake.`,
          );
        }
        const ids = valueIds.map((v, i) => {
          if (typeof v !== "string" || v.trim() === "") {
            throw new InputError(
              `\`value_ids[${i}]\` must be a non-empty string — the \`id\` of a ` +
                `value from list_coding_options.`,
            );
          }
          return v.trim();
        });
        const note = optionalString(input, "note");
        return ok(
          await (
            await gateway()
          ).setTransactionCoding({
            transaction_id: requiredString(input, "transaction_id"),
            field: requiredString(input, "field"),
            value_ids: ids,
            ...(note === undefined ? {} : { note }),
          }),
        );
      }),
  };
}
