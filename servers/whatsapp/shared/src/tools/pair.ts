import { BridgeError } from "../bridge.js";
import {
  args,
  guard,
  ok,
  optionalString,
  requiredString,
  UNOFFICIAL,
  type BridgeFactory,
  type ToolDefinition,
} from "./shared.js";

/**
 * Pairing without a shell, two ways. By CODE (the default): the bridge asks
 * WhatsApp for a pairing code and a human types it into the phone. By QR: the
 * bridge returns the QR WhatsApp is offering, as a PNG drawn in this process,
 * and a human scans it — from strad's console playground on a laptop, which
 * renders an image block as an image. Either way nobody is on the box.
 */
export function pairTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "whatsapp_pair",
    description:
      "Link this bridge to a WhatsApp account as a linked device. Default " +
      "method \"code\": returns an 8-character code; a human enters it on the " +
      "phone that holds the account: WhatsApp › Settings › Linked devices › " +
      "Link a device › \"Link with phone number instead\". Do not wait for a " +
      "prompt on the phone; enter it manually. Only the newest code works — " +
      "each call starts over. Method \"qr\": returns the current QR as a PNG " +
      "image plus its text, for the phone's camera (Link a device, then scan); " +
      "call again after about a minute for the rotated QR.\n\n" +
      "Once paired, this bridge reads every chat that account is in and can " +
      "post as it. The phone lists it as Chrome on Mac OS. Refused when an " +
      "account is already paired (whatsapp_logout first).\n\n" +
      `${UNOFFICIAL}\n\n` +
      'Example: {"pairing_code":"ABCD-EFGH","expires_in_seconds":120,' +
      '"instructions":"On the phone that holds this WhatsApp account: …"}',
    inputSchema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          enum: ["code", "qr"],
          description: 'How the phone links: "code" (default) or "qr".',
        },
        phone_number: {
          type: "string",
          description:
            'Required for "code". The account\'s phone number in E.164 digits, ' +
            'country code first, no "+": "15551234567".',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const method = optionalString(input, "method") ?? "code";
        if (method === "qr") {
          const { png, ...payload } = await (await bridge()).pairQr();
          const result = ok(payload);
          result.content.push({
            type: "image",
            data: png.toString("base64"),
            mimeType: "image/png",
          });
          return result;
        }
        if (method !== "code") {
          throw new BridgeError('`method` must be "code" or "qr".');
        }
        return ok(await (await bridge()).pair(requiredString(input, "phone_number")));
      }),
  };
}
