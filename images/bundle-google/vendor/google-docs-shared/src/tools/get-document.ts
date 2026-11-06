import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import type { GoogleDoc, StructuralElement } from '../types.js';
import { parseDocumentId } from '../utils/parse-document-id.js';
import { extractPlainText, extractHeadings, type HeadingEntry } from '../utils/extract-text.js';
import {
  findTab,
  flattenTabs,
  type FlatTab,
  renderTabList,
  tabAsDocument,
  unknownTabError,
} from '../utils/tabs.js';
import {
  elementsInRange,
  narrowedDocument,
  renderIndexedLines,
  withoutDocumentTables,
  withoutStyles,
} from '../utils/document-view.js';
import { resolveHeading, sectionElements, type HeadingMatch } from '../utils/sections.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  document_id:
    'The Google Docs document ID, or the full document URL (e.g. ' +
    'https://docs.google.com/document/d/.../edit). Both forms are accepted.',
  format:
    'Output format. "text" (default) returns plain text plus an outline of ' +
    'headings — best for reading. "outline_with_indices" returns one line per ' +
    'paragraph: startIndex-endIndex, style and the first 80 characters — the ' +
    'smallest way to find an index. "json" returns the raw Docs API document ' +
    'resource, which is very large on a real document; narrow it with heading, ' +
    'include_styles or skip_tables.',
  tab_id:
    'Read only this tab, e.g. "t.abc123" — get_document_outline lists every ' +
    "tab's id, nested child tabs included. Omit it to read every tab. A " +
    'document URL\'s "?tab=" is NOT read: Docs puts "?tab=t.0" on nearly ' +
    'every URL, so pass tab_id to narrow.',
  heading:
    'Read only this heading\'s section: the heading and everything up to the next ' +
    'heading of the same or a higher level. Matched by text, ignoring case; an exact ' +
    'match wins, otherwise it matches as a prefix. Every tab is searched unless tab_id ' +
    'narrows it, and a repeat is refused with each match listed.',
  heading_id:
    'Read only this heading\'s section, by id, e.g. "h.abc123". get_document_outline ' +
    'lists them. Use it instead of heading.',
  occurrence: 'Which match to use, from 1, when heading repeats.',
  start_index:
    'Read only the top-level paragraphs and tables overlapping indexes from this one. ' +
    'An element that overlaps comes back whole. Indexes are per tab, so a document with ' +
    'several tabs needs tab_id. Cannot be combined with heading.',
  end_index: 'The exclusive end of the start_index range. Omitted, it runs to the end of the tab.',
  include_styles:
    'format="json" only. false drops text, paragraph, table and document styling and ' +
    'list definitions, keeping the text, indexes, namedStyleType, headingId and ' +
    'suggestion ids. Links are styling here, so they go too. Defaults to true.',
  skip_tables:
    'true reduces each top-level table to its place and size: one line in ' +
    'outline_with_indices, a { rows, columns } stub in json, nothing in text. Defaults to false.',
} as const;

export const GetDocumentSchema = z.object({
  document_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.document_id),
  format: z
    .enum(['text', 'json', 'outline_with_indices'])
    .optional()
    .describe(PARAM_DESCRIPTIONS.format),
  tab_id: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.tab_id),
  heading: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.heading),
  heading_id: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.heading_id),
  occurrence: z.number().int().min(1).optional().describe(PARAM_DESCRIPTIONS.occurrence),
  start_index: z.number().int().min(0).optional().describe(PARAM_DESCRIPTIONS.start_index),
  end_index: z.number().int().min(1).optional().describe(PARAM_DESCRIPTIONS.end_index),
  include_styles: z.boolean().optional().describe(PARAM_DESCRIPTIONS.include_styles),
  skip_tables: z.boolean().optional().describe(PARAM_DESCRIPTIONS.skip_tables),
});

type GetDocumentArgs = z.infer<typeof GetDocumentSchema>;

const TOOL_DESCRIPTION = `Fetch a Google Doc's content and metadata.

**Parameters:**
- document_id: Document ID or full Docs URL (required)
- format: "text" (default, human-readable), "outline_with_indices" (one line
  per paragraph with its indexes) or "json" (raw Docs API resource)
- tab_id: Read only this tab (optional). Omit it to read every tab. A
  "?tab=" in a pasted URL does not narrow the read; pass tab_id.
- heading or heading_id: Read only that section, in any format (optional)
- occurrence: Which match, when heading repeats (optional)
- start_index, end_index: Read only that index range of a tab (optional)
- include_styles: false strips styling from format=json (optional)
- skip_tables: true reduces tables to their size (optional)

**Finding where to edit:** format="json" of a whole document is usually too big
for a client to hold. To add content, insert_content takes a heading and needs
no index. For an index, read format="outline_with_indices", with heading to
keep it to one section.

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

For format=outline_with_indices, one line per paragraph, and for a table one
line then its cells' paragraphs:
  1-24 HEADING_2 heading_id=h.abc "Agent Run Lifecycle"
  24-90 NORMAL_TEXT "Each run starts when…"
  90-412 TABLE 5x4
    r1c1 92-101 NORMAL_TEXT "Stage"
Also marked: list-item, image, suggestion-pending. An index range is
start-inclusive, end-exclusive, in UTF-16 code units, per tab.

For format=json:
- The Docs API document resource as JSON. Indices are per tab: an edit to any
  tab but the first needs that tab's "tabId" in its location (see
  update_document).
- With heading or a range: the identity fields, the tab's "tabProperties", the
  section's bounds, and "body" holding those elements alone.

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
          enum: ['text', 'json', 'outline_with_indices'],
          description: PARAM_DESCRIPTIONS.format,
        },
        tab_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.tab_id,
        },
        heading: { type: 'string', description: PARAM_DESCRIPTIONS.heading },
        heading_id: { type: 'string', description: PARAM_DESCRIPTIONS.heading_id },
        occurrence: { type: 'integer', minimum: 1, description: PARAM_DESCRIPTIONS.occurrence },
        start_index: { type: 'integer', minimum: 0, description: PARAM_DESCRIPTIONS.start_index },
        end_index: { type: 'integer', minimum: 1, description: PARAM_DESCRIPTIONS.end_index },
        include_styles: { type: 'boolean', description: PARAM_DESCRIPTIONS.include_styles },
        skip_tables: { type: 'boolean', description: PARAM_DESCRIPTIONS.skip_tables },
      },
      required: ['document_id'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = GetDocumentSchema.parse(args ?? {});
        const documentId = parseDocumentId(parsed.document_id);
        const client = clientFactory();

        const fetched = await client.getDocument(documentId, { includeTabsContent: true });
        const doc = parsed.skip_tables ? withoutDocumentTables(fetched) : fetched;
        const tabs = flattenTabs(doc);
        const json = (value: unknown) =>
          jsonResult(parsed.include_styles === false ? withoutStyles(value) : value);

        const byHeading = parsed.heading !== undefined || parsed.heading_id !== undefined;
        const byRange = parsed.start_index !== undefined || parsed.end_index !== undefined;
        if (byHeading || byRange) return narrowed(doc, tabs, parsed, json);

        if (parsed.format === 'outline_with_indices') {
          const shown = parsed.tab_id === undefined ? tabs : [requireTab(doc, parsed.tab_id)];
          let output = header(doc);
          if (tabs.length > 1 && parsed.tab_id === undefined) {
            output += `## Tabs\n\n${renderTabList(tabs)}\n`;
          }
          for (const tab of shown) {
            if (tabs.length > 1) output += `## Tab: ${tab.path} (tab_id: \`${tab.tabId}\`)\n\n`;
            output += `${renderIndexedLines(tab.tab.documentTab?.body?.content ?? [])}\n`;
          }
          return text(output.trimEnd());
        }

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

function requireTab(doc: GoogleDoc, tabId: string): FlatTab {
  const tab = findTab(doc, tabId);
  if (!tab) throw unknownTabError(doc, tabId);
  return tab;
}

/** A read of one section or one index range, in whichever format was asked for. */
function narrowed(
  doc: GoogleDoc,
  tabs: FlatTab[],
  parsed: GetDocumentArgs,
  json: (value: unknown) => ReturnType<typeof text>
) {
  const byHeading = parsed.heading !== undefined || parsed.heading_id !== undefined;
  if (parsed.heading !== undefined && parsed.heading_id !== undefined) {
    throw new Error('Pass heading or heading_id, not both.');
  }
  if (byHeading && (parsed.start_index !== undefined || parsed.end_index !== undefined)) {
    throw new Error('Pass a heading or an index range, not both.');
  }
  const { start_index: start, end_index: end } = parsed;
  if (start !== undefined && end !== undefined && end <= start) {
    throw new Error(`end_index ${end} must be greater than start_index ${start}.`);
  }

  const searched = parsed.tab_id === undefined ? tabs : [requireTab(doc, parsed.tab_id)];
  let tab: FlatTab;
  let match: HeadingMatch | undefined;
  let body: StructuralElement[];

  if (byHeading) {
    match = resolveHeading(doc, searched, parsed, 'Nothing was read.');
    tab = match.tab;
    body = sectionElements(doc, match);
  } else {
    if (searched.length > 1) {
      throw new Error(
        `Indexes are per tab and this document has ${searched.length}, so a range needs a ` +
          `tab_id:\n${renderTabList(searched)}`
      );
    }
    tab = searched[0];
    body = elementsInRange(tab.tab.documentTab?.body?.content ?? [], start, end);
  }

  const bounds = {
    startIndex: body[0]?.startIndex ?? 0,
    endIndex: body[body.length - 1]?.endIndex ?? 0,
  };

  if (parsed.format === 'json') {
    return json(
      narrowedDocument(doc, body, {
        tabProperties: tab.tab.tabProperties,
        ...(match
          ? {
              section: {
                heading: match.text,
                styleType: match.styleType,
                ...(match.headingId ? { headingId: match.headingId } : {}),
                ...bounds,
              },
            }
          : {}),
      })
    );
  }

  let output = header(doc);
  if (tab.tabId) output += `**Tab:** ${tab.path} (tab_id: \`${tab.tabId}\`)\n`;
  output += match
    ? `**Section:** ${match.styleType} ${JSON.stringify(match.text)}, indexes ${bounds.startIndex}-${bounds.endIndex}\n\n`
    : `**Range:** indexes ${bounds.startIndex}-${bounds.endIndex}\n\n`;

  if (parsed.format === 'outline_with_indices') return text((output + renderIndexedLines(body)).trimEnd());

  const view: GoogleDoc = { documentId: doc.documentId, body: { content: body } };
  return text(output + renderContent(view, '##', 'tab'));
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

function jsonResult(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
