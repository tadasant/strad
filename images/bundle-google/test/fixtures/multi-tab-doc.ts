/**
 * The document issue #463 failed on, rebuilt: two tabs, about twenty headings a
 * tab, tables with the style block Docs puts on every cell, and the `🖼️`, `→`
 * and `—` that make hand-counted UTF-16 go wrong. Sizes are Docs' own shape, so
 * the byte counts a test reports against it mean something.
 */
import type { GoogleDoc, StructuralElement } from "google-docs-workspace-mcp-server-shared";

export const REPORT_DOC_ID = "1hReportDocFixture0123456789";

const ANCHORED_FONT = {
  fontSize: { magnitude: 11, unit: "PT" },
  weightedFontFamily: { fontFamily: "Arial", weight: 400 },
  foregroundColor: { color: { rgbColor: { red: 0.2, green: 0.2, blue: 0.2 } } },
};

const PARAGRAPH_STYLE = {
  namedStyleType: "NORMAL_TEXT",
  direction: "LEFT_TO_RIGHT",
  lineSpacing: 115,
  spaceAbove: { magnitude: 0, unit: "PT" },
  spaceBelow: { magnitude: 0, unit: "PT" },
  alignment: "START",
};

const border = () => ({
  width: { magnitude: 1, unit: "PT" },
  dashStyle: "SOLID",
  color: { color: { rgbColor: { red: 0.6, green: 0.6, blue: 0.6 } } },
});

const CELL_STYLE = () => ({
  rowSpan: 1,
  columnSpan: 1,
  backgroundColor: {},
  borderLeft: border(),
  borderRight: border(),
  borderTop: border(),
  borderBottom: border(),
  paddingLeft: { magnitude: 5, unit: "PT" },
  paddingRight: { magnitude: 5, unit: "PT" },
  paddingTop: { magnitude: 5, unit: "PT" },
  paddingBottom: { magnitude: 5, unit: "PT" },
  contentAlignment: "TOP",
});

/** Numbers Docs' way: a section break at 0, then UTF-16 units; a cell opens at +1, a table at +1. */
class Builder {
  index = 1;
  content: StructuralElement[] = [{ endIndex: 1, sectionBreak: { sectionStyle: {} } }];

  private paragraph(text: string, style: Record<string, unknown>) {
    const startIndex = this.index;
    const line = `${text}\n`;
    this.index += line.length;
    return {
      startIndex,
      endIndex: this.index,
      paragraph: {
        elements: [
          {
            startIndex,
            endIndex: this.index,
            textRun: { content: line, textStyle: { ...ANCHORED_FONT } },
          },
        ],
        paragraphStyle: { ...PARAGRAPH_STYLE, ...style },
      },
    };
  }

  add(text: string, style: Record<string, unknown> = {}) {
    this.content.push(this.paragraph(text, style));
    return this;
  }

  heading(level: number, text: string, headingId: string) {
    return this.add(text, { namedStyleType: `HEADING_${level}`, headingId });
  }

  bullet(text: string) {
    const element = this.paragraph(text, {});
    (element.paragraph as Record<string, unknown>).bullet = { listId: "kix.list1", textStyle: {} };
    this.content.push(element);
    return this;
  }

  table(rows: number, columns: number, cell: (r: number, c: number) => string) {
    const startIndex = this.index;
    this.index += 1;
    const tableRows = [];
    for (let r = 0; r < rows; r++) {
      const rowStart = this.index;
      this.index += 1;
      const tableCells = [];
      for (let c = 0; c < columns; c++) {
        const cellStart = this.index;
        this.index += 1;
        const paragraph = this.paragraph(cell(r, c), {});
        tableCells.push({
          startIndex: cellStart,
          endIndex: this.index,
          content: [paragraph],
          tableCellStyle: CELL_STYLE(),
        });
      }
      tableRows.push({
        startIndex: rowStart,
        endIndex: this.index,
        tableCells,
        tableRowStyle: { minRowHeight: { unit: "PT" } },
      });
    }
    this.index += 1;
    this.content.push({
      startIndex,
      endIndex: this.index,
      table: {
        rows,
        columns,
        tableRows,
        tableStyle: {
          tableColumnProperties: Array.from({ length: columns }, () => ({
            widthType: "EVENLY_DISTRIBUTED",
          })),
        },
      },
    });
    return this;
  }
}

function buildTab(prefix: string, sections: number) {
  const b = new Builder();
  b.add(`Agent platform — ${prefix}`, { namedStyleType: "TITLE" });
  b.add("🖼️ Screens → flows → decisions, in that order.");
  b.heading(1, "Overview", `h.${prefix}overview`);
  b.add("Why this exists — and what it replaced.");
  b.table(5, 4, (r, c) => `Stage ${r}.${c} → done 🖼️`);
  b.add("");
  b.heading(1, "Topics", `h.${prefix}topics`);
  for (let s = 1; s <= sections; s++) {
    b.heading(2, `Topic ${s}`, `h.${prefix}topic${s}`);
    b.add(`Topic ${s} opens with a paragraph that mentions 🖼️ and — and →.`);
    b.bullet(`First point about topic ${s}`);
    b.bullet(`Second point about topic ${s}`);
    b.heading(3, `Topic ${s} detail`, `h.${prefix}detail${s}`);
    b.add(`Detail for topic ${s}.`);
  }
  b.heading(2, "🖼️ Agent Run Lifecycle", `h.${prefix}lifecycle`);
  b.table(4, 4, (r, c) => `Phase ${r}.${c} — 🖼️`);
  b.add("");
  b.heading(2, "Open questions", `h.${prefix}open`);
  b.add("Who owns the rollback?");
  return {
    body: { content: b.content },
    documentStyle: { pageSize: { width: { magnitude: 612, unit: "PT" } } },
    namedStyles: {
      styles: Array.from({ length: 9 }, (_, i) => ({ namedStyleType: `STYLE_${i}`, ...ANCHORED_FONT })),
    },
    lists: { "kix.list1": { listProperties: { nestingLevels: [{ bulletAlignment: "START" }] } } },
  };
}

export function reportDoc(): GoogleDoc {
  return {
    documentId: REPORT_DOC_ID,
    title: "Agent platform",
    revisionId: "rev-42",
    tabs: [
      {
        tabProperties: { tabId: "t.condensed", title: "Condensed", index: 0 },
        documentTab: buildTab("c", 8),
      },
      {
        tabProperties: { tabId: "t.full", title: "Full", index: 1 },
        documentTab: buildTab("f", 8),
      },
    ],
  };
}
