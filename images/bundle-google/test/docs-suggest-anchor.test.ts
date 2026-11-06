/**
 * google-docs suggests edits and anchors comments, a strad delta on the
 * vendored tree (`vendor/google-docs-shared/README.md`, `HACKS.md` #135).
 *
 * `fakeClient` pins what each tool asks the client for. The tests at the end
 * fake `fetch`, to pin the request the real client sends and what it does with
 * `commentUpdateState`, a 200 that can carry a failure.
 * `standalone.test.ts` drives the built binary against the same shapes.
 */
import { afterEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OAuth2Client } from "google-auth-library";
import type {
  DocsBatchUpdateResponse,
  GoogleDoc,
  IGoogleDocsClient,
} from "google-docs-workspace-mcp-server-shared";

import { createDefaultClient, createMCPServer } from "../src/docs.js";

const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

type Run = { text: string; insertion?: boolean; deletion?: boolean };

/** One tab's body, indexed as Docs indexes it: UTF-16 code units from 1. */
function tabBody(paragraphs: Run[][]) {
  let index = 1;
  const content = paragraphs.map((runs) => {
    const startIndex = index;
    const elements = runs.map(({ text, insertion, deletion }) => {
      const run = {
        startIndex: index,
        endIndex: index + text.length,
        textRun: {
          content: text,
          ...(insertion ? { suggestedInsertionIds: ["suggest.ins"] } : {}),
          ...(deletion ? { suggestedDeletionIds: ["suggest.del"] } : {}),
        },
      };
      index = run.endIndex;
      return run;
    });
    return { startIndex, endIndex: index, paragraph: { elements } };
  });
  return { content };
}

function docWith(...tabs: Array<{ id: string; title: string; paragraphs: Run[][] }>): GoogleDoc {
  return {
    documentId: DOC_ID,
    title: "Report",
    revisionId: "rev-9",
    tabs: tabs.map((t, i) => ({
      tabProperties: { tabId: t.id, title: t.title, index: i },
      documentTab: { body: tabBody(t.paragraphs) },
    })),
  };
}

const ONE_TAB = docWith({
  id: "t.0",
  title: "Main",
  paragraphs: [[{ text: "Revenue grew 12% in Q2.\n" }], [{ text: "Costs fell 3% in Q2.\n" }]],
});

const SAVED_COMMENT: DocsBatchUpdateResponse = {
  documentId: DOC_ID,
  commentUpdateState: "ALL_SAVED",
  replies: [
    {
      insertComment: {
        commentThread: {
          commentId: "AAAAthread1",
          plainTextQuote: "grew 12%",
          headPost: { author: { displayName: "Tadas" }, createTime: "2026-11-06T12:00:00.000Z" },
        },
      },
    },
  ],
};

function fakeClient(doc: GoogleDoc, answer: Partial<DocsBatchUpdateResponse> = {}) {
  const gets: unknown[] = [];
  const batches: Array<{ requests: unknown; writeControl: unknown }> = [];
  const client = {
    async getDocument(_id: string, options: unknown) {
      gets.push(options);
      return structuredClone(doc);
    },
    async batchUpdate(_id: string, requests: unknown, writeControl: unknown) {
      batches.push({ requests, writeControl });
      return { documentId: DOC_ID, ...answer };
    },
    async createComment() {
      throw new Error("an anchored comment must not go through Drive");
    },
  } as unknown as IGoogleDocsClient;
  return { client, gets, batches };
}

async function call(
  client: IGoogleDocsClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const server = new Server(
    { name: "google-docs-workspace-mcp-server", version: "test" },
    { capabilities: { tools: {} } },
  );
  await createMCPServer({ version: "test", env: {} }).registerHandlers(server, () => client);
  const mcp = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), mcp.connect(a)]);
  try {
    const result = (await mcp.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { text: result.content[0].text, isError: result.isError === true };
  } finally {
    await mcp.close();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── Suggest mode ───────────────────────────────────────────────────────────

const SAVED_SUGGESTION = {
  commentUpdateState: "ALL_SAVED",
  suggestionResponses: [{ createdSuggestionIds: ["suggest.a"] }],
  replies: [{ replaceAllText: { occurrencesChanged: 2 } }],
};

const EDITS: Array<[string, Record<string, unknown>, unknown]> = [
  [
    "append_text",
    { text: "Tail." },
    [{ insertText: { location: { index: 45 }, text: "Tail." } }],
  ],
  [
    "insert_text",
    { index: 5, text: "Mid." },
    [{ insertText: { location: { index: 5 }, text: "Mid." } }],
  ],
  [
    "replace_text",
    { find: "Q2", replace: "Q3" },
    [{ replaceAllText: { containsText: { text: "Q2", matchCase: false }, replaceText: "Q3" } }],
  ],
  [
    "update_document",
    { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: 5 } } }] },
    [{ deleteContentRange: { range: { startIndex: 1, endIndex: 5 } } }],
  ],
];

test.each(EDITS)("%s with suggest sends writeMode SUGGEST and says so", async (name, args, requests) => {
  const fake = fakeClient(legacy(ONE_TAB), SAVED_SUGGESTION);
  const { text, isError } = await call(fake.client, name, {
    document_id: DOC_ID,
    ...args,
    suggest: true,
  });
  expect(isError).toBe(false);
  expect(fake.batches).toEqual([{ requests, writeControl: { writeMode: "SUGGEST" } }]);
  expect(text).toContain("**Applied as:** suggestion, pending review");
  expect(text).toContain("**Suggestion IDs:** suggest.a");
});

test.each(EDITS)("%s without suggest stays a direct edit with no writeControl", async (name, args, requests) => {
  const fake = fakeClient(legacy(ONE_TAB));
  const { text, isError } = await call(fake.client, name, { document_id: DOC_ID, ...args });
  expect(isError).toBe(false);
  expect(fake.batches).toEqual([{ requests, writeControl: undefined }]);
  expect(text).not.toContain("Applied as");
});

/** The document as `documents.get` returns it without `includeTabsContent`: first tab on top. */
function legacy(doc: GoogleDoc): GoogleDoc {
  return { documentId: doc.documentId, title: doc.title, ...doc.tabs?.[0].documentTab };
}

test("append_text measures the end of the body on the inline read, suggestions included", async () => {
  const withSuggestion = legacy(
    docWith({
      id: "t.0",
      title: "Main",
      paragraphs: [[{ text: "Base " }, { text: "pending", insertion: true }, { text: "\n" }]],
    }),
  );
  const fake = fakeClient(withSuggestion, SAVED_SUGGESTION);
  await call(fake.client, "append_text", { document_id: DOC_ID, text: "More", suggest: true });
  expect(fake.gets).toEqual([{ suggestionsViewMode: "SUGGESTIONS_INLINE" }]);
  // "Base pending\n" is 13 units from index 1, so the body ends at 14 and text lands before its newline.
  expect(fake.batches[0].requests).toEqual([
    { insertText: { location: { index: 13 }, text: "More" } },
  ]);
});

test("a suggestion Google does not confirm is reported, not presented as done", async () => {
  const fake = fakeClient(legacy(ONE_TAB), { commentUpdateState: "NO_UPDATES_REQUESTED" });
  const { text } = await call(fake.client, "insert_text", {
    document_id: DOC_ID,
    index: 1,
    text: "x",
    suggest: true,
  });
  expect(text).toContain("**Applied as:** UNCONFIRMED");
  expect(text).toContain("commentUpdateState: NO_UPDATES_REQUESTED");
});

test("replace_text suggesting nothing because nothing matched says exactly that", async () => {
  const fake = fakeClient(legacy(ONE_TAB), {
    commentUpdateState: "NO_UPDATES_REQUESTED",
    replies: [{ replaceAllText: {} }],
  });
  const { text } = await call(fake.client, "replace_text", {
    document_id: DOC_ID,
    find: "absent",
    replace: "x",
    suggest: true,
  });
  expect(text).toContain("**Occurrences matched:** 0");
  expect(text).toContain("no occurrence matched");
  expect(text).not.toContain("UNCONFIRMED");
});

test.each([
  ["addDocumentTab", {}],
  ["createNamedRange", { name: "n" }],
  ["deleteFooter", { footerId: "f" }],
  ["deleteHeader", { headerId: "h" }],
  ["deleteNamedRange", { name: "n" }],
  ["deleteTab", { tabId: "t.1" }],
  ["updateDocumentTabProperties", {}],
  ["updateTableColumnProperties", {}],
])("update_document refuses %s in suggest mode and sends nothing", async (request, payload) => {
  const fake = fakeClient(ONE_TAB);
  const { text, isError } = await call(fake.client, "update_document", {
    document_id: DOC_ID,
    suggest: true,
    requests: [{ insertText: { location: { index: 1 }, text: "x" } }, { [request]: payload }],
  });
  expect(isError).toBe(true);
  expect(text).toContain(`requests[1].${request}`);
  expect(text).toContain("Nothing was changed");
  expect(text).toContain("without suggest");
  expect(fake.batches).toEqual([]);
});

test.each([
  ["documentFormat", { fields: "documentFormat", documentStyle: { documentFormat: {} } }],
  ["useFirstPageHeaderFooter", { fields: "pageSize, useFirstPageHeaderFooter", documentStyle: {} }],
  ["useEvenPageHeaderFooter", { fields: "*", documentStyle: { useEvenPageHeaderFooter: true } }],
])("update_document refuses an updateDocumentStyle of %s in suggest mode", async (field, payload) => {
  const fake = fakeClient(ONE_TAB);
  const { text, isError } = await call(fake.client, "update_document", {
    document_id: DOC_ID,
    suggest: true,
    requests: [{ updateDocumentStyle: payload }],
  });
  expect(isError).toBe(true);
  expect(text).toContain(`updateDocumentStyle (${field})`);
  expect(fake.batches).toEqual([]);
});

test("a document style Docs can suggest passes, and the refusals bind only suggest mode", async () => {
  const fake = fakeClient(ONE_TAB, SAVED_SUGGESTION);
  const style = {
    updateDocumentStyle: { fields: "marginTop", documentStyle: { marginTop: {} } },
  };
  const suggested = await call(fake.client, "update_document", {
    document_id: DOC_ID,
    suggest: true,
    requests: [style],
  });
  expect(suggested.isError).toBe(false);
  const direct = await call(fake.client, "update_document", {
    document_id: DOC_ID,
    requests: [{ deleteTab: { tabId: "t.1" } }],
  });
  expect(direct.isError).toBe(false);
  expect(fake.batches).toHaveLength(2);
});

// ─── Anchored comments ──────────────────────────────────────────────────────

test("add_comment anchors to the passage's exact range and reads it inline with every tab", async () => {
  const fake = fakeClient(ONE_TAB, SAVED_COMMENT);
  const { text, isError } = await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Source?",
    quoted_text: "grew 12%",
  });
  expect(isError).toBe(false);
  expect(fake.gets).toEqual([
    { includeTabsContent: true, suggestionsViewMode: "SUGGESTIONS_INLINE" },
  ]);
  expect(fake.batches).toEqual([
    {
      requests: [
        { insertComment: { content: "Source?", range: { startIndex: 9, endIndex: 17, tabId: "t.0" } } },
      ],
      writeControl: { targetRevisionId: "rev-9" },
    },
  ]);
  expect(text).toContain("**Comment ID:** AAAAthread1");
  expect(text).toContain("**Author:** Tadas");
  expect(text).toContain('**Anchored to:** "grew 12%"');
  expect(text).toContain("indexes 9–17");
});

test("add_comment refuses text it cannot find and creates nothing", async () => {
  const fake = fakeClient(ONE_TAB, SAVED_COMMENT);
  const { text, isError } = await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Source?",
    quoted_text: "grew 13%",
  });
  expect(isError).toBe(true);
  expect(text).toContain("not found");
  expect(text).toContain("omit quoted_text");
  expect(fake.batches).toEqual([]);
});

test("add_comment refuses a repeated passage, listing the matches, until occurrence picks one", async () => {
  const fake = fakeClient(ONE_TAB, SAVED_COMMENT);
  const refused = await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Which quarter?",
    quoted_text: "in Q2",
  });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("appears 2 times");
  expect(refused.text).toContain("Revenue grew 12% in Q2.");
  expect(refused.text).toContain("Costs fell 3% in Q2.");
  expect(fake.batches).toEqual([]);

  const picked = await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Which quarter?",
    quoted_text: "in Q2",
    occurrence: 2,
  });
  expect(picked.isError).toBe(false);
  // Line one is 24 units from index 1; "in Q2" starts 14 into line two.
  expect(fake.batches[0].requests).toEqual([
    {
      insertComment: {
        content: "Which quarter?",
        range: { startIndex: 39, endIndex: 44, tabId: "t.0" },
      },
    },
  ]);

  const past = await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Which quarter?",
    quoted_text: "in Q2",
    occurrence: 3,
  });
  expect(past.isError).toBe(true);
  expect(past.text).toContain("appears 2 time(s)");
});

const TWO_TABS = docWith(
  { id: "t.0", title: "Main", paragraphs: [[{ text: "Shared line.\n" }]] },
  { id: "t.notes", title: "Notes", paragraphs: [[{ text: "Notes.\n" }, { text: "Shared line.\n" }]] },
);

test("add_comment finds a passage in any tab, and carries that tab's id on the range", async () => {
  const fake = fakeClient(TWO_TABS, SAVED_COMMENT);
  const { text } = await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Hm",
    quoted_text: "Notes.",
  });
  expect(fake.batches[0].requests).toEqual([
    { insertComment: { content: "Hm", range: { startIndex: 1, endIndex: 7, tabId: "t.notes" } } },
  ]);
  expect(text).toContain('tab "Notes" (t.notes)');
});

test("tab_id narrows the search, and a repeat across tabs names each tab", async () => {
  const fake = fakeClient(TWO_TABS, SAVED_COMMENT);
  const refused = await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Hm",
    quoted_text: "Shared line.",
  });
  expect(refused.text).toContain('tab "Main" (t.0)');
  expect(refused.text).toContain('tab "Notes" (t.notes)');

  await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Hm",
    quoted_text: "Shared line.",
    tab_id: "t.notes",
  });
  expect(fake.batches).toEqual([
    {
      requests: [
        { insertComment: { content: "Hm", range: { startIndex: 8, endIndex: 20, tabId: "t.notes" } } },
      ],
      writeControl: { targetRevisionId: "rev-9" },
    },
  ]);

  const unknown = await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Hm",
    quoted_text: "Shared line.",
    tab_id: "t.nope",
  });
  expect(unknown.isError).toBe(true);
  expect(unknown.text).toContain('Tab "t.nope" not found');
});

test("indexes are UTF-16 code units, so an emoji before the passage counts for two", async () => {
  const fake = fakeClient(
    docWith({ id: "t.0", title: "Main", paragraphs: [[{ text: "😀 launch day\n" }]] }),
    SAVED_COMMENT,
  );
  await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Date?",
    quoted_text: "launch",
  });
  expect(fake.batches[0].requests).toEqual([
    { insertComment: { content: "Date?", range: { startIndex: 4, endIndex: 10, tabId: "t.0" } } },
  ]);
});

test("a passage across runs, tables and an inline image still gets the document's indexes", async () => {
  const doc: GoogleDoc = {
    documentId: DOC_ID,
    revisionId: "rev-1",
    tabs: [
      {
        tabProperties: { tabId: "t.0", title: "Main" },
        documentTab: {
          body: {
            content: [
              { startIndex: 0, endIndex: 1, sectionBreak: {} },
              {
                startIndex: 1,
                endIndex: 2,
                table: {
                  tableRows: [
                    {
                      tableCells: [
                        {
                          content: [
                            {
                              paragraph: {
                                elements: [
                                  { startIndex: 3, endIndex: 7, textRun: { content: "Cell" } },
                                  { startIndex: 7, endIndex: 8, inlineObjectElement: {} },
                                  { startIndex: 8, endIndex: 13, textRun: { content: " text" } },
                                  { startIndex: 13, endIndex: 14, textRun: { content: "\n" } },
                                ],
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    ],
  };
  const fake = fakeClient(doc, SAVED_COMMENT);
  await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Hm",
    quoted_text: "Cell text",
  });
  expect(fake.batches[0].requests).toEqual([
    { insertComment: { content: "Hm", range: { startIndex: 3, endIndex: 13, tabId: "t.0" } } },
  ]);
});

test("a passage read straight across a pending suggestion is found, in inline indexes", async () => {
  const withReplacement = docWith({
    id: "t.0",
    title: "Main",
    paragraphs: [
      [
        { text: "Revenue in " },
        { text: "Q2", deletion: true },
        { text: "Q3", insertion: true },
        { text: " grew.\n" },
      ],
    ],
  });
  const fake = fakeClient(withReplacement, SAVED_COMMENT);
  await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Accepted wording",
    quoted_text: "in Q3 grew",
  });
  await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Original wording",
    quoted_text: "in Q2 grew",
  });
  const ranges = fake.batches.map(
    (b) => (b.requests as Array<{ insertComment: { range: unknown } }>)[0].insertComment.range,
  );
  // Both start at "in" (index 9). The first skips the pending deletion, the
  // second the pending insertion, and each range still spans the inline text.
  expect(ranges).toEqual([
    { startIndex: 9, endIndex: 21, tabId: "t.0" },
    { startIndex: 9, endIndex: 21, tabId: "t.0" },
  ]);
});

test("add_comment refuses a stray locator, and an anchored comment past Docs' limit", async () => {
  const fake = fakeClient(ONE_TAB, SAVED_COMMENT);
  const stray = await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Hm",
    occurrence: 2,
  });
  expect(stray.isError).toBe(true);
  expect(stray.text).toContain("need quoted_text");

  const long = await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "é".repeat(1025),
    quoted_text: "grew 12%",
  });
  expect(long.isError).toBe(true);
  expect(long.text).toContain("2048 bytes");
  expect(fake.batches).toEqual([]);
});

test("an anchored comment Google does not confirm is an error, not a comment ID of nothing", async () => {
  const fake = fakeClient(ONE_TAB, { commentUpdateState: "NO_UPDATES_REQUESTED", replies: [{}] });
  const { text, isError } = await call(fake.client, "add_comment", {
    document_id: DOC_ID,
    content: "Hm",
    quoted_text: "grew 12%",
  });
  expect(isError).toBe(true);
  expect(text).toContain("does not confirm the comment was saved");
});

// ─── The real client ────────────────────────────────────────────────────────

function realClient(id: string): IGoogleDocsClient {
  vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockResolvedValue({
    token: "stub-token",
    res: null,
  } as never);
  return createDefaultClient({
    GOOGLE_DOCS_OAUTH_CLIENT_ID: id,
    GOOGLE_DOCS_OAUTH_CLIENT_SECRET: `${id}-secret`,
    GOOGLE_DOCS_OAUTH_REFRESH_TOKEN: `${id}-refresh`,
  });
}

function stubDocs(answer: Record<string, unknown>) {
  const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const isGet = (init?.method ?? "GET") === "GET";
    seen.push({
      url: input,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(isGet ? ONE_TAB : answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return seen;
}

test("the real client sends writeControl only when asked, and the inline read's query", async () => {
  const seen = stubDocs({ documentId: DOC_ID });
  const client = realClient("suggest-wire");
  await client.batchUpdate(DOC_ID, [{ insertText: {} }]);
  await client.batchUpdate(DOC_ID, [{ insertText: {} }], { writeMode: "SUGGEST" });
  await client.getDocument(DOC_ID, { includeTabsContent: true, suggestionsViewMode: "SUGGESTIONS_INLINE" });
  expect(seen).toEqual([
    {
      url: `https://docs.googleapis.com/v1/documents/${DOC_ID}:batchUpdate`,
      method: "POST",
      body: { requests: [{ insertText: {} }] },
    },
    {
      url: `https://docs.googleapis.com/v1/documents/${DOC_ID}:batchUpdate`,
      method: "POST",
      body: { requests: [{ insertText: {} }], writeControl: { writeMode: "SUGGEST" } },
    },
    {
      url: `https://docs.googleapis.com/v1/documents/${DOC_ID}?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE`,
      method: "GET",
      body: undefined,
    },
  ]);
});

test.each([
  ["replace_text", { find: "Q2", replace: "Q3", suggest: true }, /^Error replacing text: /],
  ["insert_text", { index: 1, text: "x", suggest: true }, /^Error inserting text: /],
  ["update_document", { requests: [{ insertText: {} }], suggest: true }, /^Error updating document: /],
  ["add_comment", { content: "Hm", quoted_text: "grew 12%" }, /^Error adding comment: /],
])("%s reports ALL_FAILED_UNKNOWN_REASON as a failure", async (name, args, prefix) => {
  stubDocs({ documentId: DOC_ID, commentUpdateState: "ALL_FAILED_UNKNOWN_REASON" });
  const { text, isError } = await call(realClient(`failed-${name}`), name, {
    document_id: DOC_ID,
    ...args,
  });
  expect(isError).toBe(true);
  expect(text).toMatch(prefix);
  expect(text).toContain("ALL_FAILED_UNKNOWN_REASON");
  expect(text).toContain("may still have been committed");
  expect(text).toContain("before retrying");
});

test("a direct edit's ALL_FAILED_UNKNOWN_REASON is reported too", async () => {
  stubDocs({ documentId: DOC_ID, commentUpdateState: "ALL_FAILED_UNKNOWN_REASON" });
  const { isError } = await call(realClient("failed-direct"), "update_document", {
    document_id: DOC_ID,
    requests: [{ insertComment: { content: "Hm", range: { startIndex: 1, endIndex: 2 } } }],
  });
  expect(isError).toBe(true);
});
