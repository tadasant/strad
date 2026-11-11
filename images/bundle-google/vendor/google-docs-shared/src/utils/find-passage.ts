import type { GoogleDoc, StructuralElement } from '../types.js';
import { flattenTabs, type FlatTab } from './tabs.js';

/** One match of a passage in a tab's body, in Docs indexes (UTF-16 code units). */
export interface PassageMatch {
  tab: FlatTab;
  startIndex: number;
  endIndex: number;
  /** The match with a little surrounding text, to tell repeated matches apart. */
  context: string;
}

interface Run {
  text: string;
  startIndex: number;
  suggestedInsertion: boolean;
  suggestedDeletion: boolean;
}

const CONTEXT_CHARS = 30;

/**
 * Every text run of a body, in document order, table cells included. A table of
 * contents is left out: Docs generates its text from the headings, so searching
 * it would call every heading a repeat, and a refresh rewrites what it anchors.
 */
function collectRuns(elements: StructuralElement[], out: Run[] = []): Run[] {
  for (const element of elements) {
    if (element.paragraph) {
      for (const pe of element.paragraph.elements ?? []) {
        if (!pe.textRun?.content || typeof pe.startIndex !== 'number') continue;
        out.push({
          text: pe.textRun.content,
          startIndex: pe.startIndex,
          suggestedInsertion: (pe.textRun.suggestedInsertionIds?.length ?? 0) > 0,
          suggestedDeletion: (pe.textRun.suggestedDeletionIds?.length ?? 0) > 0,
        });
      }
    } else if (element.table) {
      const table = element.table as {
        tableRows?: Array<{ tableCells?: Array<{ content?: StructuralElement[] }> }>;
      };
      for (const row of table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) collectRuns(cell.content ?? [], out);
      }
    }
  }
  return out;
}

function matchesInRuns(tab: FlatTab, runs: Run[], passage: string): PassageMatch[] {
  let text = '';
  const docIndexes: number[] = [];
  for (const run of runs) {
    text += run.text;
    for (let i = 0; i < run.text.length; i++) docIndexes.push(run.startIndex + i);
  }
  const matches: PassageMatch[] = [];
  for (
    let at = text.indexOf(passage);
    at !== -1;
    at = text.indexOf(passage, at + 1)
  ) {
    const end = at + passage.length;
    matches.push({
      tab,
      startIndex: docIndexes[at],
      endIndex: docIndexes[end - 1] + 1,
      context: text.slice(Math.max(0, at - CONTEXT_CHARS), end + CONTEXT_CHARS),
    });
  }
  return matches;
}

/**
 * Finds a passage in the bodies of `tabs` (default: every tab), in document
 * order. `doc` must be read with `SUGGESTIONS_INLINE`, the only mode whose
 * indexes a `batchUpdate` can use.
 *
 * Inline text holds BOTH sides of a pending suggestion, so a passage a person
 * would read straight across a suggestion is in neither run on its own. All
 * three views count: the text as stored, as if every suggestion were accepted,
 * and as if every one were rejected. A range found in more than one is one
 * match, and a passage found twice across them is a repeat, not a first hit.
 * Indexes stay those of the inline document, which the runs were read with.
 */
export function findPassage(
  doc: GoogleDoc,
  passage: string,
  tabs: FlatTab[] = flattenTabs(doc)
): PassageMatch[] {
  const views: Array<(run: Run) => boolean> = [
    () => true,
    (run) => !run.suggestedDeletion,
    (run) => !run.suggestedInsertion,
  ];
  return tabs.flatMap((tab) => {
    const runs = collectRuns(tab.tab.documentTab?.body?.content ?? []);
    const byRange = new Map<string, PassageMatch>();
    for (const inView of views) {
      for (const match of matchesInRuns(tab, runs.filter(inView), passage)) {
        const range = `${match.startIndex}-${match.endIndex}`;
        if (!byRange.has(range)) byRange.set(range, match);
      }
    }
    return [...byRange.values()].sort((a, b) => a.startIndex - b.startIndex);
  });
}
