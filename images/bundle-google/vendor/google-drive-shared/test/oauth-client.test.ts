/**
 * The credential path: one token exchange per burst, a revoked token that says
 * what to do, and a 401 that really gets a new token.
 *
 * `OAuth2Client.getAccessToken` is stubbed rather than the token endpoint, so
 * these tests hold this server's caching to account and not the library's.
 */
import { test, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { OAuth2Client } from "google-auth-library";

import { createDefaultClient } from "../src/server.js";

const realFetch = globalThis.fetch;
let seen: string[] = [];
let statuses: number[] = [];
let n = 0;

function env() {
  // A fresh credential per test, so the per-credential client cache cannot
  // carry a token from one test into the next.
  n += 1;
  return {
    GOOGLE_DRIVE_OAUTH_CLIENT_ID: `id-${n}`,
    GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: "secret",
    GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: `refresh-${n}`,
  };
}

beforeEach(() => {
  seen = [];
  statuses = [];
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    seen.push((init.headers as Record<string, string>).Authorization);
    const status = statuses.shift() ?? 200;
    return new Response(JSON.stringify(status === 200 ? { id: "f" } : { error: { message: "Invalid Credentials" } }), {
      status,
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

test("concurrent calls on a cold client share one token exchange", async () => {
  const spy = vi
    .spyOn(OAuth2Client.prototype, "getAccessToken")
    .mockImplementation(async () => ({ token: "tok-A", res: { data: { expiry_date: Date.now() + 3600_000 } } }) as never);
  const client = createDefaultClient(env());
  await Promise.all([client.getFile("a"), client.getFile("b"), client.getFile("c")]);
  assert.equal(spy.mock.calls.length, 1);
  assert.deepEqual(seen, ["Bearer tok-A", "Bearer tok-A", "Bearer tok-A"]);
});

test("the same credential gets the same client, a different one does not", () => {
  const e = env();
  assert.equal(createDefaultClient(e), createDefaultClient({ ...e }));
  assert.notEqual(createDefaultClient(e), createDefaultClient(env()));
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
  await assert.rejects(client.getFile("a"), /Authentication failed/);
  // The library's own cache is replaced by a bare refresh token.
  assert.deepEqual(reset.mock.calls.at(-1), [{ refresh_token: e.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN }]);

  await client.getFile("a");
  assert.equal(spy.mock.calls.length, 2);
  assert.deepEqual(seen, ["Bearer tok-A", "Bearer tok-B"]);
});

test("a revoked refresh token says to mint a new one, and names the reconnect page when there is one", async () => {
  vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockRejectedValue(new Error("invalid_grant: Token has been expired or revoked."));
  await assert.rejects(createDefaultClient(env()).getFile("a"), /replace GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN/);
  await assert.rejects(
    createDefaultClient({ ...env(), GOOGLE_DRIVE_RECONNECT_URL: "https://strad.example/ui/x" }).getFile("a"),
    /Open https:\/\/strad.example\/ui\/x and click Reconnect Google/,
  );
  assert.equal(seen.length, 0);
});
