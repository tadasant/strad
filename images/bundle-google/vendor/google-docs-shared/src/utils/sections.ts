import type { GoogleDoc, StructuralElement } from '../types.js';
import { extractHeadings, type HeadingEntry, type HeadingPlace } from './extract-text.js';
import { tabAsDocument, type FlatTab } from './tabs.js';

/** A heading found in a tab, with what is needed to address its section. */
export interface HeadingMatch extends HeadingEntry, HeadingPlace {
  tab: FlatTab;
}

export interface HeadingSelector {
  heading?: string;
  heading_id?: string;
  occurrence?: number;
}

const MAX_LISTED = 12;

/**
 * What two spellings of one heading have in common. U+FE0F is folded because
 * `🖼️` and `🖼` look identical and an agent cannot tell which one it was given.
 */
function fold(text: string): string {
  return text
    .normalize('NFC')
    .replace(/️/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** A heading without what leads it: `🖼️ Agent Run` is found as "Agent Run". */
function bare(text: string): string {
  return fold(text).replace(/^[^\p{L}\p{N}]+/u, '');
}

export function tabHeadings(doc: GoogleDoc, tab: FlatTab): HeadingMatch[] {
  return extractHeadings(tabAsDocument(doc, tab)).map((h) => ({ ...h, tab }));
}

function describe(m: HeadingMatch, tabs: FlatTab[]): string {
  const where = tabs.length > 1 ? `tab "${m.tab.path}" (tab_id: ${m.tab.tabId}), ` : '';
  const id = m.headingId ? ` (heading_id: ${m.headingId})` : '';
  return `${where}${m.styleType} ${JSON.stringify(m.text)} at index ${m.startIndex}${id}`;
}

/**
 * Resolves a selector to exactly one heading in `tabs`, in document order. An
 * exact match beats a prefix, so "Overview" does not lose to "Overview of Q3",
 * and either beats the same comparison with leading symbols ignored.
 * A miss or a repeat is refused with the candidates: a section edit that lands
 * under the wrong heading is worse than one that does not happen.
 *
 * `consequence` is what the refusal says happened, e.g. "Nothing was changed."
 */
export function resolveHeading(
  doc: GoogleDoc,
  tabs: FlatTab[],
  selector: HeadingSelector,
  consequence: string
): HeadingMatch {
  const all = tabs.flatMap((tab) => tabHeadings(doc, tab));
  let matches: HeadingMatch[];
  let asked: string;

  if (selector.heading_id !== undefined) {
    asked = `heading_id ${JSON.stringify(selector.heading_id)}`;
    matches = all.filter((h) => h.headingId === selector.heading_id);
  } else {
    asked = `heading ${JSON.stringify(selector.heading)}`;
    const wanted = selector.heading ?? '';
    const tiers: Array<(view: string) => boolean> = [
      (view) => fold(view) === fold(wanted),
      (view) => fold(view).startsWith(fold(wanted)),
      (view) => bare(view) === bare(wanted),
      (view) => bare(view).startsWith(bare(wanted)),
    ];
    matches = [];
    for (const tier of tiers) {
      if (bare(wanted).length === 0 && tier !== tiers[0]) break;
      matches = all.filter((h) => h.views.some(tier));
      if (matches.length > 0) break;
    }
  }

  if (matches.length === 0) {
    const known = all.slice(0, MAX_LISTED).map((h) => `- ${describe(h, tabs)}`);
    throw new Error(
      `${asked} matches no heading. ${consequence} ` +
        (known.length > 0
          ? `Headings searched:\n${known.join('\n')}` +
            (all.length > MAX_LISTED ? `\n…and ${all.length - MAX_LISTED} more.` : '')
          : 'No heading was found there; get_document with format="outline_with_indices" shows the paragraphs.')
    );
  }

  const { occurrence } = selector;
  if (occurrence !== undefined && occurrence > matches.length) {
    throw new Error(
      `occurrence ${occurrence} is past the end: ${asked} matches ${matches.length} time(s). ${consequence}`
    );
  }
  if (occurrence === undefined && matches.length > 1) {
    const listed = matches.slice(0, MAX_LISTED).map((h, i) => `${i + 1}. ${describe(h, tabs)}`);
    throw new Error(
      `${asked} matches ${matches.length} headings. ${consequence} Pass tab_id or occurrence to ` +
        `pick one, or the fuller heading:\n${listed.join('\n')}` +
        (matches.length > MAX_LISTED ? `\n…and ${matches.length - MAX_LISTED} more.` : '')
    );
  }
  return matches[(occurrence ?? 1) - 1];
}

/**
 * The next heading at the same or a higher level: where this heading's section
 * ends. Undefined when the section runs to the end of the tab.
 */
export function nextPeerHeading(doc: GoogleDoc, match: HeadingMatch): HeadingMatch | undefined {
  return tabHeadings(doc, match.tab).find(
    (h) => h.contentIndex > match.contentIndex && h.level <= match.level
  );
}

/** The top-level elements of a heading's section, the heading included. */
export function sectionElements(doc: GoogleDoc, match: HeadingMatch): StructuralElement[] {
  const content = match.tab.tab.documentTab?.body?.content ?? [];
  return content.slice(match.contentIndex, nextPeerHeading(doc, match)?.contentIndex);
}
