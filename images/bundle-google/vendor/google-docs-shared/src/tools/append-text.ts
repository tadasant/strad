import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import type { DocsBatchUpdateRequest } from '../types.js';
import { parseDocumentId } from '../utils/parse-document-id.js';
import { getEndOfBodyIndex } from '../utils/extract-text.js';
import { findTab, tabAsDocument, unknownTabError } from '../utils/tabs.js';
import { renderSuggestionResult, SUGGEST_PARAM_DESCRIPTION } from '../utils/suggest.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  document_id: 'The Google Docs document ID, or the full document URL. Both forms are accepted.',
  text:
    'The plain text to append to the end of the document. Newlines are preserved. ' +
    'For most cases, prefix with "\\n" if you want a paragraph break before the new content.',
  tab_id:
    'The tab to append to, e.g. "t.abc123"; get_document_outline lists them. Omitted, the text ' +
    'goes to the end of the first tab.',
  suggest: SUGGEST_PARAM_DESCRIPTION,
} as const;

export const AppendTextSchema = z.object({
  document_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.document_id),
  text: z.string().min(1).describe(PARAM_DESCRIPTIONS.text),
  tab_id: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.tab_id),
  suggest: z.boolean().optional().describe(PARAM_DESCRIPTIONS.suggest),
});

const TOOL_DESCRIPTION = `Append plain text to the end of a Google Doc.

Convenience wrapper around update_document. Looks up the current end-of-body
index, then issues an insertText request that adds the provided text just
before the trailing newline. With suggest=true the text is proposed as a
suggestion for a human to accept, instead of being written directly.

**Parameters:**
- document_id: Document ID or full Docs URL (required)
- text: Plain text to append (required)
- tab_id: The tab to append to (optional, default the first tab)
- suggest: Make the edit a suggestion rather than a direct change (optional,
  default false)

**Notes:**
- For formatted content, or to place text by heading, use insert_content.
- This requires a round-trip to fetch the document first to determine the
  insertion index.`;

export function appendTextTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'append_text',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.document_id,
        },
        text: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.text,
        },
        tab_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.tab_id,
        },
        suggest: {
          type: 'boolean',
          description: PARAM_DESCRIPTIONS.suggest,
        },
      },
      required: ['document_id', 'text'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = AppendTextSchema.parse(args ?? {});
        const documentId = parseDocumentId(parsed.document_id);
        const client = clientFactory();

        const doc = await client.getDocument(documentId, {
          suggestionsViewMode: 'SUGGESTIONS_INLINE',
          ...(parsed.tab_id ? { includeTabsContent: true } : {}),
        });
        let target = doc;
        if (parsed.tab_id) {
          const tab = findTab(doc, parsed.tab_id);
          if (!tab) throw unknownTabError(doc, parsed.tab_id);
          target = tabAsDocument(doc, tab);
        }
        const insertIndex = getEndOfBodyIndex(target);

        const requests: DocsBatchUpdateRequest[] = [
          {
            insertText: {
              location: {
                index: insertIndex,
                ...(parsed.tab_id ? { tabId: parsed.tab_id } : {}),
              },
              text: parsed.text,
            },
          },
        ];
        const response = await client.batchUpdate(
          documentId,
          requests,
          parsed.suggest ? { writeMode: 'SUGGEST' } : undefined
        );

        let output = parsed.suggest ? `# Appended Text Suggested\n\n` : `# Text Appended\n\n`;
        output += `**Document ID:** ${documentId}\n`;
        if (parsed.tab_id) output += `**Tab ID:** ${parsed.tab_id}\n`;
        output += `**Inserted at index:** ${insertIndex}\n`;
        output += `**Characters:** ${parsed.text.length}\n`;
        if (parsed.suggest) output += renderSuggestionResult(response);

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      } catch (error) {
        logError('append-text-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error appending text: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
