import { guard, ok, UNOFFICIAL, type BridgeFactory, type ToolDefinition } from "./shared.js";

export function logoutTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "whatsapp_logout",
    description:
      "Unlink this bridge from the WhatsApp account and DELETE everything it " +
      "persisted: the login and the whole message buffer. Irreversible — " +
      "reading again needs a new whatsapp_pair, and only the history WhatsApp " +
      "re-syncs on that pairing comes back. `unlinked_on_phone` is false when " +
      "the socket was down, in which case also remove the device under " +
      "Linked devices on the phone.\n\n" +
      `${UNOFFICIAL}\n\n` +
      'Example: {"ok":true,"unlinked_on_phone":true}',
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: () => guard(async () => ok(await (await bridge()).logout())),
  };
}
