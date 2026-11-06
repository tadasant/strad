import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { parseDocumentId } from '../utils/parse-document-id.js';
import { extractHeadings, type HeadingEntry, type HeadingPlace } from '../utils/extract-text.js';
import { findTab, flattenTabs, tabAsDocument, unknownTabError } from '../utils/tabs.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  document_id: 'The Google Docs document ID, or the full document URL. Both forms are accepted.',
  tab_id:
    'Outline only this tab, e.g. "t.abc123". Omit it to outline every tab, ' +
    'which is also how to learn the tab ids.',
} as const;

export const GetDocumentOutlineSchema = z.object({
  document_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.document_id),
  tab_id: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.tab_id),
});

const TOOL_DESCRIPTION = `List the headings in a Google Doc as a navigable outline.

Each heading carries its start index and, when Docs has given it one, its
heading_id, which insert_content and get_document take as an anchor.

Returns the title plus every TITLE/SUBTITLE/HEADING_1..HEADING_6 paragraph in
document order. Useful for quickly understanding a document's structure
without fetching the full body.

**Tabs:** A document with several tabs gets one section per tab, nested
child tabs included, each headed by the tab's path and its tab_id — the id
get_document, insert_content and the edit tools take to address that tab. A single-tab
document's outline has no tab sections.

**Parameters:**
- document_id: Document ID or full Docs URL (required)
- tab_id: Outline only this tab (optional)

**Returns:**
Markdown-formatted outline indented by heading level.`;

export function getDocumentOutlineTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'get_document_outline',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.document_id,
        },
        tab_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.tab_id,
        },
      },
      required: ['document_id'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = GetDocumentOutlineSchema.parse(args ?? {});
        const documentId = parseDocumentId(parsed.document_id);
        const client = clientFactory();

        const doc = await client.getDocument(documentId, { includeTabsContent: true });
        let tabs = flattenTabs(doc);
        if (parsed.tab_id !== undefined) {
          const tab = findTab(doc, parsed.tab_id);
          if (!tab) throw unknownTabError(doc, parsed.tab_id);
          tabs = [tab];
        }

        let output = `# Outline: ${doc.title || '(Untitled Document)'}\n\n`;
        output += `**Document ID:** ${doc.documentId}\n\n`;

        if (tabs.length === 1 && parsed.tab_id === undefined) {
          output += renderHeadings(extractHeadings(tabAsDocument(doc, tabs[0])), 'document');
        } else {
          for (const tab of tabs) {
            output += `## Tab: ${tab.path}\n\n`;
            output += `**Tab ID:** ${tab.tabId}\n\n`;
            output += renderHeadings(extractHeadings(tabAsDocument(doc, tab)), 'tab');
            output += '\n';
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
        logError('get-document-outline-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error retrieving outline: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}

function renderHeadings(headings: Array<HeadingEntry & HeadingPlace>, what: 'document' | 'tab'): string {
  if (headings.length === 0) return `_No headings found in this ${what}._\n`;
  let output = '';
  for (const h of headings) {
    const indent = h.level === 0 ? '' : '  '.repeat(Math.max(0, h.level - 1));
    const prefix = h.level === 0 ? `[${h.styleType}]` : `H${h.level}`;
    const id = h.headingId ? `, heading_id: ${h.headingId}` : '';
    output += `${indent}- ${prefix}: ${h.text} (index ${h.startIndex}${id})\n`;
  }
  return output;
}
