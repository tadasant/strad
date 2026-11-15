import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { formatMessageExtras } from './format-message-extras.js';
import { resolveUser, USER_PARAM_GUIDANCE } from './resolve-user.js';

const PARAM_DESCRIPTIONS = {
  user: `Read the DM with this person. ${USER_PARAM_GUIDANCE}`,
  channel_id:
    'Read this DM channel directly (e.g. "D034CD5EFGH"), skipping the user lookup. ' +
    'Get DM channel IDs from slack_get_dms or from a slack_send_dm result. ' +
    'Pass either this or user, not both.',
  message_limit:
    'Maximum number of messages to return, newest first. Default: 20. Maximum: 100.',
} as const;

export const GetDmSchema = z
  .object({
    user: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.user),
    channel_id: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.channel_id),
    message_limit: z
      .number()
      .min(1)
      .max(100)
      .default(20)
      .describe(PARAM_DESCRIPTIONS.message_limit),
  })
  .superRefine((value, ctx) => {
    if ((value.user === undefined) === (value.channel_id === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Pass exactly one of user (who the DM is with) or channel_id (the D… channel itself).',
      });
    }
  });

const TOOL_DESCRIPTION = `Read the direct-message conversation with one person.

Returns the recent messages in a one-to-one DM, newest first. Address it by
person — user ID, email, handle or display name — or by DM channel ID if you
already have one.

**Returns:**
- Who the conversation is with, and its DM channel ID
- Recent messages: sender, content, timestamp, reactions, files, thread info

**Use cases:**
- Read what someone said before replying to them
- Check whether a DM you sent got an answer
- Pick up context for a conversation that moved out of a channel
- Find the ts of a DM to thread under or react to

**Notes:**
- This reads and creates nothing: it does not notify anyone, does not mark the
  conversation read, and does not open a DM that does not exist. Naming someone
  you have never DMed reports that there is no conversation yet — slack_send_dm
  is what starts one.
- Threads inside a DM are read with slack_get_thread, using the DM channel ID.`;

export function getDmTool(server: Server, clientFactory: ClientFactory) {
  return {
    name: 'slack_get_dm',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        user: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.user,
        },
        channel_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.channel_id,
        },
        message_limit: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: PARAM_DESCRIPTIONS.message_limit,
        },
      },
      required: [],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = GetDmSchema.parse(args ?? {});
        const client = clientFactory();

        let channelId = parsed.channel_id;
        let heading = '# DM';

        if (parsed.user !== undefined) {
          const recipient = await resolveUser(client, parsed.user);
          const existing = await client.findDmChannel(recipient.id);

          if (existing === null) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `No DM conversation with ${recipient.label} exists yet, so there is ` +
                    'nothing to read. Use slack_send_dm to start one.',
                },
              ],
            };
          }

          channelId = existing;
          heading = `# DM with ${recipient.label}`;
        }

        // Narrowed by the superRefine above: one of the two branches always set it.
        const dmChannel = channelId as string;

        const { messages, hasMore } = await client.getMessages(dmChannel, {
          limit: parsed.message_limit,
        });

        let output = `${heading}\nDM channel: ${dmChannel}\n`;

        if (messages.length === 0) {
          output += '\n_No messages in this conversation yet._\n';
        } else {
          output += `\n## Recent Messages (${messages.length}${hasMore ? '+' : ''}):\n\n`;

          for (const msg of messages) {
            const time = new Date(parseFloat(msg.ts) * 1000).toISOString();
            const sender = msg.user || msg.bot_id || 'unknown';
            const threadInfo = msg.reply_count ? ` [${msg.reply_count} replies]` : '';
            const reactions = msg.reactions
              ? ` | Reactions: ${msg.reactions.map((r) => `:${r.name}: ${r.count}`).join(' ')}`
              : '';

            output += `**${sender}** (${time})${threadInfo}${reactions}\n`;
            output += `${msg.text}\n`;
            output += formatMessageExtras(msg);
            if (msg.thread_ts && msg.thread_ts !== msg.ts) {
              output += `↳ Reply to thread: ${msg.thread_ts}\n`;
            }
            output += `ts: ${msg.ts}\n\n`;
          }

          if (hasMore) {
            output += `_More messages available. Increase message_limit to see more._\n`;
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching DM: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
