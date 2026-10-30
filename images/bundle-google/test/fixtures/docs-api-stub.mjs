/**
 * Preloaded (`node --import`) into the BUILT standalone google-docs entrypoint
 * by `../standalone.test.ts`, so the real binary — its real client, its real
 * `documents.get` — runs against a fake Docs API rather than Google's.
 *
 * Three seams: the OAuth token exchange (`OAuth2Client.getAccessToken`, which
 * goes through gaxios and node-fetch, not `globalThis.fetch`), the Docs API
 * request itself (`globalThis.fetch`), and Drive's comment writes (the same
 * `globalThis.fetch`, below). The stub answers like the API does —
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
