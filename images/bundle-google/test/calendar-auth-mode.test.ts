/**
 * google-calendar's second auth mode, a strad delta on the vendored tree
 * (`vendor/google-calendar-shared/README.md`, `HACKS.md` #125).
 *
 * `GOOGLE_CALENDAR_AUTH_MODE` picks the credential: `service_account` (the
 * default, domain-wide delegation) or `oauth` (one account's refresh token).
 * Both hosts, this image's `src/index.ts` and the bundle's host, build the
 * server with `createMCPServer` and no client factory, so the mode reaches them
 * through `createDefaultClient` reading `process.env`. The last test drives that
 * exact path. If a re-vendor drops the delta, every test here fails.
 *
 * `OAuth2Client.getAccessToken` is stubbed rather than Google's token endpoint,
 * and `fetch` rather than the Calendar API.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createDefaultClient,
  createMCPServer,
  credentialEnvNames,
  missingCredentials,
  OAuthCalendarClient,
  parseAuthMode,
  GOOGLE_CALENDAR_OAUTH_ENV_NAMES,
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_ENV_NAMES,
} from "google-calendar-workspace-mcp-server-shared";

const realFetch = globalThis.fetch;
let requests: Array<{ url: string; auth: string }> = [];
let statuses: number[] = [];
let n = 0;

/** A fresh OAuth credential per test, so the per-credential client cache carries nothing over. */
function oauthEnv(): Record<string, string> {
  n += 1;
  return {
    GOOGLE_CALENDAR_AUTH_MODE: "oauth",
    GOOGLE_CALENDAR_OAUTH_CLIENT_ID: `id-${n}`,
    GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: "secret",
    GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN: `refresh-${n}`,
  };
}

const SA_ENV = {
  GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL: "bot@p.iam.gserviceaccount.com",
  GCAL_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----\\n",
  GCAL_IMPERSONATE_EMAIL: "you@example.com",
};

function stubToken(...tokens: string[]) {
  return vi
    .spyOn(OAuth2Client.prototype, "getAccessToken")
    .mockImplementation(async () => ({ token: tokens.shift() ?? "tok-last", res: null }) as never);
}

beforeEach(() => {
  requests = [];
  statuses = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    requests.push({ url: String(url), auth: (init.headers as Record<string, string>).Authorization });
    const status = statuses.shift() ?? 200;
    const body = String(url).endsWith("/calendars/primary")
      ? { id: "me@gmail.com" }
      : { items: [{ id: "primary", summary: "Me", primary: true }] };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

test("the mode defaults to service_account, takes oauth, and refuses anything else", () => {
  expect(parseAuthMode({})).toBe("service_account");
  expect(parseAuthMode({ GOOGLE_CALENDAR_AUTH_MODE: " " })).toBe("service_account");
  expect(parseAuthMode({ GOOGLE_CALENDAR_AUTH_MODE: "OAuth" })).toBe("oauth");
  expect(parseAuthMode({ GOOGLE_CALENDAR_AUTH_MODE: "service_account" })).toBe("service_account");
  expect(() => parseAuthMode({ GOOGLE_CALENDAR_AUTH_MODE: "oauth2" })).toThrow(
    /GOOGLE_CALENDAR_AUTH_MODE="oauth2" is not a mode; expected service_account or oauth/,
  );
  expect(() => createDefaultClient({ ...SA_ENV, GOOGLE_CALENDAR_AUTH_MODE: "dwd" })).toThrow(/not a mode/);
});

test("each mode names its own three variables", () => {
  expect(credentialEnvNames({})).toEqual([...GOOGLE_CALENDAR_SERVICE_ACCOUNT_ENV_NAMES]);
  expect(credentialEnvNames({ GOOGLE_CALENDAR_AUTH_MODE: "oauth" })).toEqual([...GOOGLE_CALENDAR_OAUTH_ENV_NAMES]);
  expect(missingCredentials({ GOOGLE_CALENDAR_AUTH_MODE: "oauth", ...SA_ENV })).toEqual([...GOOGLE_CALENDAR_OAUTH_ENV_NAMES]);
  expect(missingCredentials(oauthEnv())).toEqual([]);
  expect(missingCredentials(SA_ENV)).toEqual([]);
});

test("oauth mode with a variable missing fails naming it, and never falls back to a service account", () => {
  const env = { ...oauthEnv(), ...SA_ENV, GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN: "" };
  expect(() => createDefaultClient(env)).toThrow(
    /GOOGLE_CALENDAR_AUTH_MODE=oauth, but GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN is not set/,
  );
});

test("the default mode ignores stray OAuth variables and keeps the service account", async () => {
  const client = createDefaultClient({ ...SA_ENV, ...oauthEnv(), GOOGLE_CALENDAR_AUTH_MODE: "" });
  expect(client).not.toBeInstanceOf(OAuthCalendarClient);
  expect(await client.getAccountEmail()).toBe("you@example.com");
  expect(() => createDefaultClient({})).toThrow(/GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL environment variable must be set/);
});

test("oauth mode caches one client per credential, and one token across a burst", async () => {
  const spy = stubToken("tok-A");
  const env = oauthEnv();
  const client = createDefaultClient(env);
  expect(client).toBeInstanceOf(OAuthCalendarClient);
  expect(createDefaultClient({ ...env })).toBe(client);
  expect(createDefaultClient(oauthEnv())).not.toBe(client);

  await Promise.all([client.listCalendars(), client.listCalendars(), client.getEvent("primary", "e1")]);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(requests.map((r) => r.auth)).toEqual(["Bearer tok-A", "Bearer tok-A", "Bearer tok-A"]);
});

test("oauth mode resolves the account's address from its primary calendar, once", async () => {
  stubToken("tok-A");
  const client = createDefaultClient(oauthEnv());
  expect(await client.getAccountEmail()).toBe("me@gmail.com");
  expect(await client.getAccountEmail()).toBe("me@gmail.com");
  expect(requests.filter((r) => r.url.endsWith("/calendars/primary"))).toHaveLength(1);
});

test("a failed address lookup is the bare link, and is retried next time", async () => {
  stubToken("tok-A");
  const client = createDefaultClient(oauthEnv());
  statuses.push(500);
  expect(await client.getAccountEmail()).toBe("");
  expect(await client.getAccountEmail()).toBe("me@gmail.com");
});

test("a 401 is worded for a refresh token, and drops both token caches", async () => {
  const spy = stubToken("tok-A", "tok-B");
  const reset = vi.spyOn(OAuth2Client.prototype, "setCredentials");
  const env = oauthEnv();
  const client = createDefaultClient(env);

  statuses.push(401);
  await expect(client.listCalendars()).rejects.toThrow(/^OAuth authentication failed: Google rejected the access token \(HTTP 401\)/);
  expect(reset.mock.calls.at(-1)).toEqual([{ refresh_token: env.GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN }]);

  await client.listCalendars();
  expect(spy).toHaveBeenCalledTimes(2);
  expect(requests.map((r) => r.auth)).toEqual(["Bearer tok-A", "Bearer tok-B"]);
});

test("a 403 names the scope rather than the Workspace admin console", async () => {
  stubToken("tok-A");
  statuses.push(403);
  await expect(createDefaultClient(oauthEnv()).listCalendars()).rejects.toThrow(
    /Permission denied \(HTTP 403\).*https:\/\/www\.googleapis\.com\/auth\/calendar/,
  );
});

test("a revoked refresh token says to mint a new one", async () => {
  vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockRejectedValue(new Error("invalid_grant: Token has been expired or revoked."));
  await expect(createDefaultClient(oauthEnv()).listCalendars()).rejects.toThrow(/replace GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN/);
  expect(requests).toHaveLength(0);
});

test("the bundle's path — createMCPServer with no client factory — reads the mode from process.env", async () => {
  stubToken("tok-bundle");
  const env = oauthEnv();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const { server, registerHandlers } = createMCPServer({ version: "0" });
    await registerHandlers(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    const result = await client.callTool({ name: "list_calendars", arguments: {} });
    await client.close();

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("Me");
    expect(requests[0]).toEqual({
      url: "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=50",
      auth: "Bearer tok-bundle",
    });
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
