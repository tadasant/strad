import type { ChatKind } from "../gateway.js";
import {
  args,
  boundedInt,
  guard,
  ok,
  type GatewayFactory,
  type ToolDefinition,
} from "./shared.js";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const KINDS: ChatKind[] = ["user", "bot", "group", "channel"];

/**
 * The entry point of this server, and the only tool that needs no id.
 *
 * It is also what makes the others work: resolving a chat by NUMERIC id needs an
 * access hash, and a session learns one by seeing the chat in a dialog list.
 */
export function listChatsTool(gateway: GatewayFactory): ToolDefinition {
  return {
    name: "list_chats",
    description:
      "The chats this Telegram account belongs to — groups, channels, and " +
      "one-to-one conversations — newest activity first. START HERE: the `id` " +
      "in each result is what get_chat_history, search_messages and " +
      "send_message take as `chat`.\n\n" +
      'Example: {"chats":[{"id":"-1001234567890","kind":"group",' +
      '"title":"Weekend Climbing","username":"weekendclimbing","unread_count":3}],' +
      '"returned":1}\n\n' +
      "`kind` is one of: group (a group or supergroup the account is a member " +
      "of), channel (a broadcast channel it follows), user (a person), bot. " +
      "Filter with `kinds` and `query` rather than reading everything: an " +
      "account with hundreds of chats returns a lot of text.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: `How many chats to return (1-${MAX_LIMIT}). Default: ${DEFAULT_LIMIT}.`,
        },
        query: {
          type: "string",
          description:
            "Case-insensitive substring of the title or @username, e.g. " +
            '"climbing". Matched locally over the chats Telegram returned, so it ' +
            "finds a chat the account is in, not one it is not.",
        },
        kinds: {
          type: "array",
          items: { type: "string", enum: KINDS },
          description:
            'Restrict to these kinds, e.g. ["group"] to see only groups and ' +
            "supergroups. Omit for all kinds.",
        },
        include_archived: {
          type: "boolean",
          description:
            "Include chats in the account's archive. Default: false — an " +
            "archived chat is one the person deliberately put out of sight.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const kinds = Array.isArray(input.kinds)
          ? input.kinds.filter((k): k is ChatKind =>
              KINDS.includes(k as ChatKind),
            )
          : undefined;
        const chats = await (
          await gateway()
        ).listChats({
          limit: boundedInt(input, "limit", DEFAULT_LIMIT, MAX_LIMIT),
          include_archived: input.include_archived === true,
          ...(typeof input.query === "string" && input.query.trim() !== ""
            ? { query: input.query }
            : {}),
          ...(kinds && kinds.length > 0 ? { kinds } : {}),
        });
        return ok({ chats, returned: chats.length });
      }),
  };
}
