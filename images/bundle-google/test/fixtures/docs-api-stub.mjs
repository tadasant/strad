/**
 * Preloaded (`node --import`) into the BUILT standalone google-docs entrypoint
 * by `../standalone.test.ts`, so the real binary — its real client, its real
 * `documents.get` — runs against a fake Docs API rather than Google's.
 *
 * Two seams: the OAuth token exchange (`OAuth2Client.getAccessToken`, which
 * goes through gaxios and node-fetch, not `globalThis.fetch`) and the Docs API
 * request itself (`globalThis.fetch`). The stub answers like the API does —
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
