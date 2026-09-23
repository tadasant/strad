import {
  args,
  boundedInt,
  CHAT_ID_DESCRIPTION,
  guard,
  ok,
  optionalSeconds,
  requiredString,
  UNOFFICIAL,
  type BridgeFactory,
  type ToolDefinition,
} from "./shared.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * The read Zimmer polls every minute. Its paging rule is the contract: with
 * `after`, the OLDEST `limit` matches, so a cursor walking forward never skips.
 */
export function getMessagesTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "whatsapp_get_messages",
    description:
      "Messages in one chat, OLDEST first, from this bridge's own buffer. " +
      "WhatsApp gives a linked device no history API: the buffer holds the " +
      "recent history WhatsApp synced when the device was paired plus every " +
      "message seen since, capped per chat (by default 1000 messages / 30 " +
      "days). Reading marks nothing as read.\n\n" +
      "Paging: with `after` (UNIX seconds, INCLUSIVE) you get the oldest " +
      "`limit` messages at or after it and `has_more: true` if there were more " +
      "— to walk forward, pass the last timestamp you saw and drop ids you " +
      "already have. Without `after` you get the newest `limit`.\n\n" +
      "`sent_by_bridge` marks messages this bridge posted (skip them to avoid " +
      "answering yourself). `mentions_self` / `reply_to_self` are about the " +
      "paired account. `text` is the text or the media caption; `type` names " +
      "the kind, and media bytes are never returned.\n\n" +
      `${UNOFFICIAL}\n\n` +
      'Example: {"chat_id":"120363012345678901@g.us","chat_name":"Wedding planning",' +
      '"self_jid":"15551234567@s.whatsapp.net","has_more":false,"messages":[{' +
      '"id":"3EB0C0FFEE","chat_id":"120363012345678901@g.us","timestamp":1790000000,' +
      '"sender_jid":"15557654321@s.whatsapp.net","sender_name":"Grace",' +
      '"from_me":false,"sent_by_bridge":false,"text":"Can we move the tasting?",' +
      '"type":"text","quoted_message_id":null,"mentions_self":true,"reply_to_self":false}]}',
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: CHAT_ID_DESCRIPTION },
        after: {
          type: "integer",
          description:
            "UNIX timestamp in SECONDS, inclusive. Return the oldest messages at " +
            "or after it. Omit for the newest messages.",
        },
        limit: {
          type: "integer",
          description: `How many messages (1-${MAX_LIMIT}). Default: ${DEFAULT_LIMIT}.`,
        },
      },
      required: ["chat_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const after = optionalSeconds(input, "after");
        return ok(
          await (
            await bridge()
          ).getMessages({
            chat_id: requiredString(input, "chat_id"),
            limit: boundedInt(input, "limit", DEFAULT_LIMIT, MAX_LIMIT),
            ...(after !== undefined ? { after } : {}),
          }),
        );
      }),
  };
}
