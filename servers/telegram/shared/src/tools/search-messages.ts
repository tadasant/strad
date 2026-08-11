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

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/**
 * Search WITHIN one chat, deliberately.
 *
 * Telegram also has a global search, and it is not exposed: a query that reaches
 * across every private conversation the account has is a much larger read than
 * "what did this group say about the permits", and the agent asking for the
 * second should not get the first by leaving a parameter out.
 */
export function searchMessagesTool(gateway: GatewayFactory): ToolDefinition {
  return {
    name: "search_messages",
    description:
      "Full-text search inside ONE chat, server-side, over its whole history — " +
      "far cheaper than paging get_chat_history back through months to find a " +
      "message. Results come back OLDEST first, in the same shape as " +
      "get_chat_history.\n\n" +
      'Example: search_messages({"chat":"-1001234567890","query":"permit"}) -> ' +
      '{"chat":{…},"messages":[{"id":8102,"date":"2026-06-01T12:00:00.000Z",' +
      '"text":"got the permit","author":{"id":"777","name":"Ada L"}}]}\n\n' +
      "`chat` is required: this server exposes no account-wide search. Telegram " +
      "matches whole words rather than substrings, so search for \"permit\", not " +
      '"perm".',
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: CHAT_DESCRIPTION },
        query: {
          type: "string",
          description:
            'What to search for, e.g. "permit" or "saturday climb". Telegram ' +
            "matches words, and the search is case-insensitive.",
        },
        limit: {
          type: "integer",
          description: LIMIT_DESCRIPTION(DEFAULT_LIMIT, MAX_LIMIT),
        },
        offset_id: { type: "integer", description: OFFSET_DESCRIPTION },
      },
      required: ["chat", "query"],
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
          ).searchMessages({
            chat: requiredString(input, "chat"),
            query: requiredString(input, "query"),
            limit: boundedInt(input, "limit", DEFAULT_LIMIT, MAX_LIMIT),
            ...(offsetId !== undefined ? { offset_id: offsetId } : {}),
          }),
        );
      }),
  };
}
