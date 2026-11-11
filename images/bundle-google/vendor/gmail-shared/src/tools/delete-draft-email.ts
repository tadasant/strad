import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { getHeader } from '../utils/email-helpers.js';
import { DRAFT_ID_PATTERN } from '../gmail-client/lib/drafts.js';

const PARAM_DESCRIPTIONS = {
  draft_id:
    'ID of the draft to delete, as returned by list_draft_emails or upsert_draft_email ' +
    '(e.g. "r-1234567890123456789"). This is a DRAFT id, not a message or thread id.',
} as const;

export const DeleteDraftEmailSchema = z.object({
  draft_id: z
    .string()
    .regex(DRAFT_ID_PATTERN, 'draft_id must be a Gmail draft ID (letters, digits, "-" and "_").')
    .describe(PARAM_DESCRIPTIONS.draft_id),
});

const TOOL_DESCRIPTION = `Delete (discard) one draft email.

**Parameters:**
- draft_id: ID of the draft to delete, from list_draft_emails or upsert_draft_email (required)

**What it deletes:** exactly one draft, permanently — Gmail does not move a deleted draft to Trash. The draft is read first, and an ID that is not a draft (a message ID, a thread ID, a draft already deleted) is refused without changing anything. Sent and received messages, and the conversation thread the draft belongs to, are never touched.

**Use cases:**
- Discard a stale or superseded draft so nobody sends the wrong one
- Clean up a duplicate draft left in a conversation

**Note:** To change a draft's content, update it in place with upsert_draft_email instead. Use list_draft_emails with thread_id to find the drafts in a conversation.`;

export function deleteDraftEmailTool(server: Server, clientFactory: ClientFactory) {
  return {
    name: 'delete_draft_email',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        draft_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.draft_id,
        },
      },
      required: ['draft_id'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = DeleteDraftEmailSchema.parse(args ?? {});
        const client = clientFactory();

        // Read it first: a 404 here means the ID is not a draft in this
        // mailbox, and the delete is never sent. It is also what lets the
        // answer say which draft went.
        let draft;
        try {
          draft = await client.getDraft(parsed.draft_id);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('Resource not found')) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `No draft with ID ${parsed.draft_id} in this mailbox. Nothing was deleted. ` +
                    'It may be a message or thread ID, or a draft that was already sent or deleted; ' +
                    'list_draft_emails returns the current draft IDs.',
                },
              ],
              isError: true,
            };
          }
          throw error;
        }
        await client.deleteDraft(parsed.draft_id);

        const subject = getHeader(draft.message, 'Subject') || '(No Subject)';
        const to = getHeader(draft.message, 'To') || '(No Recipient)';

        let text = `Draft deleted.\n\n**Draft ID:** ${parsed.draft_id}`;
        if (draft.message.threadId) {
          text += `\n**Thread ID:** ${draft.message.threadId}`;
        }
        text += `\n**To:** ${to}`;
        text += `\n**Subject:** ${subject}`;
        text +=
          '\n\nThe draft is gone for good (Gmail does not keep deleted drafts in Trash). ' +
          'Every other message in the thread is unchanged.';

        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error deleting draft: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
