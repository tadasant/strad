import {
  args,
  guard,
  ok,
  requiredString,
  UNOFFICIAL,
  type BridgeFactory,
  type ToolDefinition,
} from "./shared.js";

/**
 * Pairing without a screen and without a shell: the bridge asks WhatsApp for
 * a pairing code, and a human types it into the phone. This is how the bridge
 * gets its login with nobody on the box.
 */
export function pairTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "whatsapp_pair",
    description:
      "Link this bridge to a WhatsApp account as a linked device, by pairing " +
      "code. Returns an 8-character code; a human then enters it on the phone " +
      "that holds the account: WhatsApp › Settings › Linked devices › Link a " +
      "device › \"Link with phone number instead\". Do not wait for a prompt " +
      "to appear on the phone — enter the code manually. Works for a dedicated " +
      "number or a personal one.\n\n" +
      "Once paired, this bridge reads every chat that account is in and can " +
      "post as it. Refused when an account is already paired " +
      "(whatsapp_logout first).\n\n" +
      `${UNOFFICIAL}\n\n` +
      'Example: {"pairing_code":"ABCD-EFGH","expires_in_seconds":120,' +
      '"instructions":"On the phone that holds this WhatsApp account: …"}',
    inputSchema: {
      type: "object",
      properties: {
        phone_number: {
          type: "string",
          description:
            'The account\'s phone number in E.164 digits, country code first, no "+": ' +
            '"15551234567".',
        },
      },
      required: ["phone_number"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: (raw) =>
      guard(async () =>
        ok(await (await bridge()).pair(requiredString(args(raw), "phone_number"))),
      ),
  };
}
