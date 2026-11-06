/**
 * A small working model of a Docs tab, so a test can apply what a tool SENT and
 * read what the document then HOLDS. A faked 200 proves the request was shaped
 * as expected; this proves it lands in the right place, which is what a wrong
 * index gets wrong silently.
 *
 * It holds to Google's reference where that decides an outcome: text goes
 * inside a paragraph and never at a table's start index, a range must lie in
 * the segment, new text takes its neighbour's paragraph style, list membership
 * and text style, and the closing newline of a paragraph carries its style and
 * heading id, a bullet request removes leading tabs and shifts what follows, and
 * a mask must name real fields. Anything it does not model throws, so a new
 * request type cannot pass by being ignored.
 */
import type { GoogleDoc, StructuralElement, Tab } from "google-docs-workspace-mcp-server-shared";

type Json = Record<string, any>;

// `documents` reference, read 2026-11-06.
const TEXT_STYLE_FIELDS = new Set([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "smallCaps",
  "backgroundColor",
  "foregroundColor",
  "fontSize",
  "weightedFontFamily",
  "baselineOffset",
  "link",
]);
const PARAGRAPH_STYLE_FIELDS = new Set([
  "namedStyleType",
  "alignment",
  "lineSpacing",
  "direction",
  "spacingMode",
  "spaceAbove",
  "spaceBelow",
  "borderBetween",
  "borderTop",
  "borderBottom",
  "borderLeft",
  "borderRight",
  "indentFirstLine",
  "indentStart",
  "indentEnd",
  "keepLinesTogether",
  "keepWithNext",
  "avoidWidowAndOrphan",
  "shading",
  "pageBreakBefore",
]);
const BULLET_PRESETS = new Set(["BULLET_DISC_CIRCLE_SQUARE", "NUMBERED_DECIMAL_ALPHA_ROMAN"]);

function allTabs(tabs: Tab[]): Tab[] {
  return tabs.flatMap((t) => [t, ...allTabs(t.childTabs ?? [])]);
}

/** Every paragraph in a body, table cells included, in index order. */
function paragraphsOf(content: StructuralElement[]): Json[] {
  return content.flatMap((e): Json[] => {
    if (e.paragraph) return [e];
    const table = e.table as Json | undefined;
    if (!table) return [];
    return (table.tableRows ?? []).flatMap((r: Json) =>
      r.tableCells.flatMap((c: Json) => paragraphsOf(c.content)),
    );
  });
}

function shiftFrom(content: StructuralElement[], index: number, by: number): void {
  const bump = (node: Json) => {
    if (typeof node.startIndex === "number" && node.startIndex >= index) node.startIndex += by;
    if (typeof node.endIndex === "number" && node.endIndex > index) node.endIndex += by;
  };
  for (const element of content as Json[]) {
    bump(element);
    for (const pe of element.paragraph?.elements ?? []) bump(pe);
    for (const row of element.table?.tableRows ?? []) {
      bump(row);
      for (const cell of row.tableCells) {
        bump(cell);
        shiftFrom(cell.content, index, by);
      }
    }
  }
}

function textOf(paragraph: Json): string {
  return paragraph.paragraph.elements.map((e: Json) => e.textRun?.content ?? "").join("");
}

function insertText(content: StructuralElement[], index: number, text: string, segmentEnd: number) {
  if (index >= segmentEnd) throw new Error(`400: index ${index} is past the segment end`);
  const paragraph = paragraphsOf(content).find(
    (p) => p.startIndex <= index && index < p.endIndex,
  );
  if (!paragraph) {
    throw new Error(`400: The insertion index ${index} must be inside the bounds of a paragraph`);
  }

  const position = (content as Json[]).indexOf(paragraph);
  if (position === -1) throw new Error("the simulator does not insert newlines inside table cells");

  // Runs carry their own style and suggestion ids. New text takes the style of
  // the run it lands in, without the ids, which belong to the text they marked.
  type Piece = { text: string; run: Json };
  const pieces: Piece[] = [];
  let placed = false;
  for (const element of paragraph.paragraph.elements as Json[]) {
    const run = element.textRun ?? {};
    const held: string = run.content ?? "";
    const at = index - element.startIndex;
    if (!placed && at >= 0 && at < held.length) {
      placed = true;
      if (at > 0) pieces.push({ text: held.slice(0, at), run });
      const { suggestedInsertionIds: _i, suggestedDeletionIds: _d, ...style } = run;
      pieces.push({ text, run: style });
      pieces.push({ text: held.slice(at), run });
    } else {
      pieces.push({ text: held, run });
    }
  }

  const start = paragraph.startIndex;
  shiftFrom(content, index + 1, text.length);
  const style = paragraph.paragraph.paragraphStyle ?? {};
  const bullet = paragraph.paragraph.bullet;

  let cursor = start;
  const groups: Json[][] = [[]];
  for (const { text: piece, run } of pieces) {
    for (const part of piece.split(/(?<=\n)/)) {
      if (part.length === 0) continue;
      const { content: _c, ...rest } = run;
      groups[groups.length - 1].push({
        startIndex: cursor,
        endIndex: cursor + part.length,
        textRun: { ...structuredClone(rest), content: part },
      });
      cursor += part.length;
      if (part.endsWith("\n")) groups.push([]);
    }
  }
  groups.pop();

  const { headingId: _id, ...copied } = style;
  const replacement = groups.map((elements, i) => ({
    startIndex: elements[0].startIndex,
    endIndex: elements[elements.length - 1].endIndex,
    paragraph: {
      // The new newlines copy the style. The old one ends the last paragraph
      // and keeps the id it carries.
      paragraphStyle: i === groups.length - 1 ? { ...style } : { ...copied },
      ...(bullet ? { bullet: { ...bullet } } : {}),
      elements,
    },
  }));
  (content as Json[]).splice(position, 1, ...replacement);
}

function overlapping(content: StructuralElement[], range: Json): Json[] {
  if (!(range.startIndex < range.endIndex)) throw new Error("400: empty range");
  return (content as Json[]).filter(
    (p) => p.paragraph && p.startIndex < range.endIndex && p.endIndex > range.startIndex,
  );
}

/** Splits runs so a style lands on exactly `range`, and returns the runs inside it. */
function runsIn(content: StructuralElement[], range: Json): Json[] {
  const hit: Json[] = [];
  for (const element of overlapping(content, range)) {
    const out: Json[] = [];
    for (const run of element.paragraph.elements) {
      const cuts = [run.startIndex, range.startIndex, range.endIndex, run.endIndex]
        .filter((c) => c >= run.startIndex && c <= run.endIndex)
        .sort((a, b) => a - b);
      for (let i = 0; i + 1 < cuts.length; i++) {
        if (cuts[i] === cuts[i + 1]) continue;
        const piece = {
          startIndex: cuts[i],
          endIndex: cuts[i + 1],
          textRun: {
            ...run.textRun,
            textStyle: { ...run.textRun.textStyle },
            content: run.textRun.content.slice(cuts[i] - run.startIndex, cuts[i + 1] - run.startIndex),
          },
        };
        out.push(piece);
        if (piece.startIndex >= range.startIndex && piece.endIndex <= range.endIndex) hit.push(piece);
      }
    }
    element.paragraph.elements = out;
  }
  return hit;
}

function applyMask(target: Json, source: Json, fields: string, known: Set<string>): void {
  if (!fields) throw new Error("400: at least one field must be specified");
  for (const field of fields.split(",")) {
    if (!known.has(field)) throw new Error(`400: unknown field ${field}`);
    if (source[field] === undefined) delete target[field];
    else target[field] = source[field];
  }
}

export interface ApplyOptions {
  suggest?: boolean;
}

/** Applies a batch to `doc` in place, the way `documents.batchUpdate` would. */
export function applyBatch(doc: GoogleDoc, requests: Json[], options: ApplyOptions = {}): void {
  const tabs = allTabs(doc.tabs ?? []);
  const contentOf = (tabId?: string) => {
    const tab = tabId ? tabs.find((t) => t.tabProperties?.tabId === tabId) : tabs[0];
    if (!tab) throw new Error(`400: no tab ${tabId}`);
    return tab.documentTab!.body!.content!;
  };
  const segmentEnd = (content: StructuralElement[]) =>
    content[content.length - 1].endIndex as number;

  for (const request of requests) {
    const [name, body] = Object.entries(request)[0] as [string, Json];
    const where = body.location ?? body.range;
    const content = contentOf(where?.tabId);
    if (body.range && body.range.endIndex > segmentEnd(content)) {
      throw new Error(`400: ${name} range ends past the segment`);
    }
    switch (name) {
      case "insertText":
        insertText(content, body.location.index, body.text, segmentEnd(content));
        if (options.suggest) {
          const end = body.location.index + body.text.length;
          for (const run of runsIn(content, { startIndex: body.location.index, endIndex: end })) {
            run.textRun.suggestedInsertionIds = ["suggest.sim"];
          }
        }
        break;
      case "updateParagraphStyle":
        for (const p of overlapping(content, body.range)) {
          applyMask(
            (p.paragraph.paragraphStyle ??= {}),
            body.paragraphStyle,
            body.fields,
            PARAGRAPH_STYLE_FIELDS,
          );
        }
        break;
      case "updateTextStyle":
        for (const run of runsIn(content, body.range)) {
          applyMask((run.textRun.textStyle ??= {}), body.textStyle, body.fields, TEXT_STYLE_FIELDS);
        }
        break;
      case "deleteParagraphBullets":
        for (const p of overlapping(content, body.range)) delete p.paragraph.bullet;
        break;
      case "createParagraphBullets":
        if (!BULLET_PRESETS.has(body.bulletPreset)) throw new Error(`400: ${body.bulletPreset}`);
        for (const p of overlapping(content, body.range)) {
          p.paragraph.bullet = { listId: `sim.${body.bulletPreset}.${body.range.startIndex}` };
          const first = p.paragraph.elements[0];
          const tabs = first.textRun.content.match(/^\t+/)?.[0].length ?? 0;
          if (tabs > 0) {
            first.textRun.content = first.textRun.content.slice(tabs);
            shiftFrom(content, first.startIndex + tabs, -tabs);
          }
        }
        break;
      default:
        throw new Error(`the simulator does not model ${name}`);
    }
  }
}

/** Holds to what Docs guarantees: contiguous indexes and no stray state. */
export function assertWellFormed(doc: GoogleDoc): void {
  for (const tab of allTabs(doc.tabs ?? [])) {
    let cursor = 0;
    for (const element of tab.documentTab!.body!.content! as Json[]) {
      if ((element.startIndex ?? 0) !== cursor) {
        throw new Error(`index gap at ${cursor} in ${tab.tabProperties?.title}`);
      }
      cursor = element.endIndex;
      if (element.paragraph) {
        if (!textOf(element).endsWith("\n")) throw new Error(`no newline at ${element.startIndex}`);
        if (element.endIndex - element.startIndex !== textOf(element).length) {
          throw new Error(`length mismatch at ${element.startIndex}`);
        }
      }
    }
  }
}

/** A tab's paragraphs as `STYLE|list?|text`, top level only: what a reader of the tab sees. */
export function readTab(doc: GoogleDoc, tabId: string): string[] {
  const tab = allTabs(doc.tabs ?? []).find((t) => t.tabProperties?.tabId === tabId)!;
  return (tab.documentTab!.body!.content! as Json[]).flatMap((e) => {
    if (e.table) return [`TABLE`];
    if (!e.paragraph) return [];
    const style = e.paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT";
    return [`${style}${e.paragraph.bullet ? " (list)" : ""}|${textOf(e).replace(/\n$/, "")}`];
  });
}

/** The styled runs of a tab, as `text → style keys`, for what markdown asked for. */
export function styledRuns(doc: GoogleDoc, tabId: string): Array<[string, Json]> {
  const tab = allTabs(doc.tabs ?? []).find((t) => t.tabProperties?.tabId === tabId)!;
  return (tab.documentTab!.body!.content! as Json[]).flatMap((e) =>
    (e.paragraph?.elements ?? [])
      .filter((r: Json) => Object.keys(r.textRun?.textStyle ?? {}).length > 0)
      .map((r: Json) => [r.textRun.content, r.textRun.textStyle] as [string, Json]),
  );
}
