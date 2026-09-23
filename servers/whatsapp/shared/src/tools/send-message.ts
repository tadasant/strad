import {
  args,
  CHAT_ID_DESCRIPTION,
  guard,
  ok,
  optionalString,
  requiredString,
  UNOFFICIAL,
  type BridgeFactory,
  type ToolDefinition,
} from "./shared.js";

/**
 * The one tool that speaks in public. It posts AS the paired account — on a
 * personal number, as that person, under their own name.
 */
export function sendMessageTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "whatsapp_send_message",
    description:
      "Send a text message to a chat AS THE PAIRED WHATSAPP ACCOUNT. It appears " +
      "under that account's own name and number, with nothing marking it as " +
      "sent by software, and everyone in the chat sees it immediately.\n\n" +
      "Sending is deliberately human-paced: a \"typing…\" indicator first, a " +
      "few seconds between messages, and a refusal (not a queue) past 6 per " +
      "minute or 60 per hour. This is not a bulk channel — bursts are how an " +
      "unofficial client gets the account banned.\n\n" +
      `${UNOFFICIAL}\n\n` +
      "The sent message is recorded in the buffer with sent_by_bridge: true.\n\n" +
      'Example: {"id":"3EB0A1B2C3D4E5F6","timestamp":1790000123}',
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: CHAT_ID_DESCRIPTION },
        text: {
          type: "string",
          description:
            "The message, as plain text (up to 4096 characters). WhatsApp's own " +
            "*bold* / _italic_ markers render as usual.",
        },
        reply_to_message_id: {
          type: "string",
          description:
            "Quote this message (an `id` from whatsapp_get_messages in the same " +
            "chat). Omit to post without a quote.",
        },
      },
      required: ["chat_id", "text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const replyTo = optionalString(input, "reply_to_message_id");
        return ok(
          await (
            await bridge()
          ).sendMessage({
            chat_id: requiredString(input, "chat_id"),
            text: requiredString(input, "text"),
            ...(replyTo !== undefined ? { reply_to_message_id: replyTo } : {}),
          }),
        );
      }),
  };
}
