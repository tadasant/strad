import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { MRKDWN_TEXT_GUIDANCE, MRKDWN_TOOL_WARNING, withMrkdwnAdvisory } from '../mrkdwn.js';
import { resolveUser, USER_PARAM_GUIDANCE } from './resolve-user.js';

const PARAM_DESCRIPTIONS = {
  user: USER_PARAM_GUIDANCE,
  text: `The message content to send. ${MRKDWN_TEXT_GUIDANCE}`,
} as const;

export const SendDmSchema = z.object({
  user: z.string().min(1).describe(PARAM_DESCRIPTIONS.user),
  text: z.string().min(1).describe(PARAM_DESCRIPTIONS.text),
});

const TOOL_DESCRIPTION = `Send a direct message to one Slack user.

${MRKDWN_TOOL_WARNING}

Opens the DM conversation if it does not exist yet and posts the message, in one
call. The recipient is named however you have them — user ID, email, handle or
display name — and nothing is sent until exactly one member matches.

**Returns:**
- Who it went to, resolved: real name, handle and user ID. Check this. An
  identifier is not proof of identity, and the resolved name is.
- The DM channel ID (e.g. "D034CD5EFGH") and the message timestamp (ts)

**The DM channel ID is an ordinary channel ID.** Every other tool here takes it:
slack_reply_to_thread to thread under the message, slack_update_message to edit
it, slack_react_to_message, slack_upload_snippet to attach a file, and
slack_post_message to send again without re-resolving the user.

**Use cases:**
- Alert one person about something that needs them specifically
- Ask a question that does not belong in a channel
- Deliver a result to whoever asked for it, privately
- Follow up on a thread with the person who started it

**Notes:**
- Ambiguity is an error, not a guess: an identifier matching two people comes
  back listing both with their IDs, and nothing is sent.
- This messages ONE person. There is no group-DM equivalent; to reach several
  people, send several DMs or post in a channel.
- A DM from a bot arrives from the app, not from you.`;

export function sendDmTool(server: Server, clientFactory: ClientFactory) {
  return {
    name: 'slack_send_dm',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        user: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.user,
        },
        text: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.text,
        },
      },
      required: ['user', 'text'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = SendDmSchema.parse(args);
        const client = clientFactory();

        const recipient = await resolveUser(client, parsed.user);
        const { channelId } = await client.openDm(recipient.id);
        const message = await client.postMessage(channelId, parsed.text);

        const time = new Date(parseFloat(message.ts) * 1000).toISOString();

        return {
          content: [
            {
              type: 'text',
              text: withMrkdwnAdvisory(
                `DM sent successfully!\n\n` +
                  `To: ${recipient.label}\n` +
                  `DM channel: ${channelId}\n` +
                  `Timestamp: ${message.ts}\n` +
                  `Sent at: ${time}\n\n` +
                  `Content:\n${parsed.text}\n\n` +
                  `The DM channel ID works with every channel tool here — reply in a thread ` +
                  `with slack_reply_to_thread, edit with slack_update_message, or send again ` +
                  `with slack_post_message and channel_id "${channelId}".`,
                parsed.text,
                { channelId, messageTs: message.ts }
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error sending DM: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
