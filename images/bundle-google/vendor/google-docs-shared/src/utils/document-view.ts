import type { DocumentBody, GoogleDoc, StructuralElement, Tab } from '../types.js';

const TEXT_PREVIEW_CODE_POINTS = 80;

/** Fields that describe how a document looks and say nothing about what it holds. */
const STYLE_KEYS = new Set([
  'textStyle',
  'tableCellStyle',
  'tableRowStyle',
  'tableStyle',
  'documentStyle',
  'namedStyles',
  'lists',
]);

/**
 * A deep copy without styling. A paragraph keeps the two style fields an edit
 * needs: `namedStyleType` and `headingId`. `suggested…Changes` maps go too; the
 * suggestion ids on the runs, which mark what is pending, stay.
 */
export function withoutStyles<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutStyles) as T;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (STYLE_KEYS.has(key) || /^suggested\w*Changes$/.test(key)) continue;
    if (key === 'paragraphStyle') {
      const { namedStyleType, headingId } = field as Record<string, unknown>;
      out[key] = {
        ...(namedStyleType !== undefined ? { namedStyleType } : {}),
        ...(headingId !== undefined ? { headingId } : {}),
      };
      continue;
    }
    out[key] = withoutStyles(field);
  }
  return out as T;
}

interface TableShape {
  rows?: number;
  columns?: number;
  tableRows?: Array<{
    tableCells?: Array<{
      startIndex?: number;
      endIndex?: number;
      content?: StructuralElement[];
    }>;
  }>;
}

function withoutTables(elements: StructuralElement[]): StructuralElement[] {
  return elements.map((element) => {
    if (!element.table) return element;
    const { rows, columns } = element.table as TableShape;
    return {
      startIndex: element.startIndex,
      endIndex: element.endIndex,
      table: { rows, columns },
    };
  });
}

function bodyWithoutTables<T extends { body?: DocumentBody }>(holder: T): T {
  if (!holder.body?.content) return holder;
  return { ...holder, body: { ...holder.body, content: withoutTables(holder.body.content) } };
}

function tabsWithoutTables(tabs: Tab[]): Tab[] {
  return tabs.map((tab) => ({
    ...tab,
    ...(tab.documentTab ? { documentTab: bodyWithoutTables(tab.documentTab) } : {}),
    ...(tab.childTabs ? { childTabs: tabsWithoutTables(tab.childTabs) } : {}),
  }));
}

/** The document with each top-level table reduced to its place and its size. */
export function withoutDocumentTables(doc: GoogleDoc): GoogleDoc {
  const reduced = bodyWithoutTables(doc);
  return doc.tabs ? { ...reduced, tabs: tabsWithoutTables(doc.tabs) } : reduced;
}

/** The top-level elements overlapping `[start, end)`; a paragraph comes back whole. */
export function elementsInRange(
  elements: StructuralElement[],
  start: number | undefined,
  end: number | undefined
): StructuralElement[] {
  return elements.filter(
    (e) =>
      (start === undefined || (e.endIndex ?? 0) > start) &&
      (end === undefined || (e.startIndex ?? 0) < end)
  );
}

function preview(text: string): string {
  const flat = text.replace(/\n+$/, '').replace(/\s*[\n\u000b]\s*/g, ' ');
  const points = Array.from(flat);
  return points.length > TEXT_PREVIEW_CODE_POINTS
    ? `${points.slice(0, TEXT_PREVIEW_CODE_POINTS).join('')}…`
    : flat;
}

function paragraphLine(element: StructuralElement, label: string): string {
  const paragraph = element.paragraph!;
  const style = paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
  const headingId = paragraph.paragraphStyle?.headingId;
  let text = '';
  let hasObject = false;
  let pending = false;
  for (const pe of paragraph.elements ?? []) {
    if (pe.textRun?.content) text += pe.textRun.content;
    if (pe.inlineObjectElement) hasObject = true;
    if (pe.textRun?.suggestedInsertionIds?.length || pe.textRun?.suggestedDeletionIds?.length) {
      pending = true;
    }
  }
  const parts = [`${label}${element.startIndex}-${element.endIndex}`, style];
  if (typeof headingId === 'string') parts.push(`heading_id=${headingId}`);
  if (paragraph.bullet) parts.push('list-item');
  if (hasObject) parts.push('image');
  if (pending) parts.push('suggestion-pending');
  const shown = preview(text);
  parts.push(shown.length > 0 ? JSON.stringify(shown) : '(empty)');
  return parts.join(' ');
}

/**
 * One line per paragraph: `startIndex-endIndex STYLE "first 80 characters"`.
 * A table is one line and then its cells' paragraphs, labelled by row and
 * column, unless `withoutDocumentTables` already reduced it to the one line.
 */
export function renderIndexedLines(elements: StructuralElement[], label = ''): string {
  let out = '';
  for (const element of elements) {
    if (element.paragraph) {
      out += `${paragraphLine(element, label)}\n`;
    } else if (element.table) {
      const table = element.table as TableShape;
      const size = `${table.rows ?? '?'}x${table.columns ?? '?'}`;
      out += `${label}${element.startIndex}-${element.endIndex} TABLE ${size}\n`;
      (table.tableRows ?? []).forEach((row, r) => {
        (row.tableCells ?? []).forEach((cell, c) => {
          out += renderIndexedLines(cell.content ?? [], `  r${r + 1}c${c + 1} `);
        });
      });
    } else if (element.tableOfContents) {
      out += `${label}${element.startIndex}-${element.endIndex} TABLE_OF_CONTENTS\n`;
    } else if (element.sectionBreak) {
      out += `${label}${element.startIndex ?? 0}-${element.endIndex} SECTION_BREAK\n`;
    }
  }
  return out;
}

/** What a narrowed `format=json` read keeps of a tab: identity and the body it asked for. */
export function narrowedDocument(
  doc: GoogleDoc,
  body: StructuralElement[],
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    documentId: doc.documentId,
    title: doc.title,
    ...(doc.revisionId ? { revisionId: doc.revisionId } : {}),
    ...extra,
    body: { content: body },
  };
}
