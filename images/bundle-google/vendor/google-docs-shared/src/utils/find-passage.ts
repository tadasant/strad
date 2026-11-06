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

/** Every text run of a body, in document order, table cells and contents tables included. */
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
    } else if (element.tableOfContents) {
      const toc = element.tableOfContents as { content?: StructuralElement[] };
      collectRuns(toc.content ?? [], out);
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
    at = text.indexOf(passage, at + passage.length)
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
 * would read straight across a suggestion is in neither run on its own. Each
 * view is tried until one matches: the text as stored, then as if every
 * suggestion were accepted, then as if every one were rejected. Indexes stay
 * those of the inline document, which is what the runs were read with.
 */
export function findPassage(
  doc: GoogleDoc,
  passage: string,
  tabs: FlatTab[] = flattenTabs(doc)
): PassageMatch[] {
  const bodies = tabs.map((tab) => ({
    tab,
    runs: collectRuns(tab.tab.documentTab?.body?.content ?? []),
  }));
  const views: Array<(run: Run) => boolean> = [
    () => true,
    (run) => !run.suggestedDeletion,
    (run) => !run.suggestedInsertion,
  ];
  for (const inView of views) {
    const matches = bodies.flatMap(({ tab, runs }) =>
      matchesInRuns(tab, runs.filter(inView), passage)
    );
    if (matches.length > 0) return matches;
  }
  return [];
}
