import type { GoogleDoc, Tab } from '../types.js';

/**
 * One tab of a document, flattened out of the tab tree.
 *
 * `path` is the tab's title prefixed by every ancestor's (`Parent / Child`),
 * which is what tells two same-titled child tabs apart in a listing. `depth`
 * is 0 for a top-level tab.
 */
export interface FlatTab {
  tabId: string;
  title: string;
  path: string;
  depth: number;
  parentTabId?: string;
  tab: Tab;
}

/**
 * Every tab in document order — depth-first, a parent before its children,
 * siblings in `index` order — so a listing reads the way the tab sidebar does.
 *
 * A document fetched WITHOUT `includeTabsContent` (or a response that carries
 * no `tabs` at all) is read as one tab holding the legacy top-level content,
 * with an empty tab id: there is nothing else to list, and no id to give it.
 */
export function flattenTabs(doc: GoogleDoc): FlatTab[] {
  if (!doc.tabs || doc.tabs.length === 0) {
    return [
      {
        tabId: '',
        title: doc.title || '(Untitled Document)',
        path: doc.title || '(Untitled Document)',
        depth: 0,
        tab: { documentTab: legacyContent(doc) },
      },
    ];
  }

  const out: FlatTab[] = [];
  const walk = (tabs: Tab[], depth: number, prefix: string): void => {
    const ordered = [...tabs].sort(
      (a, b) => (a.tabProperties?.index ?? 0) - (b.tabProperties?.index ?? 0)
    );
    for (const tab of ordered) {
      const title = tab.tabProperties?.title || '(Untitled Tab)';
      const path = prefix ? `${prefix} / ${title}` : title;
      out.push({
        tabId: tab.tabProperties?.tabId ?? '',
        title,
        path,
        depth,
        parentTabId: tab.tabProperties?.parentTabId,
        tab,
      });
      walk(tab.childTabs ?? [], depth + 1, path);
    }
  };
  walk(doc.tabs, 0, '');
  return out;
}

/** The tab with this id, anywhere in the tree, or undefined. */
export function findTab(doc: GoogleDoc, tabId: string): FlatTab | undefined {
  return flattenTabs(doc).find((t) => t.tabId === tabId);
}

/**
 * One tab read as if it were a whole single-tab document: the document's
 * identity (`documentId`, `title`, `revisionId`, …) with the tab's
 * `documentTab` fields (`body`, `lists`, `inlineObjects`, …) lifted to the top
 * level, where `documents.get` without `includeTabsContent` puts them.
 *
 * That is the shape every text extractor in `extract-text.ts` reads, and for a
 * single-tab document it is the legacy `format=json` resource, so a caller that
 * never heard of tabs sees what it always saw. `tabs` is dropped: the content
 * it held is the content now at the top level.
 */
export function tabAsDocument(doc: GoogleDoc, flat: FlatTab): GoogleDoc {
  const { tabs: _tabs, ...rest } = doc;
  return { ...rest, ...(flat.tab.documentTab ?? {}), documentId: doc.documentId, title: doc.title };
}

/** A tab id that does not exist, answered with the ids that do. */
export function unknownTabError(doc: GoogleDoc, tabId: string): Error {
  const known = flattenTabs(doc)
    .filter((t) => t.tabId)
    .map((t) => `"${t.tabId}" (${t.path})`);
  return new Error(
    `Tab "${tabId}" not found in document ${doc.documentId}. ` +
      (known.length > 0
        ? `Its tabs are: ${known.join(', ')}.`
        : 'The document reported no tab ids.') +
      ' Call get_document_outline to list them.'
  );
}

/** Renders the tab tree as an indented markdown list, one line per tab. */
export function renderTabList(tabs: FlatTab[]): string {
  let out = '';
  for (const t of tabs) {
    out += `${'  '.repeat(t.depth)}- ${t.title} (tab_id: \`${t.tabId}\`)\n`;
  }
  return out;
}

const CONTENT_KEYS_OF_LEGACY_DOC = [
  'body',
  'headers',
  'footers',
  'footnotes',
  'documentStyle',
  'suggestedDocumentStyleChanges',
  'namedStyles',
  'suggestedNamedStylesChanges',
  'lists',
  'namedRanges',
  'inlineObjects',
  'positionedObjects',
] as const;

function legacyContent(doc: GoogleDoc): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CONTENT_KEYS_OF_LEGACY_DOC) {
    if (doc[key] !== undefined) out[key] = doc[key];
  }
  return out;
}

/**
 * The tab a Docs URL points at — `…/edit?tab=t.abc123` — or undefined for a
 * bare id or a URL with no tab. A link copied while a tab is open carries it,
 * and reading the first tab instead of the one linked is the wrong answer.
 */
export function parseTabIdFromUrl(input: string): string | undefined {
  return input.match(/[?&#]tab=([A-Za-z0-9._-]+)/)?.[1];
}
