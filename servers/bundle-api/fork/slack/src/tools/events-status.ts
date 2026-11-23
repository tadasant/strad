import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ClientFactory } from '../server.js';
import type { ToolContext } from '../tools.js';

const TOOL_DESCRIPTION = `Report the state of this Slack server's MCP Events feed — the Socket Mode
connection that delivers the \`message_posted\` event type through \`events/poll\`.

Read-only. Calls nothing on Slack or GCS; it reports what this process already knows.

**Returns** (JSON):
- \`state\`: not_configured, config_error, starting, connecting, connected, reconnecting,
  superseded (a newer process holds the socket) or stopped
- \`events_served\`: whether this deployment serves events at all, and \`reason\` when not —
  which names the variables that are missing, never their values
- \`socket\`: when the live connection opened, envelopes received, the last error
- \`backfill\`: the last catch-up after a (re)connect — from when, how many conversations,
  how many events it recovered, and how many reads were cut short at their page cap
- \`last_join\`: the last time the bot joined a conversation — when, where, and how many
  mentions were found in the minutes before the join (the one that invited it) —
  and \`joins_still_owed\`, how many joins have not been read back yet
- \`buffer\`: events held, the retention window, oldest and newest event, the last write to GCS
- \`lease\`: this process's id and the lease owner's

**Use cases:**
- Find out why a Slack trigger has gone quiet
- Confirm the app-level token is seeded and the socket is up after a deploy`;

export function eventsStatusTool(_server: Server, _clientFactory: ClientFactory, ctx: ToolContext) {
  return {
    name: 'slack_events_status',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    handler: async (_args: unknown) => {
      const status = ctx.events
        ? ctx.events.status()
        : { state: 'not_configured', events_served: false, reason: 'No events ingest in this process.' };
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    },
  };
}
