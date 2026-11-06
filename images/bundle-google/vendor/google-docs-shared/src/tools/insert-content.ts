import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { parseDocumentId } from '../utils/parse-document-id.js';
import { parseMarkdown } from '../utils/markdown.js';
import { resolveHeading, type HeadingMatch } from '../utils/sections.js';
import {
  contentRequests,
  insertedLength,
  insertionPoint,
  type ContentPosition,
} from '../utils/content-requests.js';
import { findTab, flattenTabs, renderTabList, unknownTabError } from '../utils/tabs.js';
import {
  assertSuggestable,
  renderSuggestionResult,
  SUGGEST_PARAM_DESCRIPTION,
} from '../utils/suggest.js';
import { logError } from '../logging.js';

const POSITIONS = ['before_heading', 'after_heading', 'end_of_section', 'end_of_tab'] as const;

const NOTHING_CHANGED = 'Nothing was changed.';

const PARAM_DESCRIPTIONS = {
  document_id: 'The Google Docs document ID, or the full document URL. Both forms are accepted.',
  content:
    'What to insert, as markdown, e.g. "### Rollout\\n\\nFirst **bold** paragraph.\\n\\n- a bullet". ' +
    'Every non-blank line is one paragraph. Supported: # to ###### headings, paragraphs, - or * ' +
    'bullets, 1. numbered items (one level, no nesting), **bold**, *italic*, ***both***, `code` ' +
    'and [text](https://url). Tables, images, block quotes, code fences and horizontal rules are ' +
    'refused rather than written as punctuation. A backslash inserts a character literally ' +
    '(\\\\*, \\\\#). Headings and paragraphs take the document\'s own named styles.',
  position:
    'Where the content goes. "before_heading": directly above the heading. "after_heading": ' +
    'directly under the heading, before the section\'s existing text. "end_of_section": after ' +
    'everything in the section, just above the next heading of the same or a higher level (or ' +
    'at the end of the tab). "end_of_tab": at the end of the tab; takes no heading.',
  heading:
    'The heading to anchor on, by its text, e.g. "Agent Run Lifecycle". Case and spacing do not ' +
    'matter. An exact match wins; otherwise it matches as a prefix. Required unless heading_id ' +
    'is given or position is "end_of_tab".',
  heading_id:
    'The heading to anchor on, by id, e.g. "h.abc123". get_document_outline lists them. Use it ' +
    'instead of heading.',
  occurrence:
    'Which match to use, from 1, when the heading text repeats. A repeat with no occurrence is ' +
    'refused, listing each match.',
  tab_id:
    'Search only this tab, e.g. "t.abc123". Without it every tab is searched, and a heading ' +
    'found in two tabs is refused rather than guessed. Required for "end_of_tab" in a document ' +
    'with several tabs. get_document_outline lists the tab ids.',
  suggest: SUGGEST_PARAM_DESCRIPTION,
} as const;

export const InsertContentSchema = z.object({
  document_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.document_id),
  content: z.string().min(1).describe(PARAM_DESCRIPTIONS.content),
  position: z.enum(POSITIONS).describe(PARAM_DESCRIPTIONS.position),
  heading: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.heading),
  heading_id: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.heading_id),
  occurrence: z.number().int().min(1).optional().describe(PARAM_DESCRIPTIONS.occurrence),
  tab_id: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.tab_id),
  suggest: z.boolean().optional().describe(PARAM_DESCRIPTIONS.suggest),
});

const TOOL_DESCRIPTION = `Insert formatted content into a Google Doc, placed by heading, in any tab.

This is the tool for "add a section under X". It takes markdown and a heading,
works out the indexes itself, and sends one atomic batchUpdate with the text,
paragraph styles, inline styles and lists, so no index math is needed and
emoji or other non-ASCII text cannot throw a range off.

**Parameters:**
- document_id: Document ID or full Docs URL (required)
- content: Markdown to insert (required)
- position: before_heading, after_heading, end_of_section or end_of_tab (required)
- heading or heading_id: The anchor (required except for end_of_tab)
- occurrence: Which match, when the heading repeats (optional)
- tab_id: Limit the search to one tab (optional)
- suggest: Make the edit a suggestion rather than a direct change (optional,
  default false)

**Returns:**
The tab, the heading matched, the index the content went in at and how many
paragraphs it became. Example:

  # Content Inserted

  **Document ID:** 1AbC...
  **Tab:** Condensed (tab_id: \`t.92avce4pieh7\`)
  **Anchor:** before_heading, HEADING_2 "Agent Run Lifecycle"
  **Inserted at index:** 1842
  **Paragraphs:** 3
  **Length:** 212

**Use cases:**
- Add an H3 section with a few paragraphs above an existing heading
- Append a paragraph to the end of a section in the second tab
- Add a bulleted list directly under a heading
- Propose a new section for review with suggest=true
- Add to the end of one tab with position="end_of_tab"

**Refusals:** Nothing is sent when the heading is not found, when it repeats
with no occurrence (each match is listed with its tab), or when content holds
something the dialect cannot express.

**Notes:**
- Headings inside table cells are not anchors. Use get_document with
  format="outline_with_indices" and update_document to edit a cell.
- A section ends at the next heading of the same or a higher level, so an H2's
  section includes its H3s.
- Directly above a table, Docs accepts text only inside the paragraph before
  it, so after_heading on a heading followed by a table splits that heading's
  paragraph. The heading text and style stay; its heading_id may change.
- To place text at an exact index, use insert_text. For tables and images, use
  update_document.`;

function anchorError(parsed: z.infer<typeof InsertContentSchema>): string | undefined {
  const anchors = (parsed.heading !== undefined ? 1 : 0) + (parsed.heading_id !== undefined ? 1 : 0);
  if (anchors === 2) return 'Pass heading or heading_id, not both.';
  if (parsed.position === 'end_of_tab') {
    return anchors === 1 ? 'end_of_tab takes no heading; drop it or pick another position.' : undefined;
  }
  return anchors === 0 ? `${parsed.position} needs a heading or heading_id.` : undefined;
}

export function insertContentTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'insert_content',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: PARAM_DESCRIPTIONS.document_id },
        content: { type: 'string', description: PARAM_DESCRIPTIONS.content },
        position: {
          type: 'string',
          enum: [...POSITIONS],
          description: PARAM_DESCRIPTIONS.position,
        },
        heading: { type: 'string', description: PARAM_DESCRIPTIONS.heading },
        heading_id: { type: 'string', description: PARAM_DESCRIPTIONS.heading_id },
        occurrence: { type: 'integer', minimum: 1, description: PARAM_DESCRIPTIONS.occurrence },
        tab_id: { type: 'string', description: PARAM_DESCRIPTIONS.tab_id },
        suggest: { type: 'boolean', description: PARAM_DESCRIPTIONS.suggest },
      },
      required: ['document_id', 'content', 'position'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = InsertContentSchema.parse(args ?? {});
        const anchorProblem = anchorError(parsed);
        if (anchorProblem) throw new Error(`${anchorProblem} ${NOTHING_CHANGED}`);

        // Before any read, so a bad document is not what reports a bad content.
        const paragraphs = parseMarkdown(parsed.content);
        const documentId = parseDocumentId(parsed.document_id);
        const client = clientFactory();

        const doc = await client.getDocument(documentId, {
          includeTabsContent: true,
          suggestionsViewMode: 'SUGGESTIONS_INLINE',
        });
        const all = flattenTabs(doc);
        let tabs = all;
        if (parsed.tab_id !== undefined) {
          const tab = findTab(doc, parsed.tab_id);
          if (!tab) throw unknownTabError(doc, parsed.tab_id);
          tabs = [tab];
        }

        const position: ContentPosition = parsed.position;
        let heading: HeadingMatch | undefined;
        if (position !== 'end_of_tab') {
          heading = resolveHeading(doc, tabs, parsed, NOTHING_CHANGED);
        } else if (tabs.length > 1) {
          throw new Error(
            `This document has ${tabs.length} tabs, so end_of_tab needs a tab_id. ` +
              `${NOTHING_CHANGED}\n${renderTabList(tabs)}`
          );
        }

        const tab = heading?.tab ?? tabs[0];
        const point = insertionPoint(doc, position, tab, heading);
        const requests = contentRequests(paragraphs, point, tab.tabId || undefined);
        if (parsed.suggest) assertSuggestable(requests);

        // Measured on this revision; Docs carries the indexes over any edit a
        // collaborator lands between the read and this write.
        const writeControl = {
          ...(parsed.suggest ? { writeMode: 'SUGGEST' as const } : {}),
          ...(doc.revisionId ? { targetRevisionId: doc.revisionId } : {}),
        };
        const response = await client.batchUpdate(
          documentId,
          requests,
          Object.keys(writeControl).length > 0 ? writeControl : undefined
        );

        let output = parsed.suggest ? `# Content Suggested\n\n` : `# Content Inserted\n\n`;
        output += `**Document ID:** ${documentId}\n`;
        if (tab.tabId) output += `**Tab:** ${tab.path} (tab_id: \`${tab.tabId}\`)\n`;
        output += heading
          ? `**Anchor:** ${position}, ${heading.styleType} ${JSON.stringify(heading.text)}\n`
          : `**Anchor:** ${position}\n`;
        output += `**Inserted at index:** ${point.index}\n`;
        output += `**Paragraphs:** ${paragraphs.length}\n`;
        output += `**Length:** ${insertedLength(paragraphs)}\n`;
        if (parsed.suggest) output += renderSuggestionResult(response, requests.length);

        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('insert-content-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error inserting content: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
