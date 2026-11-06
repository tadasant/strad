/**
 * Preloaded (`node --import`) into the BUILT standalone google-docs entrypoint
 * by `../standalone.test.ts`, so the real binary — its real client, its real
 * `documents.get` — runs against a fake Docs API rather than Google's.
 *
 * Four seams: the OAuth token exchange (`OAuth2Client.getAccessToken`, which
 * goes through gaxios and node-fetch, not `globalThis.fetch`), the Docs API's
 * `documents.get` (`globalThis.fetch`), its `documents.batchUpdate`, and
 * Drive's comment writes (the same `globalThis.fetch`, below). The stub answers like the API does —
 * every tab with `includeTabsContent=true`, the first tab alone without it —
 * so a server that stops asking for tabs reads one tab here exactly as it
 * would against Google.
 */
import { OAuth2Client } from "google-auth-library";
import { DOCUMENT_ID, LEGACY_FIRST_TAB, TABBED_DOC } from "./tabbed-doc.mjs";

OAuth2Client.prototype.getAccessToken = async () => ({ token: "stub-token", res: null });

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "docs.googleapis.com") return realFetch(input, init);
  if (url.pathname !== `/v1/documents/${DOCUMENT_ID}`) {
    return new Response(JSON.stringify({ error: { code: 404, message: "not found" } }), {
      status: 404,
    });
  }
  const doc = url.searchParams.get("includeTabsContent") === "true" ? TABBED_DOC : LEGACY_FIRST_TAB;
  return new Response(JSON.stringify(doc), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

/**
 * `documents.batchUpdate`, for the suggest-mode and anchored-comment tests
 * (`HACKS.md` #135). It answers as the reference documents: a
 * suggestion per request under `writeMode: SUGGEST`, `commentUpdateState`, and
 * a comment thread for `insertComment`. A range outside the addressed tab's
 * body is the 400 Google gives one.
 */
const getFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.pathname !== `/v1/documents/${DOCUMENT_ID}:batchUpdate`) return getFetch(input, init);
  const { requests, writeControl } = JSON.parse(String(init.body));
  const suggest = writeControl?.writeMode === "SUGGEST";
  const replies = [];
  for (const request of requests) {
    if (request.replaceAllText) {
      replies.push({ replaceAllText: { occurrencesChanged: 1 } });
    } else if (request.insertComment) {
      const { content, range } = request.insertComment;
      const quote = passageAt(range);
      if (quote === undefined) {
        return new Response(JSON.stringify({ error: { code: 400, message: "Invalid range" } }), {
          status: 400,
        });
      }
      replies.push({
        insertComment: {
          commentThread: {
            commentId: `docs-comment-${range.startIndex}-${range.endIndex}`,
            plainTextQuote: quote,
            headPost: { content, author: { displayName: "Stub User", me: true }, createTime: "2026-11-06T12:00:00.000Z" },
          },
        },
      });
    } else {
      replies.push({});
    }
  }
  const commented = requests.some((r) => r.insertComment);
  return new Response(
    JSON.stringify({
      documentId: DOCUMENT_ID,
      replies,
      ...(suggest
        ? { suggestionResponses: requests.map((_, i) => ({ createdSuggestionIds: [`suggest.stub${i}`] })) }
        : {}),
      commentUpdateState: suggest || commented ? "ALL_SAVED" : "NO_UPDATES_REQUESTED",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

/** The text a range covers in the tab it names, or undefined if it covers none of it. */
function passageAt({ startIndex, endIndex, tabId }) {
  const flat = (tabs) => tabs.flatMap((t) => [t, ...flat(t.childTabs ?? [])]);
  const tab = tabId ? flat(TABBED_DOC.tabs).find((t) => t.tabProperties.tabId === tabId) : TABBED_DOC.tabs[0];
  for (const element of tab?.documentTab.body.content ?? []) {
    for (const run of element.paragraph.elements) {
      if (run.startIndex <= startIndex && endIndex <= run.endIndex) {
        return run.textRun.content.slice(startIndex - run.startIndex, endIndex - run.startIndex);
      }
    }
  }
  return undefined;
}

/**
 * Drive's `comments.create` and `replies.create`, for the comment-write tests
 * (`HACKS.md` #132). Each echoes what a real create returns for the request's
 * own body, and refuses a request without the `fields` mask Drive requires.
 */
const docsFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "www.googleapis.com") return docsFetch(input, init);
  const match = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/comments(?:\/([^/]+)\/replies)?$/);
  if (!match || init?.method !== "POST" || !url.searchParams.get("fields")) {
    return new Response(JSON.stringify({ error: { code: 400, message: "bad request" } }), {
      status: 400,
    });
  }
  const body = JSON.parse(String(init.body));
  const author = { displayName: "Stub User", emailAddress: "stub@example.com", me: true };
  const created = match[2]
    ? { id: `reply-to-${match[2]}`, author, createdTime: "2026-10-30T12:00:00.000Z", ...body }
    : { id: `comment-on-${match[1]}`, author, createdTime: "2026-10-30T12:00:00.000Z", resolved: false, ...body };
  return new Response(JSON.stringify(created), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
