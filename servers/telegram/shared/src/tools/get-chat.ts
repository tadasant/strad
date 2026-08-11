import {
  args,
  guard,
  ok,
  requiredString,
  CHAT_DESCRIPTION,
  type GatewayFactory,
  type ToolDefinition,
} from "./shared.js";

/**
 * Resolve a reference to the chat it actually names.
 *
 * The cheap confirmation before a write, and the one call that answers "did I
 * get the right group?" without pulling a page of someone's messages.
 */
export function getChatTool(gateway: GatewayFactory): ToolDefinition {
  return {
    name: "get_chat",
    description:
      "Resolve a chat reference to the chat it names, without reading any " +
      "messages. Use it to confirm an id or @username points where you think " +
      "before sending a message, and to turn a t.me link into the id the other " +
      "tools take.\n\n" +
      'Example: {"id":"-1001234567890","kind":"group","title":"Weekend Climbing",' +
      '"username":"weekendclimbing"}',
    inputSchema: {
      type: "object",
      properties: { chat: { type: "string", description: CHAT_DESCRIPTION } },
      required: ["chat"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () =>
        ok(await (await gateway()).resolveChat(requiredString(args(raw), "chat"))),
      ),
  };
}
