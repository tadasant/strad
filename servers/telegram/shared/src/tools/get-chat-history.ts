import {
  args,
  boundedInt,
  guard,
  ok,
  optionalInt,
  requiredString,
  CHAT_DESCRIPTION,
  LIMIT_DESCRIPTION,
  OFFSET_DESCRIPTION,
  type GatewayFactory,
  type ToolDefinition,
} from "./shared.js";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * The tool this server exists for.
 *
 * Reading the history of a group the account joined and does not administer is
 * exactly what the Bot API cannot do, at any privacy setting. This reads it the
 * way the person's own Telegram client does.
 */
export function getChatHistoryTool(gateway: GatewayFactory): ToolDefinition {
  return {
    name: "get_chat_history",
    description:
      "Recent messages from a chat, OLDEST first — the same history the " +
      "account's own Telegram client shows, including a group it joined and " +
      "does not administer. Reading does NOT mark anything as read.\n\n" +
      'Example: {"chat":{"id":"-1001234567890","kind":"group","title":"Weekend ' +
      'Climbing"},"messages":[{"id":8814,"date":"2026-08-09T17:04:11.000Z",' +
      '"text":"anyone free saturday?","author":{"id":"777","name":"Ada L",' +
      '"username":"ada"}},{"id":8815,"date":"2026-08-09T17:06:02.000Z",' +
      '"text":"I am","author":{"id":"778","name":"Grace H"},' +
      '"reply_to_message_id":8814}],"next_offset_id":8814}\n\n' +
      "`media` names the KIND of attachment (photo, document, poll, …) — this " +
      "server never returns file contents. `next_offset_id` is the cursor for " +
      "the page before this one; its absence means the chat has been read back " +
      "to its first message.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: CHAT_DESCRIPTION },
        limit: {
          type: "integer",
          description: LIMIT_DESCRIPTION(DEFAULT_LIMIT, MAX_LIMIT),
        },
        offset_id: { type: "integer", description: OFFSET_DESCRIPTION },
      },
      required: ["chat"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const offsetId = optionalInt(input, "offset_id");
        return ok(
          await (
            await gateway()
          ).getHistory({
            chat: requiredString(input, "chat"),
            limit: boundedInt(input, "limit", DEFAULT_LIMIT, MAX_LIMIT),
            ...(offsetId !== undefined ? { offset_id: offsetId } : {}),
          }),
        );
      }),
  };
}
