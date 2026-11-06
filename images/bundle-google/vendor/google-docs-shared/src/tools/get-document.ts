import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import type { GoogleDoc } from '../types.js';
import { parseDocumentId } from '../utils/parse-document-id.js';
import { extractPlainText, extractHeadings, type HeadingEntry } from '../utils/extract-text.js';
import {
  findTab,
  flattenTabs,
  renderTabList,
  tabAsDocument,
  unknownTabError,
} from '../utils/tabs.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  document_id:
    'The Google Docs document ID, or the full document URL (e.g. ' +
    'https://docs.google.com/document/d/.../edit). Both forms are accepted.',
  format:
    'Output format. "text" (default) returns plain text plus an outline of ' +
    'headings — best for reading. "json" returns the raw Docs API document ' +
    'resource (suitable when constructing batchUpdate requests that need ' +
    'startIndex/endIndex values).',
  tab_id:
    'Read only this tab, e.g. "t.abc123" — get_document_outline lists every ' +
    "tab's id, nested child tabs included. Omit it to read every tab. A " +
    'document URL\'s "?tab=" is NOT read: Docs puts "?tab=t.0" on nearly ' +
    'every URL, so pass tab_id to narrow.',
} as const;

export const GetDocumentSchema = z.object({
  document_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.document_id),
  format: z.enum(['text', 'json']).optional().describe(PARAM_DESCRIPTIONS.format),
  tab_id: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.tab_id),
});

const TOOL_DESCRIPTION = `Fetch a Google Doc's content and metadata.

**Parameters:**
- document_id: Document ID or full Docs URL (required)
- format: "text" (default, human-readable) or "json" (raw Docs API resource)
- tab_id: Read only this tab (optional). Omit it to read every tab. A
  "?tab=" in a pasted URL does not narrow the read; pass tab_id.

**Tabs:** A document can have several tabs, nested under each other. Every
tab is read, not only the first.
- One tab: the output is the same as for any single-tab document.
- Several tabs, no tab_id: format=text lists the tabs, then each tab's
  outline and body under its own heading, parent tabs before their children.
  format=json is the full resource with every tab under "tabs" (each tab's
  content is at tabs[].documentTab.body, child tabs under childTabs).
- tab_id: just that tab, shaped like a single-tab document; format=json puts
  the tab's body at the top level, with its "tabProperties".

**Pending suggestions:** for an account that can edit or comment, the body
holds them inline, so text proposed for deletion and text proposed for
insertion both appear, unmarked, side by side. format=json marks them with
suggestedDeletionIds and suggestedInsertionIds, and its indices are the ones
to use for edits.

**Returns:**
For format=text:
- Document title and ID
- Heading outline (TITLE / H1-H6) for navigation
- Full plain-text body

For format=json:
- The Docs API document resource as JSON. Use this when you need
  startIndex / endIndex values to build update_document requests. Indices are
  per tab: an edit to any tab but the first needs that tab's "tabId" in its
  location (see update_document).

**Tip:** If you only need the structure, or a document's tab ids, use
get_document_outline instead — it's lighter.`;

export function getDocumentTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'get_document',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.document_id,
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: PARAM_DESCRIPTIONS.format,
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
        const parsed = GetDocumentSchema.parse(args ?? {});
        const documentId = parseDocumentId(parsed.document_id);
        const client = clientFactory();

        const doc = await client.getDocument(documentId, { includeTabsContent: true });
        const tabs = flattenTabs(doc);

        if (parsed.tab_id !== undefined) {
          const tab = findTab(doc, parsed.tab_id);
          if (!tab) throw unknownTabError(doc, parsed.tab_id);
          const tabDoc = tabAsDocument(doc, tab);
          if (parsed.format === 'json') {
            return json({ ...tabDoc, tabProperties: tab.tab.tabProperties });
          }
          let output = header(doc);
          output += `**Tab:** ${tab.path} (tab_id: \`${tab.tabId}\`)\n`;
          if (tabs.length > 1) {
            output += `**Other tabs:** ${tabs.length - 1} more in this document; omit tab_id to read them all.\n`;
          }
          output += '\n';
          output += renderContent(tabDoc, '##', 'tab');
          return text(output);
        }

        // A document with one tab reads as it does fetched without
        // includeTabsContent: the same text, and JSON with the same fields.
        if (tabs.length === 1) {
          const tabDoc = tabAsDocument(doc, tabs[0]);
          if (parsed.format === 'json') return json(tabDoc);
          return text(header(doc) + renderContent(tabDoc, '##'));
        }

        if (parsed.format === 'json') return json(doc);

        let output = header(doc);
        output += `## Tabs\n\n${renderTabList(tabs)}\n`;
        for (const tab of tabs) {
          output += `## Tab: ${tab.path}\n\n`;
          output += `**Tab ID:** ${tab.tabId}\n\n`;
          output += renderContent(tabAsDocument(doc, tab), '###', 'tab');
          output += '\n\n';
        }
        return text(output.trimEnd());
      } catch (error) {
        logError('get-document-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error retrieving document: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}

function header(doc: GoogleDoc): string {
  let output = `# ${doc.title || '(Untitled Document)'}\n\n`;
  output += `**Document ID:** ${doc.documentId}\n`;
  if (doc.revisionId) {
    output += `**Revision:** ${doc.revisionId}\n`;
  }
  return output + '\n';
}

/** A document's (or one tab's) outline and body, under headings at `level`. */
function renderContent(doc: GoogleDoc, level: string, what: 'document' | 'tab' = 'document'): string {
  const headings = extractHeadings(doc);
  const body = extractPlainText(doc);
  let output = '';
  if (headings.length > 0) {
    output += `${level} Outline\n\n${renderHeadings(headings)}\n`;
  }
  output += `${level} Body\n\n`;
  output += body.length > 0 ? body : `(empty ${what})`;
  return output;
}

function renderHeadings(headings: HeadingEntry[]): string {
  let output = '';
  for (const h of headings) {
    const indent = h.level === 0 ? '' : '  '.repeat(Math.max(0, h.level - 1));
    const prefix = h.level === 0 ? `[${h.styleType}]` : `H${h.level}`;
    output += `${indent}- ${prefix}: ${h.text}\n`;
  }
  return output;
}

function text(output: string) {
  return { content: [{ type: 'text', text: output }] };
}

function json(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
