/**
 * Stands in for GHCR when a test drives `scripts/resolve-image-tag.ts` for real.
 *
 * Loaded with `node --import`, so it replaces `fetch` before the script runs.
 * The one tag named by STRAD_TEST_PUBLISHED_TAG exists; every other tag 404s,
 * which is the registry's only negative answer.
 */
const published = process.env.STRAD_TEST_PUBLISHED_TAG ?? "";

globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes("/token?")) {
    return { ok: true, status: 200, json: async () => ({ token: "stub" }) };
  }
  const tag = target.split("/manifests/")[1] ?? "";
  const hit = tag !== "" && tag === published;
  return { ok: hit, status: hit ? 200 : 404 };
};
