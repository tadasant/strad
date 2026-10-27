/**
 * A Docs API `documents.get` response for a document with three tabs, one of
 * them nested, as `includeTabsContent=true` returns it: `tabs[]` populated and
 * the top-level `body` absent. `LEGACY_FIRST_TAB` is the same document as the
 * API returns it WITHOUT the flag — the first tab's content and nothing else,
 * which is everything the server could see before it asked for tabs.
 */
const para = (text, namedStyleType = "NORMAL_TEXT") => ({
  paragraph: {
    paragraphStyle: { namedStyleType },
    elements: [{ textRun: { content: `${text}\n` } }],
  },
});

const body = (...content) => ({ content });

export const DOCUMENT_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

const FIRST_TAB_STYLE = {
  documentStyle: { pageSize: { width: { magnitude: 612, unit: "PT" } } },
  namedStyles: { styles: [{ namedStyleType: "NORMAL_TEXT" }] },
  lists: { "kix.list1": { listProperties: {} } },
};

export const TABBED_DOC = {
  documentId: DOCUMENT_ID,
  title: "Trip plan",
  revisionId: "rev-7",
  tabs: [
    {
      tabProperties: { tabId: "t.0", title: "Overview", index: 0 },
      documentTab: {
        body: body(para("Overview", "HEADING_1"), para("Dates are in the itinerary tab.")),
        ...FIRST_TAB_STYLE,
      },
    },
    {
      tabProperties: { tabId: "t.itin", title: "Itinerary", index: 1 },
      documentTab: { body: body(para("Day 1", "HEADING_2"), para("Fly to Lisbon.")) },
      childTabs: [
        {
          tabProperties: {
            tabId: "t.food",
            title: "Restaurants",
            index: 0,
            parentTabId: "t.itin",
            nestingLevel: 1,
          },
          documentTab: { body: body(para("Cervejaria Ramiro, Tuesday 8pm.")) },
        },
      ],
    },
  ],
};

// Keys in the order Google sends them, which is not the order the server
// rebuilds them in: the comparison is by value.
export const LEGACY_FIRST_TAB = {
  title: "Trip plan",
  body: TABBED_DOC.tabs[0].documentTab.body,
  ...FIRST_TAB_STYLE,
  revisionId: "rev-7",
  documentId: DOCUMENT_ID,
};
