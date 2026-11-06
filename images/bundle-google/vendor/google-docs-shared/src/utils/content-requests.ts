import type { DocsBatchUpdateRequest, GoogleDoc, Paragraph, StructuralElement } from '../types.js';
import type { ContentParagraph, InlineStyle } from './markdown.js';
import { nextPeerHeading, type HeadingMatch } from './sections.js';
import type { FlatTab } from './tabs.js';

export type ContentPosition = 'before_heading' | 'after_heading' | 'end_of_section' | 'end_of_tab';

/**
 * Where content goes, and which side of a paragraph it enters from.
 *
 * `before`: at the start of `neighbour`, as "text\n". The new paragraphs end in
 * newlines of their own and `neighbour` keeps its own, so a heading keeps its
 * style and its id. This is the shape used wherever a paragraph follows.
 *
 * `after`: just inside `neighbour`'s closing newline, as "\ntext". Docs refuses
 * text at a table's start index, so this is the only shape that reaches the gap
 * above a table, and the only one past the last paragraph of a tab. The last
 * inserted paragraph ends on `neighbour`'s old newline.
 */
export interface InsertionPoint {
  index: number;
  side: 'before' | 'after';
  neighbour: Paragraph;
}

const TEXT_STYLE_FIELDS =
  'bold,italic,underline,strikethrough,smallCaps,backgroundColor,foregroundColor,' +
  'fontSize,weightedFontFamily,baselineOffset,link';

const PARAGRAPH_STYLE_FIELDS =
  'namedStyleType,alignment,indentStart,indentEnd,indentFirstLine,spaceAbove,spaceBelow,' +
  'lineSpacing,keepLinesTogether,keepWithNext,avoidWidowAndOrphan,pageBreakBefore,shading,' +
  'borderBetween,borderTop,borderBottom,borderLeft,borderRight';

const BULLET_PRESETS = {
  bullet: 'BULLET_DISC_CIRCLE_SQUARE',
  number: 'NUMBERED_DECIMAL_ALPHA_ROMAN',
} as const;

const CODE_FONT = 'Courier New';

function before(element: StructuralElement): InsertionPoint {
  return { index: element.startIndex as number, side: 'before', neighbour: element.paragraph! };
}

function after(element: StructuralElement): InsertionPoint {
  return { index: (element.endIndex as number) - 1, side: 'after', neighbour: element.paragraph! };
}

function isEmptyParagraph(element: StructuralElement): boolean {
  const elements = element.paragraph?.elements ?? [];
  return elements.length === 1 && elements[0].textRun?.content === '\n';
}

function endOfTab(tab: FlatTab): InsertionPoint {
  const content = tab.tab.documentTab?.body?.content ?? [];
  const last = content[content.length - 1];
  if (!last?.paragraph) {
    throw new Error(`Tab "${tab.path}" has no closing paragraph to insert at. Nothing was changed.`);
  }
  // An empty last paragraph is the blank line a document ends on. Writing above
  // it fills the document; writing after it would leave a gap.
  return isEmptyParagraph(last) ? before(last) : after(last);
}

export function insertionPoint(
  doc: GoogleDoc,
  position: ContentPosition,
  tab: FlatTab,
  heading?: HeadingMatch
): InsertionPoint {
  if (position === 'end_of_tab' || !heading) return endOfTab(tab);

  const content = tab.tab.documentTab?.body?.content ?? [];
  const element = content[heading.contentIndex];

  if (position === 'before_heading') return before(element);

  if (position === 'after_heading') {
    const next = content[heading.contentIndex + 1];
    return next?.paragraph ? before(next) : after(element);
  }

  const peer = nextPeerHeading(doc, heading);
  return peer ? before(content[peer.contentIndex]) : endOfTab(tab);
}

function textStyleOf(style: InlineStyle): { textStyle: Record<string, unknown>; fields: string } {
  const textStyle: Record<string, unknown> = {};
  const fields: string[] = [];
  if (style.bold) {
    textStyle.bold = true;
    fields.push('bold');
  }
  if (style.italic) {
    textStyle.italic = true;
    fields.push('italic');
  }
  if (style.code) {
    textStyle.weightedFontFamily = { fontFamily: CODE_FONT };
    fields.push('weightedFontFamily');
  }
  if (style.link) {
    textStyle.link = { url: style.link };
    fields.push('link');
  }
  return { textStyle, fields: fields.join(',') };
}

/**
 * The one batch that writes `paragraphs` at `point`. Every range is computed
 * here, from the text this function inserts; JavaScript strings are UTF-16, the
 * unit Docs indexes in, so `🖼️` counts as the three it occupies.
 *
 * The order is load-bearing. New text takes its neighbour's look, a heading's or
 * a list's, so bullets come off first, then paragraph and text styles are reset,
 * and only then is the content's own styling applied. `createParagraphBullets`
 * runs last and bottom-up. Docs says it removes leading tabs and may shift
 * indexes; the parser leaves none to remove, and bottom-up holds regardless,
 * because a shift can only reach text below the range being bulleted.
 */
export function contentRequests(
  paragraphs: ContentParagraph[],
  point: InsertionPoint,
  tabId?: string
): DocsBatchUpdateRequest[] {
  const inTab = tabId ? { tabId } : {};
  const text = paragraphs.map((p) => p.text).join('\n');
  const first = point.index + (point.side === 'after' ? 1 : 0);

  // Each paragraph's text span. Paragraph-level requests act on every paragraph
  // a range overlaps, so none of them needs to reach the closing newline, which
  // on the last paragraph of a tab would be the end of the segment.
  let cursor = first;
  const placed = paragraphs.map((paragraph) => {
    const start = cursor;
    const end = start + paragraph.text.length;
    cursor = end + 1;
    return { paragraph, start, end };
  });
  const last = placed[placed.length - 1];

  const requests: DocsBatchUpdateRequest[] = [
    {
      insertText: {
        location: { index: point.index, ...inTab },
        text: point.side === 'after' ? `\n${text}` : `${text}\n`,
      },
    },
  ];

  if (point.neighbour.bullet) {
    requests.push({
      deleteParagraphBullets: {
        range: { startIndex: first, endIndex: last.end, ...inTab },
      },
    });
  }

  for (const { paragraph, start, end } of placed) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: start, endIndex: end, ...inTab },
        paragraphStyle: { namedStyleType: paragraph.namedStyle },
        fields: PARAGRAPH_STYLE_FIELDS,
      },
    });
  }

  requests.push({
    updateTextStyle: {
      // In `before`, the closing newline is new text too, and a bullet glyph
      // takes its look from it. In `after` it is the neighbour's and may end the tab.
      range: {
        startIndex: first,
        endIndex: last.end + (point.side === 'before' ? 1 : 0),
        ...inTab,
      },
      textStyle: {},
      fields: TEXT_STYLE_FIELDS,
    },
  });

  for (const { paragraph, start } of placed) {
    for (const span of paragraph.spans) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: start + span.start, endIndex: start + span.end, ...inTab },
          ...textStyleOf(span.style),
        },
      });
    }
  }

  // Adjacent items of one kind go in one request. A list directly after an
  // existing one with the same preset joins it; that is Docs' rule, not this code's.
  const bullets: DocsBatchUpdateRequest[] = [];
  for (let i = 0; i < placed.length; ) {
    const kind = placed[i].paragraph.list;
    let j = i;
    while (j + 1 < placed.length && placed[j + 1].paragraph.list === kind) j += 1;
    if (kind) {
      bullets.unshift({
        createParagraphBullets: {
          range: { startIndex: placed[i].start, endIndex: placed[j].end, ...inTab },
          bulletPreset: BULLET_PRESETS[kind],
        },
      });
    }
    i = j + 1;
  }
  requests.push(...bullets);

  return requests;
}

/** The inserted text's length in document indexes, the newline it brings included. */
export function insertedLength(paragraphs: ContentParagraph[]): number {
  return paragraphs.reduce((sum, p) => sum + p.text.length + 1, 0);
}
