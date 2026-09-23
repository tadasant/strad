import { guard, ok, UNOFFICIAL, type BridgeFactory, type ToolDefinition } from "./shared.js";

/**
 * The health check Zimmer's poller runs before trusting a read: only
 * `connected && paired` means the socket is open and logged in.
 */
export function statusTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "whatsapp_status",
    description:
      "Whether this bridge's WhatsApp linked device is paired and connected. " +
      "Treat the bridge as healthy ONLY when `connected` and `paired` are both " +
      "true: messages that arrive while it is disconnected are only partly " +
      "replayed later. A phone that stays offline for about 14 days logs every " +
      "linked device out; that shows up here as paired: false with " +
      'last_disconnect_reason "logged_out", and a human has to pair again.\n\n' +
      `${UNOFFICIAL}\n\n` +
      'Example: {"connected":true,"paired":true,"self_jid":"15551234567@s.whatsapp.net",' +
      '"self_name":"Ada","last_event_at":1790000000,"pairing_in_progress":false,' +
      '"last_disconnect_reason":null}',
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: () => guard(async () => ok(await (await bridge()).status())),
  };
}
