import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { parseDocumentId } from '../utils/parse-document-id.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  document_id: 'The Google Docs document ID, or the full document URL. Both forms are accepted.',
  comment_id:
    'The ID of the comment thread to reply to — the "Comment ID" that list_comments ' +
    'and add_comment return. Example: "AAABcD3fGh4"',
  content:
    'The reply text. Required unless resolve is set; with resolve it is posted ' +
    'alongside the resolve or reopen. Example: "Fixed, thanks."',
  resolve:
    'Optional. true resolves (closes) the thread; false reopens a resolved one. ' +
    'Omit to leave the thread as it is.',
} as const;

export const ReplyToCommentSchema = z
  .object({
    document_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.document_id),
    comment_id: z.string().trim().min(1).describe(PARAM_DESCRIPTIONS.comment_id),
    content: z.string().optional().describe(PARAM_DESCRIPTIONS.content),
    resolve: z.boolean().optional().describe(PARAM_DESCRIPTIONS.resolve),
  })
  .superRefine((data, ctx) => {
    const hasText = data.content !== undefined && data.content.trim().length > 0;
    if (data.content !== undefined && !hasText && data.resolve === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'content must not be blank',
        path: ['content'],
      });
    } else if (data.content === undefined && data.resolve === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'content is required unless resolve is set',
        path: ['content'],
      });
    }
  });

const TOOL_DESCRIPTION = `Reply to a comment thread on a Google Doc, and optionally resolve or reopen it.

Creates a Drive reply (\`replies.create\`) as the account this server signs in
as. Take \`comment_id\` from \`list_comments\` (its "Comment ID") or from
\`add_comment\`. A reply is the only way the API resolves a thread, so
\`resolve\` lives here.

**Parameters:**
- document_id: Document ID or full Docs URL (required)
- comment_id: The thread's comment ID (required)
- content: The reply text (required unless resolve is set)
- resolve: true resolves the thread, false reopens it (optional)

**Returns:** the new reply's ID and author, and whether it resolved or reopened
the thread.

**Examples:**
- Answer a question: \`{ comment_id, content: "Yes, Q3." }\`
- Close a thread with a note: \`{ comment_id, content: "Done.", resolve: true }\`
- Close it without a note: \`{ comment_id, resolve: true }\`

Google may notify the thread's participants, per their own Docs notification
settings, as it does for a reply made in the editor.`;

export function replyToCommentTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'reply_to_comment',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: PARAM_DESCRIPTIONS.document_id },
        comment_id: { type: 'string', description: PARAM_DESCRIPTIONS.comment_id },
        content: { type: 'string', description: PARAM_DESCRIPTIONS.content },
        resolve: { type: 'boolean', description: PARAM_DESCRIPTIONS.resolve },
      },
      required: ['document_id', 'comment_id'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = ReplyToCommentSchema.parse(args ?? {});
        const documentId = parseDocumentId(parsed.document_id);
        const client = clientFactory();
        const action =
          parsed.resolve === undefined ? undefined : parsed.resolve ? 'resolve' : 'reopen';

        // Blank text beside a resolve is no text: Drive takes the bare action.
        const content = parsed.content?.trim() ? parsed.content : undefined;
        const reply = await client.createReply(documentId, parsed.comment_id, {
          content,
          action,
        });

        let output = `Reply added to comment ${parsed.comment_id} on ${documentId}.\n\n`;
        output += `- **Reply ID:** ${reply.id ?? '(not returned)'}\n`;
        if (reply.author?.displayName) output += `- **Author:** ${reply.author.displayName}\n`;
        if (reply.createdTime) output += `- **Created:** ${reply.createdTime}\n`;
        if (reply.action === 'resolve') output += '- **Thread:** resolved\n';
        if (reply.action === 'reopen') output += '- **Thread:** reopened\n';
        if (action && reply.action !== action) {
          output += `- **Thread:** asked to ${action}, and Drive's answer did not confirm it\n`;
        }

        return { content: [{ type: 'text', text: output.trimEnd() }] };
      } catch (error) {
        logError('reply-to-comment-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error replying to comment: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
