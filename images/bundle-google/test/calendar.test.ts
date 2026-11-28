/**
 * The per-account google-calendar layer, `src/calendar.ts`, and the
 * cross-account trap it exists to close.
 *
 * What this tests is strad's own layer, not the vendored tree: the injected
 * env, the forced `oauth` mode, the name lists the bundle host's per-slug
 * discovery keys on, and the reconnect hint. It is `test/docs.test.ts` again,
 * because calendar has the same two auth modes on the same container and so
 * the same failure: an unconnected per-slug mount that inherited the bare
 * `GCAL_*` names would serve a Workspace user's calendar under a slug named for
 * another account, and every call would succeed.
 *
 * `OAuth2Client.getAccessToken` is stubbed rather than Google's token
 * endpoint, and `fetch` rather than the Calendar API.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OAuth2Client } from "google-auth-library";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  createMCPServer,
  missingCredentials,
  perSlugEnv,
  withReconnectHint,
  GOOGLE_CALENDAR_AUTH_MODE_ENV,
  GOOGLE_CALENDAR_ENV_NAMES,
  GOOGLE_CALENDAR_OAUTH_APP_ENV_NAMES,
  GOOGLE_CALENDAR_OAUTH_ENV_NAMES,
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_ENV_NAMES,
  type EnvLike,
} from "../src/calendar.js";

const SERVICE_ACCOUNT: EnvLike = {
  GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL: "dwd@example.iam.gserviceaccount.com",
  GCAL_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
  GCAL_IMPERSONATE_EMAIL: "workspace-user@example.com",
};

let n = 0;
/** A fresh account per call, so the vendored per-credential client cache carries nothing over. */
const account = (): Record<string, string> => {
  n += 1;
  return {
    GOOGLE_CALENDAR_OAUTH_CLIENT_ID: `id-${n}`,
    GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: "secret",
    GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN: `refresh-${n}`,
  };
};

const realFetch = globalThis.fetch;
let auths: string[] = [];

beforeEach(() => {
  auths = [];
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    auths.push((init.headers as Record<string, string>).Authorization);
    return new Response(JSON.stringify({ items: [{ id: "primary", summary: "Me", primary: true }] }), {
      status: 200,
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function connect(env: EnvLike): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = new Server(
    { name: "google-calendar-workspace-mcp-server", version: "test" },
    { capabilities: { tools: {} } },
  );
  await createMCPServer({ version: "test", env }).registerHandlers(server);
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const textOf = (result: unknown): string =>
  ((result as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

test("the marker pair is the OAuth app, and the host's subtraction drops every per-account name", () => {
  expect([...GOOGLE_CALENDAR_OAUTH_APP_ENV_NAMES]).toEqual([
    "GOOGLE_CALENDAR_OAUTH_CLIENT_ID",
    "GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET",
  ]);
  // `servers/bundle/host/src/index.ts` does exactly this, and
  // `dropInheritedNames` refuses to inherit the result.
  const app = new Set<string>(GOOGLE_CALENDAR_OAUTH_APP_ENV_NAMES);
  expect(GOOGLE_CALENDAR_ENV_NAMES.filter((name) => !app.has(name)).sort()).toEqual(
    [
      "GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN",
      ...GOOGLE_CALENDAR_SERVICE_ACCOUNT_ENV_NAMES,
      GOOGLE_CALENDAR_AUTH_MODE_ENV,
    ].sort(),
  );
  for (const name of GOOGLE_CALENDAR_OAUTH_ENV_NAMES) expect(GOOGLE_CALENDAR_ENV_NAMES).toContain(name);
});

test("a per-slug view is always oauth, whatever a bare mode says", () => {
  expect(perSlugEnv({})[GOOGLE_CALENDAR_AUTH_MODE_ENV]).toBe("oauth");
  expect(perSlugEnv({ GOOGLE_CALENDAR_AUTH_MODE: "service_account" })[GOOGLE_CALENDAR_AUTH_MODE_ENV]).toBe(
    "oauth",
  );
});

test("an unconnected per-slug mount is told about its TOKEN, not about a service account", () => {
  const unconnected = perSlugEnv({
    GOOGLE_CALENDAR_OAUTH_CLIENT_ID: "id",
    GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: "secret",
  });
  expect(missingCredentials(unconnected)).toEqual(["GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN"]);
});

test("THE TRAP: a bare service account beside the app pair is never used by a per-slug mount", async () => {
  // Without the forced mode, the app pair beside the inherited bare GCAL_*
  // names is a complete service-account credential, and the mount would
  // report itself healthy as somebody else.
  const inherited = {
    ...SERVICE_ACCOUNT,
    GOOGLE_CALENDAR_OAUTH_CLIENT_ID: "seeded-by-the-connector",
    GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: "seeded-by-the-connector",
  };
  expect(missingCredentials(inherited)).toEqual([]);
  // Forced to oauth, it is short its token, and a call says so.
  const env = perSlugEnv(inherited);
  expect(missingCredentials(env)).toEqual(["GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN"]);
  const { client, close } = await connect(env);
  try {
    const result = await client.callTool({ name: "list_calendars", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN is not set/);
    expect(auths).toEqual([]);
  } finally {
    await close();
  }
});

test("an unknown mode degrades naming the mode variable rather than throwing", () => {
  expect(missingCredentials({ GOOGLE_CALENDAR_AUTH_MODE: "dwd" })).toEqual([GOOGLE_CALENDAR_AUTH_MODE_ENV]);
});

test("all seven tools list, from an injected env, with no bare ENABLED_TOOLGROUPS read", async () => {
  const before = process.env.ENABLED_TOOLGROUPS;
  process.env.ENABLED_TOOLGROUPS = "readonly";
  try {
    const { client, close } = await connect(perSlugEnv({}));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "create_calendar_event",
        "delete_calendar_event",
        "get_calendar_event",
        "list_calendar_events",
        "list_calendars",
        "query_calendar_freebusy",
        "update_calendar_event",
      ]);
    } finally {
      await close();
    }
  } finally {
    if (before === undefined) delete process.env.ENABLED_TOOLGROUPS;
    else process.env.ENABLED_TOOLGROUPS = before;
  }
});

test("two mounts in one process call Google as two different accounts", async () => {
  const spy = vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockImplementation(async function (
    this: OAuth2Client,
  ) {
    return { token: `tok-for-${String(this.credentials.refresh_token)}`, res: null } as never;
  });
  const a = account();
  const b = account();
  const first = await connect(perSlugEnv(a));
  const second = await connect(perSlugEnv(b));
  try {
    await first.client.callTool({ name: "list_calendars", arguments: {} });
    await second.client.callTool({ name: "list_calendars", arguments: {} });
    expect(auths).toEqual([
      `Bearer tok-for-${a.GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN}`,
      `Bearer tok-for-${b.GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN}`,
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    await first.close();
    await second.close();
  }
});

test("a dead refresh token names the slug's own console page", async () => {
  vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockRejectedValue(new Error("invalid_grant"));
  const env = perSlugEnv({
    ...account(),
    GOOGLE_CALENDAR_RECONNECT_URL: "https://strad.example.com/ui/google-calendar-someone-ro",
  });
  const { client, close } = await connect(env);
  try {
    const result = await client.callTool({ name: "list_calendars", arguments: {} });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/invalid_grant/);
    expect(text).toMatch(/https:\/\/strad\.example\.com\/ui\/google-calendar-someone-ro/);
    expect(text).toMatch(/Reconnect Google/);
    // The vendored hint's "replace the variable by hand" is not repeated beside it.
    expect(text).not.toMatch(/replace GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN/);
  } finally {
    await close();
  }
});

test("without a reconnect URL the client is returned untouched, and other errors pass through", async () => {
  const fake = {
    listCalendars: async () => {
      throw new Error("Rate limit exceeded");
    },
  } as never;
  expect(withReconnectHint(fake, undefined)).toBe(fake);
  await expect(
    (withReconnectHint(fake, "https://strad.example.com/ui/x") as { listCalendars: () => Promise<unknown> })
      .listCalendars(),
  ).rejects.toThrow(/^Rate limit exceeded$/);
});
