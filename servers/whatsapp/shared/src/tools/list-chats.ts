import {
  args,
  boundedInt,
  guard,
  ok,
  optionalString,
  UNOFFICIAL,
  type BridgeFactory,
  type ToolDefinition,
} from "./shared.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** How a human finds the group's chat_id to put in a Zimmer trigger. */
export function listChatsTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "whatsapp_list_chats",
    description:
      "The chats this bridge knows about — every group the paired account is a " +
      "member of, and every chat it has seen a message in — newest activity " +
      "first. Use it to find a chat's `id` (a WhatsApp JID) for " +
      "whatsapp_get_messages or whatsapp_send_message.\n\n" +
      `${UNOFFICIAL}\n\n` +
      'Example: {"chats":[{"id":"120363012345678901@g.us","name":"Wedding planning",' +
      '"is_group":true,"last_message_at":1790000000,"participant_count":4}]}',
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: `How many chats (1-${MAX_LIMIT}). Default: ${DEFAULT_LIMIT}.`,
        },
        query: {
          type: "string",
          description:
            "Case-insensitive substring of the chat's name or id, e.g. \"wedding\".",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const query = optionalString(input, "query");
        return ok(
          await (
            await bridge()
          ).listChats({
            limit: boundedInt(input, "limit", DEFAULT_LIMIT, MAX_LIMIT),
            ...(query !== undefined ? { query } : {}),
          }),
        );
      }),
  };
}
