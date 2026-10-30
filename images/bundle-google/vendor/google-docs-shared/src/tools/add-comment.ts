import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { parseDocumentId } from '../utils/parse-document-id.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  document_id: 'The Google Docs document ID, or the full document URL. Both forms are accepted.',
  content:
    'The comment text. Plain text; Docs renders it as written. ' +
    'Example: "Should this say Q3 rather than Q2?"',
  quoted_text:
    'Optional. The document text the comment is about, copied exactly. Stored as the ' +
    "comment's quoted text; the comment is NOT attached to it and nothing in the " +
    'document is highlighted. Example: "Revenue grew 12% in Q2."',
} as const;

const nonBlank = (s: string) => s.trim().length > 0;

export const AddCommentSchema = z.object({
  document_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.document_id),
  content: z.string().refine(nonBlank, 'content must not be blank').describe(PARAM_DESCRIPTIONS.content),
  quoted_text: z
    .string()
    .refine(nonBlank, 'quoted_text must not be blank')
    .optional()
    .describe(PARAM_DESCRIPTIONS.quoted_text),
});

const TOOL_DESCRIPTION = `Add a comment to a Google Doc, as the account this server signs in as.

Creates a Drive comment (\`comments.create\`). It opens a new thread in the
document's comment list; reply to an existing thread with \`reply_to_comment\`
instead.

**The comment is not attached to a passage of text.** Google Docs ignores a
text anchor supplied through the API, so the comment shows in the comments
panel without highlighting anything in the document. \`quoted_text\` is stored
as the comment's quoted text (Drive's \`quotedFileContent\`), which is the closest
the API gets: put the passage there so a reader can find what the comment is
about.

**Parameters:**
- document_id: Document ID or full Docs URL (required)
- content: The comment text (required)
- quoted_text: The passage the comment is about, shown as its quote (optional)

**Returns:** the new comment's ID (pass it to \`reply_to_comment\`), author and
time.

Google may notify people with access to the document, per their own Docs
notification settings, as it does for a comment made in the editor.`;

export function addCommentTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'add_comment',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: PARAM_DESCRIPTIONS.document_id },
        content: { type: 'string', description: PARAM_DESCRIPTIONS.content },
        quoted_text: { type: 'string', description: PARAM_DESCRIPTIONS.quoted_text },
      },
      required: ['document_id', 'content'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = AddCommentSchema.parse(args ?? {});
        const documentId = parseDocumentId(parsed.document_id);
        const client = clientFactory();

        const comment = await client.createComment(documentId, {
          content: parsed.content,
          quotedText: parsed.quoted_text,
        });

        let output = `Comment added to ${documentId}.\n\n`;
        output += `- **Comment ID:** ${comment.id ?? '(not returned)'}\n`;
        if (comment.author?.displayName) {
          output += `- **Author:** ${comment.author.displayName}\n`;
        }
        if (comment.createdTime) output += `- **Created:** ${comment.createdTime}\n`;
        const quoted = comment.quotedFileContent?.value?.trim();
        if (quoted) output += `- **Quoted text:** "${quoted}" (not anchored)\n`;

        return { content: [{ type: 'text', text: output.trimEnd() }] };
      } catch (error) {
        logError('add-comment-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error adding comment: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
