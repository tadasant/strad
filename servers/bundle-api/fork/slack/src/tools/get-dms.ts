import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { userLabel } from './resolve-user.js';

const PARAM_DESCRIPTIONS = {
  include_group_dms:
    'Include multi-person group DMs alongside one-to-one DMs. Default: false. ' +
    'Group DMs need the mpim:read scope, and Slack fails the WHOLE listing when ' +
    'it is missing — so setting this true on a token without mpim:read returns ' +
    'an error instead of the one-to-one DMs it would otherwise have listed.',
  limit:
    'Maximum number of DM conversations to return, most recently active first. ' +
    'Default: 50. Maximum: 200.',
} as const;

export const GetDmsSchema = z.object({
  include_group_dms: z.boolean().default(false).describe(PARAM_DESCRIPTIONS.include_group_dms),
  limit: z.number().min(1).max(200).default(50).describe(PARAM_DESCRIPTIONS.limit),
});

const TOOL_DESCRIPTION = `List the direct-message conversations this bot is part of.

Returns one entry per DM, most recently active first, with the other member
resolved to a name where the token can read the user directory.

**Returns:**
For each conversation:
- DM channel ID (e.g. "D0BGVRZRX4Z") — an ordinary channel ID that every other
  tool here accepts
- The other member: real name, handle and user ID
- Last activity, where Slack reports one for the conversation. Where it does not,
  the conversation's creation time is shown instead and labelled as such.

**Use cases:**
- Find the DM channel for someone you have messaged before
- See which conversations are live before replying to one
- Get a channel ID to read with slack_get_dm or post to with slack_post_message
- Audit who the bot has been talking to privately

**Notes:**
- A DM exists only once someone has opened it. Somebody you have never messaged
  will not appear here — slack_send_dm opens the conversation for you.
- To read one conversation's messages, use slack_get_dm.`;

export function getDmsTool(server: Server, clientFactory: ClientFactory) {
  return {
    name: 'slack_get_dms',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        include_group_dms: {
          type: 'boolean',
          default: false,
          description: PARAM_DESCRIPTIONS.include_group_dms,
        },
        limit: {
          type: 'number',
          default: 50,
          minimum: 1,
          maximum: 200,
          description: PARAM_DESCRIPTIONS.limit,
        },
      },
      required: [],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = GetDmsSchema.parse(args ?? {});
        const client = clientFactory();

        const { dms, truncated } = await client.getDms({
          includeGroupDms: parsed.include_group_dms,
          limit: parsed.limit,
        });

        if (dms.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'No DM conversations found. A DM channel exists only after someone opens ' +
                  'it — use slack_send_dm to start one.',
              },
            ],
          };
        }

        const list = dms
          .map((dm) => {
            const who = dm.isGroup
              ? `group DM${dm.name ? ` (${dm.name})` : ''}`
              : dm.user
                ? userLabel(dm.user)
                : (dm.userId ?? 'unknown member');
            const flags = [];
            if (dm.isGroup) flags.push('group');
            if (dm.isUserDeleted) flags.push('member deactivated');
            const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
            // Slack returns `updated` on a DM but does not document it. When it
            // is absent the only timestamp available is the conversation's
            // creation, and calling that "last activity" would be a lie.
            const when =
              dm.updated === undefined
                ? `Conversation created: ${new Date(dm.created * 1000).toISOString()}`
                : `Last activity: ${new Date(dm.updated).toISOString()}`;

            return `• ${who}${flagStr}\n   DM channel: ${dm.id}\n   ${when}`;
          })
          .join('\n\n');

        const capped = truncated
          ? '\n\n⚠️ More DM conversations exist than this tool lists in one call; these are the ' +
            'ones it read.'
          : '';

        return {
          content: [
            {
              type: 'text',
              text: `Found ${dms.length} DM conversation(s):\n\n${list}${capped}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching DMs: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
