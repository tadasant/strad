/**
 * The credential path: one token exchange per burst, a revoked token that says
 * what to do, a 401 that really gets a new token, and a cache that never holds
 * a refresh token as a key.
 *
 * `OAuth2Client.getAccessToken` is stubbed rather than the token endpoint, so
 * these tests hold this server's caching to account and not the library's.
 */
import { test, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { OAuth2Client } from "google-auth-library";

import {
  createDefaultClient,
  GOOGLE_SEARCH_CONSOLE_ENV_NAMES,
  GOOGLE_SEARCH_CONSOLE_OAUTH_APP_ENV_NAMES,
  missingCredentials,
} from "../src/server.js";

const realFetch = globalThis.fetch;
let seen: string[] = [];
let statuses: number[] = [];
let n = 0;

function env() {
  // A fresh credential per test, so the per-credential client cache cannot
  // carry a token from one test into the next.
  n += 1;
  return {
    GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_ID: `id-${n}`,
    GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_SECRET: "secret",
    GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN: `refresh-${n}`,
  };
}

beforeEach(() => {
  seen = [];
  statuses = [];
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    seen.push((init.headers as Record<string, string>).Authorization);
    const status = statuses.shift() ?? 200;
    return new Response(
      JSON.stringify(status === 200 ? { siteEntry: [] } : { error: { message: "Invalid Credentials" } }),
      { status },
    );
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

test("the credential is three names, and the app pair is the first two", () => {
  assert.deepEqual(
    [...GOOGLE_SEARCH_CONSOLE_ENV_NAMES],
    [
      "GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_ID",
      "GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN",
    ],
  );
  assert.deepEqual(
    [...GOOGLE_SEARCH_CONSOLE_OAUTH_APP_ENV_NAMES],
    ["GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_ID", "GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_SECRET"],
  );
  assert.deepEqual(missingCredentials({ ...env(), GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN: "" }), [
    "GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN",
  ]);
});

test("no credential fails the call, naming the missing variables and the scope", () => {
  assert.throws(
    () => createDefaultClient({}),
    /GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_ID, GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_SECRET, GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN are not set[\s\S]*webmasters\.readonly/,
  );
});

test("concurrent calls on a cold client share one token exchange", async () => {
  const spy = vi
    .spyOn(OAuth2Client.prototype, "getAccessToken")
    .mockImplementation(async () => ({ token: "tok-A", res: { data: { expiry_date: Date.now() + 3600_000 } } }) as never);
  const client = createDefaultClient(env());
  await Promise.all([client.listSites(), client.getSite("sc-domain:a.com"), client.listSitemaps("sc-domain:a.com")]);
  assert.equal(spy.mock.calls.length, 1);
  assert.deepEqual(seen, ["Bearer tok-A", "Bearer tok-A", "Bearer tok-A"]);
});

test("the same credential gets the same client, a different one does not", () => {
  const e = env();
  assert.equal(createDefaultClient(e), createDefaultClient({ ...e }));
  assert.notEqual(createDefaultClient(e), createDefaultClient(env()));
  // A different reconnect page is a different client, or the first one built
  // would name the wrong slug's page in its invalid_grant hint.
  assert.notEqual(
    createDefaultClient(e),
    createDefaultClient({ ...e, GOOGLE_SEARCH_CONSOLE_RECONNECT_URL: "https://strad.example/ui/other" }),
  );
});

test("the client cache is keyed by a hash, never by the refresh token itself", async () => {
  const e = env();
  createDefaultClient(e);
  // The cache is module-private; what can be checked from outside is that the
  // source builds its key with a digest and not by concatenating the values.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const keyLine = source.slice(source.indexOf("const key ="), source.indexOf("let client ="));
  assert.match(keyLine, /createHash\('sha256'\)/);
  assert.match(keyLine, /\.digest\('hex'\)/);
});

test("a 401 drops the cached token AND the library's, so the next call refreshes", async () => {
  const tokens = ["tok-A", "tok-B"];
  const spy = vi
    .spyOn(OAuth2Client.prototype, "getAccessToken")
    .mockImplementation(async () => ({ token: tokens.shift(), res: null }) as never);
  const reset = vi.spyOn(OAuth2Client.prototype, "setCredentials");
  const e = env();
  const client = createDefaultClient(e);

  statuses.push(401);
  await assert.rejects(client.listSites(), /Authentication failed/);
  assert.deepEqual(reset.mock.calls.at(-1), [{ refresh_token: e.GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN }]);

  await client.listSites();
  assert.equal(spy.mock.calls.length, 2);
  assert.deepEqual(seen, ["Bearer tok-A", "Bearer tok-B"]);
});

test("a revoked refresh token says to mint a new one, and names the reconnect page when there is one", async () => {
  vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockRejectedValue(
    new Error("invalid_grant: Token has been expired or revoked."),
  );
  await assert.rejects(createDefaultClient(env()).listSites(), /replace GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN/);
  await assert.rejects(
    createDefaultClient({ ...env(), GOOGLE_SEARCH_CONSOLE_RECONNECT_URL: "https://strad.example/ui/x" }).listSites(),
    /Open https:\/\/strad.example\/ui\/x and click Reconnect Google/,
  );
  assert.equal(seen.length, 0);
});
