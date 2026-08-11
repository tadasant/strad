import {
  guard,
  ok,
  type GatewayFactory,
  type ToolDefinition,
} from "./shared.js";

/**
 * Whose account is this?
 *
 * Every other tool in this server acts AS a person, and which person is a
 * property of a session string an agent cannot see. Asking is one call and it is
 * the honest first move before reading someone's private chats or posting under
 * their name.
 */
export function getMeTool(gateway: GatewayFactory): ToolDefinition {
  return {
    name: "get_me",
    description:
      "The Telegram ACCOUNT this server acts as. Everything this server reads is " +
      "read as that person, from their own client's point of view, and " +
      "send_message posts under their name — so call this first when you are " +
      "about to act on their behalf and are not certain who they are.\n\n" +
      'Example: {"id":"123456789","name":"Ada Lovelace","username":"ada"}',
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: () => guard(async () => ok(await (await gateway()).getMe())),
  };
}
