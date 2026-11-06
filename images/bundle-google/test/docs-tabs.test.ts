/**
 * google-docs reads EVERY tab of a document, a strad delta on the vendored
 * tree (`vendor/google-docs-shared/README.md`, `HACKS.md` #129).
 *
 * The Docs API's `documents.get` returns only the first tab's content unless
 * it is asked for `includeTabsContent=true`, so a server that stops asking
 * reads one tab and calls it the document. The fake client below answers the
 * way the API does — every tab with the flag, the first tab alone without it
 * — which is what makes every test here fail if a re-vendor drops the delta.
 *
 * The server is built through strad's own `src/docs.ts` layer, the one both
 * the bundle and the standalone entrypoint mount; `standalone.test.ts` drives
 * the built standalone binary against the same fixture.
 */
import { afterEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OAuth2Client } from "google-auth-library";
import type {
  GoogleDoc,
  IGoogleDocsClient,
} from "google-docs-workspace-mcp-server-shared";

import { createDefaultClient, createMCPServer } from "../src/docs.js";
// A plain .mjs fixture, shared with the standalone preload `./fixtures/docs-api-stub.mjs`.
import { DOCUMENT_ID, LEGACY_FIRST_TAB, TABBED_DOC } from "./fixtures/tabbed-doc.mjs";

type GetOptions = { includeTabsContent?: boolean; suggestionsViewMode?: string } | undefined;

/** A client whose `documents.get` behaves like the API's, recording what it was asked. */
function fakeClient(doc: GoogleDoc, legacy: GoogleDoc) {
  const calls: GetOptions[] = [];
  const batches: unknown[] = [];
  const client = {
    async getDocument(_id: string, options?: GetOptions) {
      calls.push(options);
      return structuredClone(options?.includeTabsContent ? doc : legacy);
    },
    async batchUpdate(documentId: string, requests: unknown[]) {
      batches.push(requests);
      return { documentId };
    },
  } as unknown as IGoogleDocsClient;
  return { client, calls, batches };
}

async function connect(client: IGoogleDocsClient): Promise<Client> {
  const server = new Server(
    { name: "google-docs-workspace-mcp-server", version: "test" },
    { capabilities: { tools: {} } },
  );
  await createMCPServer({ version: "test", env: {} }).registerHandlers(server, () => client);
  const mcp = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), mcp.connect(a)]);
  return mcp;
}

async function call(
  client: IGoogleDocsClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const mcp = await connect(client);
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

/** The same document with only its first tab — a document that never had a second. */
const SINGLE_TAB_DOC: GoogleDoc = { ...TABBED_DOC, tabs: [TABBED_DOC.tabs[0]] };

test("get_document asks the API for every tab", async () => {
  const fake = fakeClient(TABBED_DOC, LEGACY_FIRST_TAB);
  await call(fake.client, "get_document", { document_id: DOCUMENT_ID });
  expect(fake.calls).toEqual([{ includeTabsContent: true }]);
});

test("get_document returns every tab's text, nested child tabs included", async () => {
  const { client } = fakeClient(TABBED_DOC, LEGACY_FIRST_TAB);
  const { text, isError } = await call(client, "get_document", { document_id: DOCUMENT_ID });
  expect(isError).toBe(false);
  expect(text).toContain("## Tabs\n\n- Overview (tab_id: `t.0`)\n- Itinerary (tab_id: `t.itin`)\n  - Restaurants (tab_id: `t.food`)\n");
  expect(text).toContain("Dates are in the itinerary tab.");
  expect(text).toContain("Fly to Lisbon.");
  expect(text).toContain("Cervejaria Ramiro, Tuesday 8pm.");
  expect(text).toContain("## Tab: Itinerary / Restaurants\n\n**Tab ID:** t.food");
  // Document order: a parent before its child, siblings in index order.
  const order = ["## Tab: Overview", "## Tab: Itinerary\n", "## Tab: Itinerary / Restaurants"].map((h) =>
    text.indexOf(h),
  );
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((x, y) => x - y)).toEqual(order);
});

test("get_document with tab_id reads just that tab, a nested one included", async () => {
  const { client } = fakeClient(TABBED_DOC, LEGACY_FIRST_TAB);
  const { text } = await call(client, "get_document", { document_id: DOCUMENT_ID, tab_id: "t.food" });
  expect(text).toContain("**Tab:** Itinerary / Restaurants (tab_id: `t.food`)");
  expect(text).toContain("## Body\n\nCervejaria Ramiro, Tuesday 8pm.");
  expect(text).not.toContain("Fly to Lisbon.");
  expect(text).not.toContain("Dates are in the itinerary tab.");
});

test("a pasted URL's ?tab= does not narrow the read — Docs puts ?tab=t.0 on nearly every URL", async () => {
  const { client } = fakeClient(TABBED_DOC, LEGACY_FIRST_TAB);
  const { text } = await call(client, "get_document", {
    document_id: `https://docs.google.com/document/d/${DOCUMENT_ID}/edit?tab=t.0`,
  });
  expect(text).toContain("Dates are in the itinerary tab.");
  expect(text).toContain("Fly to Lisbon.");
  expect(text).toContain("Cervejaria Ramiro");
});

test("one tab of a multi-tab document says the others exist", async () => {
  const { client } = fakeClient(TABBED_DOC, LEGACY_FIRST_TAB);
  const { text } = await call(client, "get_document", { document_id: DOCUMENT_ID, tab_id: "t.0" });
  expect(text).toContain("**Other tabs:** 2 more in this document");
});

test("an empty tab, and a tab with no content or properties, still render", async () => {
  const doc: GoogleDoc = {
    documentId: DOCUMENT_ID,
    title: "Sparse",
    tabs: [
      { tabProperties: { tabId: "t.a", title: "Empty", index: 0 }, documentTab: { body: { content: [] } } },
      { tabProperties: { index: 1 } },
    ],
  };
  const { client } = fakeClient(doc, LEGACY_FIRST_TAB);
  const { text, isError } = await call(client, "get_document", { document_id: DOCUMENT_ID });
  expect(isError).toBe(false);
  expect(text).toContain("- Empty (tab_id: `t.a`)\n- (Untitled Tab)\n");
  expect(text).toContain("## Tab: Empty\n\n**Tab ID:** t.a\n\n### Body\n\n(empty tab)");
  const outline = await call(client, "get_document_outline", { document_id: DOCUMENT_ID });
  expect(outline.isError).toBe(false);
  expect(outline.text).toContain("## Tab: (Untitled Tab)");
});

test("an unknown tab_id is an error naming the tabs that exist", async () => {
  const { client } = fakeClient(TABBED_DOC, LEGACY_FIRST_TAB);
  const { text, isError } = await call(client, "get_document", { document_id: DOCUMENT_ID, tab_id: "t.nope" });
  expect(isError).toBe(true);
  expect(text).toContain('Tab "t.nope" not found');
  expect(text).toContain('"t.food" (Itinerary / Restaurants)');
});

test("get_document format=json: every tab for a multi-tab doc, a tab's body at the top level with tab_id", async () => {
  const { client } = fakeClient(TABBED_DOC, LEGACY_FIRST_TAB);
  const all = JSON.parse((await call(client, "get_document", { document_id: DOCUMENT_ID, format: "json" })).text);
  expect(all.tabs[1].childTabs[0].tabProperties.tabId).toBe("t.food");

  const one = JSON.parse(
    (await call(client, "get_document", { document_id: DOCUMENT_ID, format: "json", tab_id: "t.itin" })).text,
  );
  expect(one.tabs).toBeUndefined();
  expect(one.tabProperties.tabId).toBe("t.itin");
  expect(one.body).toEqual(TABBED_DOC.tabs[1].documentTab.body);
  expect(one.documentId).toBe(DOCUMENT_ID);
});

test("a single-tab document reads exactly as it did without includeTabsContent", async () => {
  // What the server returned when it asked for the legacy shape: the reference.
  const legacy = fakeClient(LEGACY_FIRST_TAB, LEGACY_FIRST_TAB);
  const single = fakeClient(SINGLE_TAB_DOC, LEGACY_FIRST_TAB);

  const textBefore = await call(legacy.client, "get_document", { document_id: DOCUMENT_ID });
  const textAfter = await call(single.client, "get_document", { document_id: DOCUMENT_ID });
  expect(textAfter.text).toBe(textBefore.text);

  // Same fields, same values — every content key lifted back to the top level.
  const jsonBefore = await call(legacy.client, "get_document", { document_id: DOCUMENT_ID, format: "json" });
  const jsonAfter = await call(single.client, "get_document", { document_id: DOCUMENT_ID, format: "json" });
  expect(JSON.parse(jsonAfter.text)).toEqual(JSON.parse(jsonBefore.text));
  expect(JSON.parse(jsonAfter.text).namedStyles).toEqual(LEGACY_FIRST_TAB.namedStyles);

  const before = await call(legacy.client, "get_document_outline", { document_id: DOCUMENT_ID });
  const after = await call(single.client, "get_document_outline", { document_id: DOCUMENT_ID });
  expect(after.text).toBe(before.text);
  expect(after.text).not.toContain("Tab");
});

test("get_document_outline lists every tab with its id and headings", async () => {
  const fake = fakeClient(TABBED_DOC, LEGACY_FIRST_TAB);
  const { text } = await call(fake.client, "get_document_outline", { document_id: DOCUMENT_ID });
  expect(fake.calls).toEqual([{ includeTabsContent: true }]);
  expect(text).toContain("## Tab: Overview\n\n**Tab ID:** t.0\n\n- H1: Overview\n");
  expect(text).toContain("## Tab: Itinerary\n\n**Tab ID:** t.itin\n\n  - H2: Day 1\n");
  expect(text).toContain("## Tab: Itinerary / Restaurants\n\n**Tab ID:** t.food\n\n_No headings found in this tab._\n");

  const one = await call(fake.client, "get_document_outline", { document_id: DOCUMENT_ID, tab_id: "t.itin" });
  expect(one.text).toContain("## Tab: Itinerary\n");
  expect(one.text).not.toContain("Overview\n\n**Tab ID");

  const missing = await call(fake.client, "get_document_outline", { document_id: DOCUMENT_ID, tab_id: "t.nope" });
  expect(missing.isError).toBe(true);
  expect(missing.text).toContain('"t.itin" (Itinerary)');
});

test("append_text still targets the first tab, where batchUpdate's default lands", async () => {
  const fake = fakeClient(TABBED_DOC, LEGACY_FIRST_TAB);
  const { isError } = await call(fake.client, "append_text", { document_id: DOCUMENT_ID, text: "x" });
  expect(isError).toBe(false);
  // The legacy (first-tab) shape, so the end index is the first tab's.
  expect(fake.calls).toEqual([{ suggestionsViewMode: "SUGGESTIONS_INLINE" }]);
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

test("the real client sends includeTabsContent=true on documents.get", async () => {
  vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockImplementation(
    async () => ({ token: "tok", res: null }) as never,
  );
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify(TABBED_DOC), { status: 200 });
  }) as typeof fetch;

  const client = createDefaultClient({
    GOOGLE_DOCS_OAUTH_CLIENT_ID: "id-tabs",
    GOOGLE_DOCS_OAUTH_CLIENT_SECRET: "secret",
    GOOGLE_DOCS_OAUTH_REFRESH_TOKEN: "refresh-tabs",
  });
  const { text } = await call(client, "get_document", { document_id: DOCUMENT_ID });
  expect(urls).toEqual([`https://docs.googleapis.com/v1/documents/${DOCUMENT_ID}?includeTabsContent=true`]);
  expect(text).toContain("Cervejaria Ramiro");
});
