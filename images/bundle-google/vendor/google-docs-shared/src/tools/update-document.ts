import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import type { DocsBatchUpdateRequest } from '../types.js';
import { parseDocumentId } from '../utils/parse-document-id.js';
import {
  assertSuggestable,
  renderSuggestionResult,
  SUGGEST_PARAM_DESCRIPTION,
} from '../utils/suggest.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  document_id: 'The Google Docs document ID, or the full document URL. Both forms are accepted.',
  requests:
    'Array of Docs API batchUpdate requests. Each item is a single-key object ' +
    'whose key is the operation name (e.g. insertText, deleteContentRange, ' +
    'updateTextStyle, replaceAllText, createParagraphBullets, ' +
    'updateParagraphStyle) and whose value is the operation payload. See ' +
    'https://developers.google.com/docs/api/reference/rest/v1/documents/request ' +
    'for the full schema. The requests are applied as a single atomic transaction.',
  suggest:
    SUGGEST_PARAM_DESCRIPTION +
    ' Applies to every request in the array. Requests Docs cannot suggest are refused by name ' +
    'before anything is sent.',
} as const;

export const UpdateDocumentSchema = z.object({
  document_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.document_id),
  requests: z.array(z.record(z.unknown())).min(1).describe(PARAM_DESCRIPTIONS.requests),
  suggest: z.boolean().optional().describe(PARAM_DESCRIPTIONS.suggest),
});

const TOOL_DESCRIPTION = `Apply low-level Google Docs batchUpdate requests to a document (escape hatch).

This is the most powerful but also the most error-prone tool — it accepts the
raw Docs API request union directly. Use it for operations the convenience
tools (insert_content, append_text, insert_text, replace_text) don't cover:
tables, images, deletions, styling existing text, etc. To add headings,
paragraphs or lists under a heading, use insert_content, which does the index
math.

**Parameters:**
- document_id: Document ID or full Docs URL (required)
- requests: Array of batchUpdate request objects (required, min 1).
  Examples:
    [{ "insertText": { "location": { "index": 1 }, "text": "Hello" } }]
    [{ "deleteContentRange": { "range": { "startIndex": 1, "endIndex": 5 } } }]
    [{ "replaceAllText": { "containsText": { "text": "{{name}}", "matchCase": true }, "replaceText": "Alice" } }]
- suggest: Make every request in the array a suggestion rather than a direct
  change (optional, default false)

**Tip:** Call get_document with format="outline_with_indices" (and a heading,
to read one section) for exact startIndex / endIndex values.

**Tabs:** In a document with several tabs, a request edits the FIRST tab
unless its location or range carries a "tabId" (e.g.
{ "location": { "index": 1, "tabId": "t.abc123" } }). get_document_outline
lists the tab ids; get_document with tab_id and format="outline_with_indices"
gives that tab's indices. replaceAllText applies to every tab unless its tabsCriteria narrows it.

**Suggest mode:** Docs refuses addDocumentTab, createNamedRange, deleteFooter,
deleteHeader, deleteNamedRange, deleteTab, updateDocumentTabProperties and
updateTableColumnProperties as suggestions, and updateDocumentStyle changes to
documentFormat, useEvenPageHeaderFooter or useFirstPageHeaderFooter. Send those
without suggest. Requests on comment or suggestion threads (insertComment,
acceptSuggestion and the like) are not edits and are refused with suggest too.

**Comments:** add_comment anchors to a passage of a tab's body. For a range
add_comment cannot name, such as text in a footnote, or to assign a comment,
send an insertComment request here.

**Returns:**
The Docs API batchUpdate response (replies array + documentId), serialized as JSON.`;

export function updateDocumentTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'update_document',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.document_id,
        },
        requests: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: true,
          },
          description: PARAM_DESCRIPTIONS.requests,
        },
        suggest: {
          type: 'boolean',
          description: PARAM_DESCRIPTIONS.suggest,
        },
      },
      required: ['document_id', 'requests'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = UpdateDocumentSchema.parse(args ?? {});
        const documentId = parseDocumentId(parsed.document_id);
        const client = clientFactory();

        const requests = parsed.requests as DocsBatchUpdateRequest[];
        if (parsed.suggest) assertSuggestable(requests);

        const response = await client.batchUpdate(
          documentId,
          requests,
          parsed.suggest ? { writeMode: 'SUGGEST' } : undefined
        );

        const repliesCount = Array.isArray(response.replies) ? response.replies.length : 0;
        let output = `# Document Updated\n\n`;
        output += `**Document ID:** ${response.documentId}\n`;
        output += `**Requests applied:** ${parsed.requests.length}\n`;
        output += `**Replies returned:** ${repliesCount}\n`;
        if (parsed.suggest) output += renderSuggestionResult(response, requests.length);
        output += '\n';
        output += `## Raw Response\n\n\`\`\`json\n${JSON.stringify(response, null, 2)}\n\`\`\``;

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      } catch (error) {
        logError('update-document-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error updating document: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
