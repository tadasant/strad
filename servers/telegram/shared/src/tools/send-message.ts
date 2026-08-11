import {
  args,
  guard,
  ok,
  optionalInt,
  requiredString,
  CHAT_DESCRIPTION,
  type GatewayFactory,
  type ToolDefinition,
} from "./shared.js";

/** Telegram's own ceiling for a text message. */
const MAX_TEXT_LENGTH = 4096;

/**
 * The one tool that acts in public, and the reason this server has two slugs.
 *
 * A message sent here is indistinguishable from one the person typed: same
 * account, same name, no "sent by a bot" marker anywhere. `telegram-ro` withholds
 * this tool at the gateway, which is the only tier most callers should have.
 */
export function sendMessageTool(gateway: GatewayFactory): ToolDefinition {
  return {
    name: "send_message",
    description:
      "Send a text message to a chat AS THE ACCOUNT ITSELF. It appears under " +
      "that person's own name, with no indication that software sent it, and it " +
      "is visible to everyone in the chat immediately. Telegram gives a sender " +
      "48 hours to delete a message and no way to unsend it after that.\n\n" +
      "Confirm the destination before calling — get_chat resolves a reference " +
      "without posting anything — and prefer replying in an existing thread " +
      "(`reply_to_message_id`) over starting a new one.\n\n" +
      'Example: {"chat":{"id":"-1001234567890","title":"Weekend Climbing"},' +
      '"message_id":8816,"date":"2026-08-09T17:20:00.000Z"}',
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: CHAT_DESCRIPTION },
        text: {
          type: "string",
          description:
            `The message, as plain text (1-${MAX_TEXT_LENGTH} characters). No ` +
            "markup is applied: what you pass is what the chat sees.",
        },
        reply_to_message_id: {
          type: "integer",
          description:
            "Reply to this message id, from get_chat_history or " +
            "search_messages. Omit to post at the end of the chat.",
        },
        disable_link_preview: {
          type: "boolean",
          description:
            "Suppress the preview card Telegram attaches to a URL. Default: " +
            "false (Telegram's own default).",
        },
      },
      required: ["chat", "text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const text = requiredString(input, "text");
        if (text.length > MAX_TEXT_LENGTH) {
          // Refused here rather than at Telegram, which answers a long message
          // with MESSAGE_TOO_LONG and no length — and rather than splitting it,
          // which would post something the caller did not write.
          throw new Error(
            `\`text\` is ${text.length} characters; Telegram's limit for one ` +
              `message is ${MAX_TEXT_LENGTH}. Send it as several messages, ` +
              `deliberately, rather than having one silently split.`,
          );
        }
        const replyTo = optionalInt(input, "reply_to_message_id");
        return ok(
          await (
            await gateway()
          ).sendMessage({
            chat: requiredString(input, "chat"),
            text,
            ...(replyTo !== undefined ? { reply_to_message_id: replyTo } : {}),
            ...(input.disable_link_preview === true
              ? { disable_link_preview: true }
              : {}),
          }),
        );
      }),
  };
}
