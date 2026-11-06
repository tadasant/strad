/**
 * google-docs edits by heading, in any tab, and reads a section instead of a
 * document, a strad delta on the vendored tree
 * (`vendor/google-docs-shared/README.md`, `HACKS.md` #136).
 *
 * The client here is backed by `fixtures/docs-simulator.ts`, which applies what
 * a tool sent. So a passing test says what the document holds afterwards, not
 * only what was asked for, and an index that is off lands in the wrong
 * paragraph and fails. `fixtures/multi-tab-doc.ts` is the document issue #463
 * gave up on.
 */
import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  DocsBatchUpdateResponse,
  DocsWriteControl,
  GoogleDoc,
  IGoogleDocsClient,
} from "google-docs-workspace-mcp-server-shared";

import { createMCPServer } from "../src/docs.js";
import { applyBatch, assertWellFormed, readTab, styledRuns } from "./fixtures/docs-simulator.js";
import { REPORT_DOC_ID as DOC_ID, reportDoc } from "./fixtures/multi-tab-doc.js";

type Batch = {
  requests: Array<Record<string, any>>;
  writeControl?: DocsWriteControl;
};

function simulatedClient(doc: GoogleDoc) {
  const batches: Batch[] = [];
  const reads: unknown[] = [];
  const client = {
    getDocument: async (_id: string, options?: unknown) => {
      reads.push(options);
      return structuredClone(doc);
    },
    batchUpdate: async (
      _id: string,
      requests: Array<Record<string, any>>,
      writeControl?: DocsWriteControl,
    ): Promise<DocsBatchUpdateResponse> => {
      batches.push({ requests, writeControl });
      const suggest = writeControl?.writeMode === "SUGGEST";
      applyBatch(doc, requests, { suggest });
      return {
        documentId: DOC_ID,
        commentUpdateState: suggest ? "ALL_SAVED" : "NO_UPDATES_REQUESTED",
        ...(suggest
          ? { suggestionResponses: requests.map(() => ({ createdSuggestionIds: ["suggest.1"] })) }
          : {}),
      };
    },
  };
  return { client: client as unknown as IGoogleDocsClient, batches, reads };
}

async function connect(doc: GoogleDoc) {
  const { client, batches, reads } = simulatedClient(doc);
  const { server, registerHandlers } = createMCPServer({ version: "test" });
  await registerHandlers(server as unknown as Server, () => client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: "t", version: "0" });
  await mcp.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await mcp.callTool({ name, arguments: { document_id: DOC_ID, ...args } })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { text: result.content[0].text, isError: result.isError === true };
  };
  return { call, batches, reads, mcp };
}

const SECTION = [
  "### Handoffs 🖼️",
  "",
  "*Draft.* The **first** paragraph → names the owner — briefly.",
  "",
  "The second paragraph.",
].join("\n");

const WRITTEN = [
  "HEADING_3|Handoffs 🖼️",
  "NORMAL_TEXT|Draft. The first paragraph → names the owner — briefly.",
  "NORMAL_TEXT|The second paragraph.",
];

function around(lines: string[], text: string) {
  const at = lines.findIndex((l) => l.endsWith(`|${text}`));
  expect(at, `no paragraph ${text}`).toBeGreaterThanOrEqual(0);
  return at;
}

test("the issue's edit: an H3 section lands above a heading in the second tab, with nothing counted by hand", async () => {
  const doc = reportDoc();
  const before = readTab(doc, "t.condensed");
  const { call, batches } = await connect(doc);

  const { text, isError } = await call("insert_content", {
    tab_id: "t.full",
    heading: "Open questions",
    position: "before_heading",
    content: SECTION,
  });

  expect(isError).toBe(false);
  expect(text).toContain("**Tab:** Full (tab_id: `t.full`)");
  expect(batches).toHaveLength(1);

  const lines = readTab(doc, "t.full");
  const at = around(lines, "Open questions");
  expect(lines.slice(at - 3, at)).toEqual(WRITTEN);
  expect(lines[at]).toBe("HEADING_2|Open questions");
  expect(readTab(doc, "t.condensed")).toEqual(before);
  assertWellFormed(doc);

  const runs = styledRuns(doc, "t.full");
  expect(runs.find(([t]) => t === "Draft.")?.[1]).toEqual({ italic: true });
  expect(runs.find(([t]) => t === "first")?.[1]).toEqual({ bold: true });
});

test("the anchor heading survives: its style and id stay on it", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  await call("insert_content", {
    tab_id: "t.full",
    heading_id: "h.fopen",
    position: "before_heading",
    content: "New text.",
  });
  const outline = await call("get_document_outline", { tab_id: "t.full" });
  expect(outline.text).toMatch(/- H2: Open questions \(index \d+, heading_id: h\.fopen\)/);
});

test("new text does not keep its neighbour's look", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  await call("insert_content", {
    tab_id: "t.condensed",
    heading: "Open questions",
    position: "before_heading",
    content: "Plain.",
  });
  expect(styledRuns(doc, "t.condensed").filter(([t]) => t.startsWith("Plain."))).toEqual([]);
  const lines = readTab(doc, "t.condensed");
  expect(lines[around(lines, "Plain.")]).toBe("NORMAL_TEXT|Plain.");
});

test("after_heading goes directly under the heading", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  await call("insert_content", {
    tab_id: "t.condensed",
    heading: "Topic 3",
    position: "after_heading",
    content: "Under it.",
  });
  const lines = readTab(doc, "t.condensed");
  const at = around(lines, "Topic 3");
  expect(lines[at + 1]).toBe("NORMAL_TEXT|Under it.");
  expect(lines[at + 2]).toContain("Topic 3 opens with");
  assertWellFormed(doc);
});

test("after_heading on a heading followed by a table does not write at the table's start index", async () => {
  const doc = reportDoc();
  const { call, batches } = await connect(doc);
  const { isError, text } = await call("insert_content", {
    tab_id: "t.condensed",
    heading: "Agent Run Lifecycle",
    position: "after_heading",
    content: "## Note\n\nAbove the table.",
  });

  expect(isError, text).toBe(false);
  const first = batches[0].requests[0].insertText;
  expect(first.text.startsWith("\n")).toBe(true);

  const lines = readTab(doc, "t.condensed");
  const at = around(lines, "🖼️ Agent Run Lifecycle");
  expect(lines[at]).toBe("HEADING_2|🖼️ Agent Run Lifecycle");
  expect(lines.slice(at + 1, at + 4)).toEqual([
    "HEADING_2|Note",
    "NORMAL_TEXT|Above the table.",
    "TABLE",
  ]);
  assertWellFormed(doc);
});

test("end_of_section stops at the next peer, and an H2's section holds its H3s", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  await call("insert_content", {
    tab_id: "t.full",
    heading: "Topic 2",
    position: "end_of_section",
    content: "Closing line.",
  });
  const lines = readTab(doc, "t.full");
  const at = around(lines, "Closing line.");
  expect(lines[at - 1]).toBe("NORMAL_TEXT|Detail for topic 2.");
  expect(lines[at + 1]).toBe("HEADING_2|Topic 3");
});

test("end_of_section on the last section ends the tab, and the original last line stays", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  const { isError, text } = await call("insert_content", {
    tab_id: "t.full",
    heading: "Open questions",
    position: "end_of_section",
    content: "One more.\n\n- a bullet",
  });
  expect(isError, text).toBe(false);
  const lines = readTab(doc, "t.full");
  expect(lines.slice(-3)).toEqual([
    "NORMAL_TEXT|Who owns the rollback?",
    "NORMAL_TEXT|One more.",
    "NORMAL_TEXT (list)|a bullet",
  ]);
  assertWellFormed(doc);
});

test("under a heading whose next paragraph is a list item, new text is not swept into the list", async () => {
  const doc = reportDoc();
  const content = doc.tabs![0].documentTab!.body!.content!;
  const firstItem = content.findIndex((e) => e.paragraph?.bullet);
  content[firstItem - 1].paragraph!.paragraphStyle = {
    namedStyleType: "HEADING_4",
    headingId: "h.overlist",
  };
  const { call, batches } = await connect(doc);
  await call("insert_content", {
    tab_id: "t.condensed",
    heading_id: "h.overlist",
    position: "after_heading",
    content: "Not a bullet.",
  });
  expect(batches[0].requests.some((r) => r.deleteParagraphBullets)).toBe(true);
  const lines = readTab(doc, "t.condensed");
  const at = around(lines, "Not a bullet.");
  expect(lines[at]).toBe("NORMAL_TEXT|Not a bullet.");
  expect(lines[at + 1]).toContain("(list)|First point");
});

test("non-BMP text cannot throw a range off, in the content or ahead of the anchor", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  await call("insert_content", {
    tab_id: "t.full",
    heading: "🖼 Agent Run Lifecycle",
    position: "before_heading",
    content: "### 👩‍💻 Team 𝒳\n\n🖼️🖼️ **bold after emoji** then *italic 😀 inside* — [link 🔗](https://example.com/a).",
  });
  const runs = styledRuns(doc, "t.full");
  expect(runs.find(([t]) => t === "bold after emoji")?.[1]).toEqual({ bold: true });
  expect(runs.find(([t]) => t === "italic 😀 inside")?.[1]).toEqual({ italic: true });
  expect(runs.find(([t]) => t === "link 🔗")?.[1]).toEqual({
    link: { url: "https://example.com/a" },
  });
  assertWellFormed(doc);
});

test("a section in the first tab is addressed the same way, with its tab named on every location", async () => {
  const doc = reportDoc();
  const { call, batches } = await connect(doc);
  await call("insert_content", {
    tab_id: "t.condensed",
    heading: "Overview",
    position: "after_heading",
    content: "- one\n- two\n\n1. first\n2. second\n\nProse.",
  });
  for (const request of batches[0].requests) {
    const body = Object.values(request)[0] as Record<string, any>;
    expect((body.location ?? body.range).tabId).toBe("t.condensed");
  }
  const bullets = batches[0].requests.filter((r) => r.createParagraphBullets);
  expect(bullets.map((r) => r.createParagraphBullets.bulletPreset)).toEqual([
    "NUMBERED_DECIMAL_ALPHA_ROMAN",
    "BULLET_DISC_CIRCLE_SQUARE",
  ]);
  const lines = readTab(doc, "t.condensed");
  const at = around(lines, "Overview");
  expect(lines.slice(at + 1, at + 6)).toEqual([
    "NORMAL_TEXT (list)|one",
    "NORMAL_TEXT (list)|two",
    "NORMAL_TEXT (list)|first",
    "NORMAL_TEXT (list)|second",
    "NORMAL_TEXT|Prose.",
  ]);
});

test("end_of_tab writes above a closing blank line, and needs a tab in a document with several", async () => {
  const doc = reportDoc();
  doc.tabs!.pop();
  const content = doc.tabs![0].documentTab!.body!.content!;
  const last = content[content.length - 1];
  const end = last.endIndex as number;
  content.push({
    startIndex: end,
    endIndex: end + 1,
    paragraph: {
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      elements: [{ startIndex: end, endIndex: end + 1, textRun: { content: "\n" } }],
    },
  });
  const { call } = await connect(doc);
  await call("insert_content", { position: "end_of_tab", content: "Last words." });
  expect(readTab(doc, "t.condensed").slice(-2)).toEqual([
    "NORMAL_TEXT|Last words.",
    "NORMAL_TEXT|",
  ]);

  const two = reportDoc();
  const { call: callTwo, batches } = await connect(two);
  const refused = await callTwo("insert_content", { position: "end_of_tab", content: "x" });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("needs a tab_id");
  expect(refused.text).toContain("t.full");
  expect(batches).toHaveLength(0);
});

test.each([
  [{ heading: "Open questions" }, "matches 2 headings"],
  [{ heading: "Nothing like this" }, "matches no heading"],
  [{ heading: "Open questions", occurrence: 3 }, "past the end"],
  [{ tab_id: "t.nope", heading: "Overview" }, 'Tab "t.nope" not found'],
  [{}, "needs a heading"],
  [{ heading: "Overview", heading_id: "h.x" }, "not both"],
])("refused and nothing is written: %j", async (args, message) => {
  const doc = reportDoc();
  const before = JSON.stringify(doc);
  const { call, batches } = await connect(doc);
  const { text, isError } = await call("insert_content", {
    position: "before_heading",
    content: "x",
    ...args,
  });
  expect(isError).toBe(true);
  expect(text).toContain(message);
  expect(batches).toHaveLength(0);
  expect(JSON.stringify(doc)).toBe(before);
});

test("a repeat lists each match with its tab, and occurrence picks one", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  const refused = await call("insert_content", {
    heading: "Open questions",
    position: "before_heading",
    content: "x",
  });
  expect(refused.text).toContain('tab "Condensed" (tab_id: t.condensed)');
  expect(refused.text).toContain('tab "Full" (tab_id: t.full)');
  expect(refused.text).toContain("Nothing was changed.");

  await call("insert_content", {
    heading: "Open questions",
    occurrence: 2,
    position: "before_heading",
    content: "Second one.",
  });
  expect(readTab(doc, "t.full").some((l) => l.endsWith("|Second one."))).toBe(true);
  expect(readTab(doc, "t.condensed").some((l) => l.endsWith("|Second one."))).toBe(false);
});

test("a prefix stops at a word, so Phase 1 is never Phase 10", async () => {
  const doc = reportDoc();
  const content = doc.tabs![1].documentTab!.body!.content!;
  const heading = content.find((e) => e.paragraph?.paragraphStyle?.headingId === "h.fopen")!;
  const run = heading.paragraph!.elements![0].textRun!;
  run.content = `Phase 10${run.content.slice("Phase 10".length)}`;
  const { call, batches } = await connect(doc);
  const refused = await call("insert_content", {
    tab_id: "t.full",
    heading: "Phase 1",
    position: "after_heading",
    content: "x",
  });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("matches no heading");
  expect(batches).toHaveLength(0);
});

test("a heading with an emoji in front is found by its words, and a bare symbol is not a prefix", async () => {
  const { call } = await connect(reportDoc());
  const found = await call("get_document", {
    tab_id: "t.full",
    heading: "agent run lifecycle",
    format: "outline_with_indices",
    skip_tables: true,
  });
  expect(found.text).toContain('**Section:** HEADING_2 "🖼️ Agent Run Lifecycle"');
  const symbol = await call("get_document", { tab_id: "t.full", heading: "—" });
  expect(symbol.isError).toBe(true);
  expect(symbol.text).toContain("matches no heading");
});

test("an exact heading beats a prefix, and a prefix alone is enough", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  // "Topic 1" also prefixes "Topic 1 detail".
  const exact = await call("insert_content", {
    tab_id: "t.full",
    heading: "topic 1",
    position: "after_heading",
    content: "x",
  });
  expect(exact.text).toContain('HEADING_2 "Topic 1"');
  const prefix = await call("insert_content", {
    tab_id: "t.full",
    heading: "open",
    position: "after_heading",
    content: "y",
  });
  expect(prefix.text).toContain('HEADING_2 "Open questions"');
});

test.each([
  ["> quoted", "a block quote"],
  ["| a | b |\n|---|---|\n| 1 | 2 |", "a table"],
  ["```\ncode\n```", "a code fence"],
  ["above\n\n---\n\nbelow", "a horizontal rule"],
  ["![alt](https://x.test/i.png)", "an image"],
  ["- top\n  - nested", "a nested list item"],
  ["- top\n\t- nested", "a nested list item"],
  ["- > quoted", "a block quote"],
  ["|---|", "a table"],
  ["see ![alt](https://x.test/i.png) here", "holds an image"],
  ["- ![a](https://x.test/i.png)", "holds an image"],
])("markdown the dialect cannot express is refused by line: %j", async (content, what) => {
  const doc = reportDoc();
  const { call, batches, reads } = await connect(doc);
  const { text, isError } = await call("insert_content", {
    tab_id: "t.full",
    heading: "Overview",
    position: "after_heading",
    content,
  });
  expect(isError).toBe(true);
  expect(text).toContain(what);
  expect(batches).toHaveLength(0);
  expect(reads).toHaveLength(0);
});

test("literal punctuation stays literal, and a backslash forces it", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  await call("insert_content", {
    tab_id: "t.full",
    heading: "Overview",
    position: "after_heading",
    content: [
      "2 * 3 * 4 and a ** b and snake_case_name stay put.",
      "\\> not a quote, \\*not italic\\*, \\# not a heading",
      "An [unsafe](javascript:alert) link stays text, and so does an *unclosed mark.",
      "# ",
    ].join("\n"),
  });
  const lines = readTab(doc, "t.full");
  expect(lines).toContain("NORMAL_TEXT|2 * 3 * 4 and a ** b and snake_case_name stay put.");
  expect(lines).toContain("NORMAL_TEXT|> not a quote, *not italic*, # not a heading");
  expect(lines).toContain(
    "NORMAL_TEXT|An [unsafe](javascript:alert) link stays text, and so does an *unclosed mark.",
  );
  expect(styledRuns(doc, "t.full").find(([t]) => t === "unsafe")).toBeUndefined();
});

test.each([
  ["**bold with *italic***", [["bold with ", { bold: true }], ["italic", { bold: true, italic: true }]]],
  ["*a **b***", [["a ", { italic: true }], ["b", { bold: true, italic: true }]]],
  ["***both***", [["both", { bold: true, italic: true }]]],
  ["*a `*` b*", [["a ", { italic: true }], [" b", { italic: true }]]],
  ["*\\* foo*", [["* foo", { italic: true }]]],
  ["_under_ and __strong__", [["under", { italic: true }], ["strong", { bold: true }]]],
])("emphasis nests and leaves no stray marks: %s", async (content, expected) => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  await call("insert_content", {
    tab_id: "t.full",
    heading: "Overview",
    position: "after_heading",
    content,
  });
  const runs = styledRuns(doc, "t.full");
  for (const [text, style] of expected as Array<[string, Record<string, boolean>]>) {
    const run = runs.find(([t]) => t === text);
    expect(run?.[0], `no run ${text}`).toBe(text);
    for (const [key, value] of Object.entries(style)) expect(run?.[1][key]).toBe(value);
  }
});

test("code and links shield what is inside them", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  await call("insert_content", {
    tab_id: "t.full",
    heading: "Overview",
    position: "after_heading",
    content:
      "**`**kwargs`** and [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) and *[a*b](https://x.test)*",
  });
  expect(readTab(doc, "t.full")).toContain("NORMAL_TEXT|**kwargs and Foo and a*b");
  const runs = styledRuns(doc, "t.full");
  expect(runs.find(([t]) => t === "**kwargs")?.[1].bold).toBe(true);
  expect(runs.find(([t]) => t === "Foo")?.[1].link).toEqual({
    url: "https://en.wikipedia.org/wiki/Foo_(bar)",
  });
});

test("a number is a list item only where a list could be, so a year stays in its sentence", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  await call("insert_content", {
    tab_id: "t.full",
    heading: "Overview",
    position: "after_heading",
    content: "2020. A good year\n\n1. one\n2. two\n\nProse.\n\n3. three is a sentence here",
  });
  const lines = readTab(doc, "t.full");
  const at = around(lines, "Overview");
  expect(lines.slice(at + 1, at + 6)).toEqual([
    "NORMAL_TEXT|2020. A good year",
    "NORMAL_TEXT (list)|one",
    "NORMAL_TEXT (list)|two",
    "NORMAL_TEXT|Prose.",
    "NORMAL_TEXT|3. three is a sentence here",
  ]);
});

test("a tab inside a list item cannot shift the next list's range", async () => {
  const doc = reportDoc();
  const { call, batches } = await connect(doc);
  await call("insert_content", {
    tab_id: "t.full",
    heading: "Overview",
    position: "after_heading",
    content: "- `\tcode`\n\nmid\n\n- b",
  });
  expect(batches[0].requests[0].insertText.text).toBe("code\nmid\nb\n");
  const lines = readTab(doc, "t.full");
  const at = around(lines, "Overview");
  expect(lines.slice(at + 1, at + 4)).toEqual([
    "NORMAL_TEXT (list)|code",
    "NORMAL_TEXT|mid",
    "NORMAL_TEXT (list)|b",
  ]);
  assertWellFormed(doc);
});

test("bullet requests run bottom-up, so a shift cannot reach a range still to come", async () => {
  const { call, batches } = await connect(reportDoc());
  await call("insert_content", {
    tab_id: "t.full",
    heading: "Overview",
    position: "after_heading",
    content: "- a\n\nmid\n\n- b",
  });
  const starts = batches[0].requests
    .filter((r) => r.createParagraphBullets)
    .map((r) => r.createParagraphBullets.range.startIndex);
  expect(starts).toHaveLength(2);
  expect(starts[0]).toBeGreaterThan(starts[1]);
});

test("a heading's page break does not spread to the paragraphs written above it", async () => {
  const doc = reportDoc();
  const heading = doc.tabs![1].documentTab!.body!.content!.find(
    (e) => e.paragraph?.paragraphStyle?.headingId === "h.fopen",
  )!;
  Object.assign(heading.paragraph!.paragraphStyle!, {
    pageBreakBefore: true,
    keepWithNext: true,
    shading: { backgroundColor: {} },
  });
  const { call } = await connect(doc);
  await call("insert_content", {
    tab_id: "t.full",
    heading_id: "h.fopen",
    position: "before_heading",
    content: "One.\n\nTwo.",
  });
  const content = doc.tabs![1].documentTab!.body!.content! as Array<Record<string, any>>;
  const at = content.findIndex((e) => e.paragraph?.paragraphStyle?.headingId === "h.fopen");
  for (const e of content.slice(at - 2, at)) {
    expect(e.paragraph.paragraphStyle.pageBreakBefore).toBeUndefined();
    expect(e.paragraph.paragraphStyle.keepWithNext).toBeUndefined();
    expect(e.paragraph.paragraphStyle.shading).toBeUndefined();
  }
  expect(content[at].paragraph.paragraphStyle.pageBreakBefore).toBe(true);
});

test("a parameter that would do nothing is refused, and a range past the tab is not a success", async () => {
  const { call } = await connect(reportDoc());
  const noHeading = await call("get_document", { tab_id: "t.full", occurrence: 2 });
  expect(noHeading.isError).toBe(true);
  expect(noHeading.text).toContain("occurrence needs a heading");
  const endOfTab = await call("insert_content", {
    tab_id: "t.full",
    position: "end_of_tab",
    occurrence: 2,
    content: "x",
  });
  expect(endOfTab.isError).toBe(true);
  const past = await call("get_document", { tab_id: "t.full", start_index: 900000 });
  expect(past.isError).toBe(true);
  expect(past.text).toContain("No element overlaps");
});

test("the markdown parser stays quick on a long line of open marks", async () => {
  const { call } = await connect(reportDoc());
  const started = Date.now();
  await call("insert_content", {
    tab_id: "t.full",
    heading: "Overview",
    position: "after_heading",
    content: `${"*a ".repeat(20_000)}\n${"[".repeat(60_000)}`,
  });
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("characters Docs would strip are removed first, so a later range stays true", async () => {
  const doc = reportDoc();
  const { call, batches } = await connect(doc);
  await call("insert_content", {
    tab_id: "t.full",
    heading: "Overview",
    position: "after_heading",
    content: "a\u0007bc **bold**",
  });
  const inserted = batches[0].requests[0].insertText.text as string;
  expect(inserted).toBe("abc bold\n");
  expect(styledRuns(doc, "t.full").find(([t]) => t === "bold")?.[1]).toEqual({ bold: true });
});

test("suggest makes every request a suggestion, against the revision it measured", async () => {
  const doc = reportDoc();
  const { call, batches, reads } = await connect(doc);
  const { text } = await call("insert_content", {
    tab_id: "t.full",
    heading: "Open questions",
    position: "before_heading",
    content: SECTION,
    suggest: true,
  });
  expect(reads[0]).toEqual({ includeTabsContent: true, suggestionsViewMode: "SUGGESTIONS_INLINE" });
  expect(batches[0].writeControl).toEqual({ writeMode: "SUGGEST", targetRevisionId: "rev-42" });
  expect(text).toContain("# Content Suggested");
  expect(text).toContain("**Applied as:** suggestion, pending review");
});

test("without suggest the batch is a direct edit, still pinned to the revision", async () => {
  const { call, batches } = await connect(reportDoc());
  await call("insert_content", {
    tab_id: "t.full",
    heading: "Overview",
    position: "after_heading",
    content: "x",
  });
  expect(batches[0].writeControl).toEqual({ targetRevisionId: "rev-42" });
});

test("a heading with a pending edit is found by either reading of it", async () => {
  const doc = reportDoc();
  const content = doc.tabs![1].documentTab!.body!.content!;
  const heading = content.find((e) => e.paragraph?.paragraphStyle?.headingId === "h.fopen")!;
  const run = heading.paragraph!.elements![0];
  const start = run.startIndex as number;
  // "Open questions" with "Open" pending deletion and "Closed" pending insertion.
  heading.paragraph!.elements = [
    { startIndex: start, endIndex: start + 4, textRun: { content: "Open", suggestedDeletionIds: ["s"] } },
    { startIndex: start + 4, endIndex: start + 10, textRun: { content: "Closed", suggestedInsertionIds: ["s"] } },
    { startIndex: start + 10, endIndex: start + 21, textRun: { content: " questions\n" } },
  ];
  const { call } = await connect(doc);
  for (const wanted of ["Open questions", "Closed questions"]) {
    const { isError, text } = await call("get_document", { tab_id: "t.full", heading: wanted });
    expect(isError, text).toBe(false);
  }
});

test("tab_id reaches all three wrappers", async () => {
  const doc = reportDoc();
  const { call, batches, reads } = await connect(doc);

  const lines = await call("get_document", {
    tab_id: "t.full",
    heading: "Overview",
    format: "outline_with_indices",
  });
  const index = Number(lines.text.match(/\n(\d+)-\d+ NORMAL_TEXT "Why this exists/)![1]);

  await call("insert_text", { tab_id: "t.full", index, text: "Inserted. " });
  expect(batches[0].requests[0].insertText.location).toEqual({ index, tabId: "t.full" });
  expect(readTab(doc, "t.full").some((l) => l.includes("Inserted. Why this exists"))).toBe(true);

  await call("append_text", { tab_id: "t.full", text: " Appended." });
  expect(reads.at(-1)).toEqual({
    suggestionsViewMode: "SUGGESTIONS_INLINE",
    includeTabsContent: true,
  });
  expect(readTab(doc, "t.full").at(-1)).toBe("NORMAL_TEXT|Who owns the rollback? Appended.");

  const unknown = await call("append_text", { tab_id: "t.nope", text: "x" });
  expect(unknown.isError).toBe(true);
  expect(unknown.text).toContain('Tab "t.nope" not found');
});

test("replace_text's tab_id narrows it, and its absence still reaches every tab", async () => {
  const sent: unknown[] = [];
  const doc = reportDoc();
  const { client } = simulatedClient(doc);
  (client as any).batchUpdate = async (_: string, requests: unknown[]) => {
    sent.push(...requests);
    return { documentId: DOC_ID, replies: [{ replaceAllText: { occurrencesChanged: 1 } }] };
  };
  const { server, registerHandlers } = createMCPServer({ version: "test" });
  await registerHandlers(server as unknown as Server, () => client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: "t", version: "0" });
  await mcp.connect(b);

  await mcp.callTool({
    name: "replace_text",
    arguments: { document_id: DOC_ID, find: "a", replace: "b", tab_id: "t.full", suggest: true },
  });
  await mcp.callTool({
    name: "replace_text",
    arguments: { document_id: DOC_ID, find: "a", replace: "b" },
  });
  expect(sent).toEqual([
    {
      replaceAllText: {
        containsText: { text: "a", matchCase: false },
        replaceText: "b",
        tabsCriteria: { tabIds: ["t.full"] },
      },
    },
    { replaceAllText: { containsText: { text: "a", matchCase: false }, replaceText: "b" } },
  ]);
});

test("insert_text without tab_id is the request it always was", async () => {
  const { call, batches } = await connect(reportDoc());
  await call("insert_text", { index: 3, text: "x" });
  expect(batches[0].requests).toEqual([{ insertText: { location: { index: 3 }, text: "x" } }]);
  expect(batches[0].writeControl).toBeUndefined();
});

// ---- reads ----------------------------------------------------------------

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

test("a section read is a fraction of the document, and reaches a heading the raw JSON buries", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);

  const whole = await call("get_document", { tab_id: "t.condensed", format: "json" });
  const everyTab = await call("get_document", { format: "json" });
  const section = await call("get_document", {
    tab_id: "t.condensed",
    heading: "Agent Run Lifecycle",
    format: "json",
    include_styles: false,
  });
  const lines = await call("get_document", {
    tab_id: "t.condensed",
    format: "outline_with_indices",
  });
  const noTables = await call("get_document", {
    tab_id: "t.condensed",
    format: "outline_with_indices",
    skip_tables: true,
  });

  expect(bytes(whole.text)).toBeGreaterThan(50 * bytes(noTables.text));
  expect(bytes(section.text)).toBeLessThan(bytes(whole.text) / 5);
  expect(JSON.parse(section.text).section.heading).toBe("🖼️ Agent Run Lifecycle");
  expect(section.text).not.toContain("tableCellStyle");
  expect(section.text).not.toContain("paragraphStyle\": {\n          \"direction");
});

test("outline_with_indices gives one line per paragraph, with indexes an edit can use", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  const { text } = await call("get_document", {
    tab_id: "t.full",
    heading: "Overview",
    format: "outline_with_indices",
  });
  expect(text).toMatch(/\d+-\d+ HEADING_1 heading_id=h\.foverview "Overview"/);
  expect(text).toMatch(/\d+-\d+ TABLE 5x4/);
  expect(text).toMatch(/ {2}r2c3 \d+-\d+ NORMAL_TEXT "Stage 1\.2 → done 🖼️"/);
  expect(text).not.toContain("Topic 1");

  const collapsed = await call("get_document", {
    tab_id: "t.full",
    heading: "Overview",
    format: "outline_with_indices",
    skip_tables: true,
  });
  expect(collapsed.text).toMatch(/\d+-\d+ TABLE 5x4/);
  expect(collapsed.text).not.toContain("r2c3");
});

test("every tab comes back in outline_with_indices, under its own heading", async () => {
  const { call } = await connect(reportDoc());
  const { text } = await call("get_document", { format: "outline_with_indices", skip_tables: true });
  expect(text).toContain("## Tab: Condensed (tab_id: `t.condensed`)");
  expect(text).toContain("## Tab: Full (tab_id: `t.full`)");
  expect(text).toContain('list-item "First point about topic 1"');
});

test("the index a preview shows is the index of the paragraph", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  const { text } = await call("get_document", { tab_id: "t.full", format: "outline_with_indices" });
  const shown = [...text.matchAll(/^(\d+)-(\d+) \w+(?: heading_id=\S+)? "(.*)"$/gm)];
  expect(shown.length).toBeGreaterThan(20);
  for (const [, start, end, content] of shown) {
    const element = doc.tabs![1].documentTab!.body!.content!.find(
      (e) => e.startIndex === Number(start) && e.endIndex === Number(end),
    );
    expect(element?.paragraph, `no paragraph at ${start}-${end}`).toBeDefined();
    expect(element!.paragraph!.elements![0].textRun!.content).toContain(content.replace(/…$/, ""));
  }
});

test("a long paragraph is cut at 80 characters without splitting a surrogate pair", async () => {
  const doc = reportDoc();
  const paragraph = doc.tabs![0].documentTab!.body!.content![2].paragraph!;
  paragraph.elements![0].textRun!.content = `${"🖼".repeat(100)}\n`;
  const { call } = await connect(doc);
  const { text } = await call("get_document", {
    tab_id: "t.condensed",
    format: "outline_with_indices",
  });
  expect(text).toContain(`"${"🖼".repeat(80)}…"`);
});

test("a range returns the elements it overlaps, whole, and needs a tab", async () => {
  const { call } = await connect(reportDoc());
  const ranged = await call("get_document", {
    tab_id: "t.full",
    start_index: 1,
    end_index: 3,
    format: "outline_with_indices",
  });
  expect(ranged.text).toContain("TITLE");
  expect(ranged.text).not.toContain("Overview");

  const noTab = await call("get_document", { start_index: 1 });
  expect(noTab.isError).toBe(true);
  expect(noTab.text).toContain("needs a tab_id");

  const backwards = await call("get_document", { tab_id: "t.full", start_index: 9, end_index: 3 });
  expect(backwards.isError).toBe(true);
  const both = await call("get_document", { tab_id: "t.full", heading: "x", start_index: 3 });
  expect(both.isError).toBe(true);
  expect(both.text).toContain("not both");
});

test("format=text reads one section, and skip_tables takes its cells out", async () => {
  const { call } = await connect(reportDoc());
  const section = await call("get_document", { heading: "Overview", tab_id: "t.full" });
  expect(section.text).toContain("**Section:** HEADING_1");
  expect(section.text).toContain("Why this exists");
  expect(section.text).toContain("Stage 1.2");
  expect(section.text).not.toContain("Topic 1 opens");

  const noTables = await call("get_document", {
    heading: "Overview",
    tab_id: "t.full",
    skip_tables: true,
  });
  expect(noTables.text).not.toContain("Stage 1.2");

  const wholeTab = await call("get_document", { tab_id: "t.full", skip_tables: true });
  expect(wholeTab.text).not.toContain("Stage 1.2");
  expect(wholeTab.text).toContain("Why this exists");
});

test("include_styles and skip_tables reduce format=json in the shape it already had", async () => {
  const { call } = await connect(reportDoc());
  const multi = JSON.parse(
    (await call("get_document", { format: "json", include_styles: false, skip_tables: true })).text,
  );
  expect(multi.tabs).toHaveLength(2);
  const body = multi.tabs[1].documentTab.body.content;
  const table = body.find((e: any) => e.table);
  expect(table.table).toEqual({ rows: 5, columns: 4 });
  const heading = body.find((e: any) => e.paragraph?.paragraphStyle?.headingId === "h.foverview");
  expect(heading.paragraph.paragraphStyle).toEqual({
    namedStyleType: "HEADING_1",
    headingId: "h.foverview",
  });
  expect(multi.tabs[1].documentTab.namedStyles).toBeUndefined();

  const one = JSON.parse(
    (await call("get_document", { format: "json", tab_id: "t.full", include_styles: false })).text,
  );
  expect(one.tabProperties.tabId).toBe("t.full");
  expect(one.body.content.find((e: any) => e.table).table.tableRows[0].tableCells[0].tableCellStyle).toBeUndefined();
});

test("format=json with no filter is the resource it always was", async () => {
  const doc = reportDoc();
  const { call } = await connect(doc);
  const { text } = await call("get_document", { format: "json" });
  expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(doc)));
});

test("insert_content is a write tool: readonly does not list it", async () => {
  const { createRegisterTools } = await import("google-docs-workspace-mcp-server-shared");
  const names = async (groups: Array<"readonly" | "readwrite" | "readwrite_external">) => {
    const server = new Server({ name: "t", version: "0" }, { capabilities: { tools: {} } });
    createRegisterTools(() => {
      throw new Error("unused");
    }, groups)(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    return (await client.listTools()).tools.map((t) => t.name);
  };
  expect(await names(["readonly"])).not.toContain("insert_content");
  expect(await names(["readwrite"])).toContain("insert_content");
});

test("a seeded sweep of anchors and content puts every line where it was asked, styled as written", async () => {
  let seed = 463;
  const next = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return (seed >>> 16) % n;
  };
  const anchors = [
    "Overview",
    "Topic 1",
    "Topic 4 detail",
    "Topic 8",
    "Agent Run Lifecycle",
    "Open questions",
  ];
  const positions = ["before_heading", "after_heading", "end_of_section"];
  const pieces: Array<[string, string, string?, string?]> = [
    ["### H 🖼️", "HEADING_3|H 🖼️"],
    ["plain → text", "NORMAL_TEXT|plain → text"],
    ["**b** and *i* — 😀", "NORMAL_TEXT|b and i — 😀", "b", "bold"],
    ["- bullet 👩‍💻", "NORMAL_TEXT (list)|bullet 👩‍💻"],
    ["1. number", "NORMAL_TEXT (list)|number"],
    ["[l](https://x.test) `code`", "NORMAL_TEXT|l code", "code", "weightedFontFamily"],
  ];
  const doc = reportDoc();
  const { call } = await connect(doc);
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const marker = `m${i}`;
    const chosen = Array.from({ length: 1 + next(4) }, () => pieces[next(pieces.length)]);
    const tab = next(2) ? "t.full" : "t.condensed";
    const heading = anchors[next(anchors.length)];
    const position = positions[next(positions.length)];
    seen.add(`${tab}/${heading}/${position}`);
    for (const piece of chosen) seen.add(piece[0]);

    const { isError, text } = await call("insert_content", {
      tab_id: tab,
      heading,
      position,
      occurrence: 1,
      content: [marker, ...chosen.map((p) => p[0])].join("\n"),
    });
    expect(isError, text).toBe(false);
    assertWellFormed(doc);

    const lines = readTab(doc, tab);
    const at = lines.indexOf(`NORMAL_TEXT|${marker}`);
    expect(at, marker).toBeGreaterThanOrEqual(0);
    expect(lines.slice(at + 1, at + 1 + chosen.length)).toEqual(chosen.map((p) => p[1]));
    expect(lines.filter((l) => l === `NORMAL_TEXT|${marker}`)).toHaveLength(1);
    const runs = styledRuns(doc, tab);
    for (const [, , run, key] of chosen) {
      if (run) expect(runs.some(([t, style]) => t === run && style[key!] !== undefined)).toBe(true);
    }
  }
  // Every anchor, position and tab, and every piece, was really reached.
  expect(seen.size).toBeGreaterThanOrEqual(36 + pieces.length);
});
