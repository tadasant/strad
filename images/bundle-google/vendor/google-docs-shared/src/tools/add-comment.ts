import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import type { DocsCommentThread, GoogleDoc } from '../types.js';
import { parseDocumentId } from '../utils/parse-document-id.js';
import { findPassage, type PassageMatch } from '../utils/find-passage.js';
import { findTab, flattenTabs, unknownTabError } from '../utils/tabs.js';
import { logError } from '../logging.js';

/** `InsertCommentRequest.content`'s ceiling, in UTF-8 bytes. Drive's own has no such limit. */
const MAX_ANCHORED_CONTENT_BYTES = 2048;
/** How many matches a refusal spells out before it just counts the rest. */
const MAX_LISTED_MATCHES = 5;

const PARAM_DESCRIPTIONS = {
  document_id: 'The Google Docs document ID, or the full document URL. Both forms are accepted.',
  content:
    'The comment text. Plain text; Docs renders it as written. Up to 2048 bytes when quoted_text ' +
    'is given. Example: "Should this say Q3 rather than Q2?"',
  quoted_text:
    'The passage of the document to attach the comment to, copied exactly, case and punctuation ' +
    'included. It is highlighted in the document and the comment sits beside it. Omit it for a ' +
    'comment on the document as a whole. Example: "Revenue grew 12% in Q2."',
  occurrence:
    'Which match of quoted_text to attach to, counting from 1 in document order, when it appears ' +
    'more than once. Omit it for a passage that appears once; a repeated one is refused with its ' +
    'matches listed. Example: 2',
  tab_id:
    'Search only this tab for quoted_text, e.g. "t.abc123" — get_document_outline lists tab ids. ' +
    'Omit it to search every tab.',
} as const;

const nonBlank = (s: string) => s.trim().length > 0;

export const AddCommentSchema = z
  .object({
    document_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.document_id),
    content: z
      .string()
      .refine(nonBlank, 'content must not be blank')
      .describe(PARAM_DESCRIPTIONS.content),
    quoted_text: z
      .string()
      .refine(nonBlank, 'quoted_text must not be blank')
      .optional()
      .describe(PARAM_DESCRIPTIONS.quoted_text),
    occurrence: z.number().int().min(1).optional().describe(PARAM_DESCRIPTIONS.occurrence),
    tab_id: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.tab_id),
  })
  .refine(
    (args) =>
      args.quoted_text !== undefined ||
      (args.occurrence === undefined && args.tab_id === undefined),
    'occurrence and tab_id locate quoted_text, so they need quoted_text'
  )
  .refine(
    (args) =>
      args.quoted_text === undefined ||
      Buffer.byteLength(args.content, 'utf8') <= MAX_ANCHORED_CONTENT_BYTES,
    `content must not exceed ${MAX_ANCHORED_CONTENT_BYTES} bytes when quoted_text is given`
  );

const TOOL_DESCRIPTION = `Add a comment to a Google Doc, as the account this server signs in as.

With \`quoted_text\`, the comment is attached to that passage: Docs highlights
it and shows the comment beside it, as if a person had selected the text and
commented. The server finds the passage in the body of the document, across
every tab unless \`tab_id\` narrows it, and sends a Docs \`insertComment\`
request for that range. Without \`quoted_text\`, the comment is about the
document as a whole and attaches to no text (Drive \`comments.create\`).

Reply to an existing thread with \`reply_to_comment\` instead.

**Parameters:**
- document_id: Document ID or full Docs URL (required)
- content: The comment text (required)
- quoted_text: The passage to attach the comment to, copied exactly (optional)
- occurrence: Which match of quoted_text, from 1, if it repeats (optional)
- tab_id: Search only this tab for quoted_text (optional)

**Refusals:** nothing is created when \`quoted_text\` is not found, or when it
appears more than once and \`occurrence\` is not given. The second refusal lists
the matches. Read the exact wording with \`get_document\`. Only the document
body is searched, not headers, footers or footnotes; for those, send an
\`insertComment\` request through \`update_document\`.

**Returns:** the new comment's ID (pass it to \`reply_to_comment\`), author,
time, and the passage it is attached to.

Google may notify people with access to the document, per their own Docs
notification settings, as it does for a comment made in the editor.`;

function tabLabel(doc: GoogleDoc, match: PassageMatch): string {
  return flattenTabs(doc).length > 1 ? `tab "${match.tab.path}" (${match.tab.tabId}), ` : '';
}

function choose(doc: GoogleDoc, quoted: string, matches: PassageMatch[], occurrence?: number) {
  if (matches.length === 0) {
    throw new Error(
      `quoted_text was not found in the document body: ${JSON.stringify(quoted)}. No comment was ` +
        'created. Copy the passage exactly from get_document. To comment on the document as a ' +
        'whole, omit quoted_text.'
    );
  }
  if (occurrence !== undefined && occurrence > matches.length) {
    throw new Error(
      `occurrence ${occurrence} is past the end: quoted_text appears ${matches.length} time(s). ` +
        'No comment was created.'
    );
  }
  if (occurrence === undefined && matches.length > 1) {
    const listed = matches
      .slice(0, MAX_LISTED_MATCHES)
      .map(
        (m, i) =>
          `${i + 1}. ${tabLabel(doc, m)}index ${m.startIndex}: ${JSON.stringify(m.context)}`
      )
      .join('\n');
    const rest = matches.length - MAX_LISTED_MATCHES;
    throw new Error(
      `quoted_text appears ${matches.length} times, so no comment was created. Pass occurrence ` +
        `to pick one, or a longer passage:\n${listed}` +
        (rest > 0 ? `\n…and ${rest} more.` : '')
    );
  }
  return matches[(occurrence ?? 1) - 1];
}

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
        occurrence: { type: 'integer', minimum: 1, description: PARAM_DESCRIPTIONS.occurrence },
        tab_id: { type: 'string', description: PARAM_DESCRIPTIONS.tab_id },
      },
      required: ['document_id', 'content'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = AddCommentSchema.parse(args ?? {});
        const documentId = parseDocumentId(parsed.document_id);
        const client = clientFactory();

        if (parsed.quoted_text === undefined) {
          const comment = await client.createComment(documentId, { content: parsed.content });
          let output = `Comment added to ${documentId}, on the document as a whole.\n\n`;
          output += `- **Comment ID:** ${comment.id ?? '(not returned)'}\n`;
          if (comment.author?.displayName) {
            output += `- **Author:** ${comment.author.displayName}\n`;
          }
          if (comment.createdTime) output += `- **Created:** ${comment.createdTime}\n`;
          return { content: [{ type: 'text', text: output.trimEnd() }] };
        }

        const doc = await client.getDocument(documentId, {
          includeTabsContent: true,
          suggestionsViewMode: 'SUGGESTIONS_INLINE',
        });
        let tabs = flattenTabs(doc);
        if (parsed.tab_id !== undefined) {
          const tab = findTab(doc, parsed.tab_id);
          if (!tab) throw unknownTabError(doc, parsed.tab_id);
          tabs = [tab];
        }
        const match = choose(
          doc,
          parsed.quoted_text,
          findPassage(doc, parsed.quoted_text, tabs),
          parsed.occurrence
        );

        const response = await client.batchUpdate(
          documentId,
          [
            {
              insertComment: {
                content: parsed.content,
                range: {
                  startIndex: match.startIndex,
                  endIndex: match.endIndex,
                  ...(match.tab.tabId ? { tabId: match.tab.tabId } : {}),
                },
              },
            },
          ],
          // The range was measured on this revision; Docs carries it over any
          // edit a collaborator lands between the read and this write.
          doc.revisionId ? { targetRevisionId: doc.revisionId } : undefined
        );

        const thread = (
          response.replies?.[0] as { insertComment?: { commentThread?: DocsCommentThread } }
        )?.insertComment?.commentThread;
        if (!thread?.commentId && response.commentUpdateState !== 'ALL_SAVED') {
          throw new Error(
            "Google's answer does not confirm the comment was saved " +
              `(commentUpdateState: ${response.commentUpdateState ?? 'absent'}). ` +
              'Check list_comments before retrying.'
          );
        }

        let output = `Comment added to ${documentId}, attached to a passage.\n\n`;
        output += `- **Comment ID:** ${thread?.commentId ?? '(not returned)'}\n`;
        if (thread?.headPost?.author?.displayName) {
          output += `- **Author:** ${thread.headPost.author.displayName}\n`;
        }
        if (thread?.headPost?.createTime) {
          output += `- **Created:** ${thread.headPost.createTime}\n`;
        }
        output += `- **Anchored to:** ${JSON.stringify(thread?.plainTextQuote ?? parsed.quoted_text)}\n`;
        output += `- **Location:** ${tabLabel(doc, match)}indexes ${match.startIndex}–${match.endIndex}\n`;

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
