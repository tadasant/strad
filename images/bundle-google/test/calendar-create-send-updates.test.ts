/**
 * `create_calendar_event` takes `send_updates`, a strad delta on the vendored
 * tree (`vendor/google-calendar-shared/README.md`). Upstream threads
 * `sendUpdates` through update and delete but not create, so on create a
 * caller can neither ask for invites to be emailed nor ask explicitly for none.
 *
 * The tool is driven over a real MCP client, through the OAuth client and the
 * real `createEvent` request builder; only `fetch` and the token are stubbed.
 * If a re-vendor drops the delta, every test but the omitted one fails.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createDefaultClient,
  createMCPServer,
} from "google-calendar-workspace-mcp-server-shared";

const realFetch = globalThis.fetch;
let inserts: URL[] = [];
let methods: string[] = [];
let n = 0;

beforeEach(() => {
  inserts = [];
  methods = [];
  vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockResolvedValue({
    token: "tok",
    res: null,
  } as never);
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/calendars/primary")) {
      return new Response(JSON.stringify({ id: "me@gmail.com" }), {
        status: 200,
      });
    }
    methods.push(String(init.method));
    inserts.push(u);
    const event = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        ...event,
        id: "evt1",
        htmlLink: "https://www.google.com/calendar/event?eid=abc",
      }),
      { status: 200 },
    );
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function create(args: Record<string, unknown>) {
  n += 1;
  const env = {
    GOOGLE_CALENDAR_AUTH_MODE: "oauth",
    GOOGLE_CALENDAR_OAUTH_CLIENT_ID: `send-updates-${n}`,
    GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: "secret",
    GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN: `refresh-${n}`,
  };
  const { server, registerHandlers } = createMCPServer({ version: "0" });
  await registerHandlers(server, () => createDefaultClient(env));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  try {
    return {
      tools: (await client.listTools()).tools,
      result: await client.callTool({
        name: "create_calendar_event",
        arguments: {
          summary: "Dinner",
          start_datetime: "2026-11-20T19:00:00-08:00",
          end_datetime: "2026-11-20T21:00:00-08:00",
          attendees: ["guest@example.com"],
          ...args,
        },
      }),
    };
  } finally {
    await client.close();
  }
}

test("the tool advertises send_updates, and says none creates without emailing invites", async () => {
  const { tools } = await create({});
  const tool = tools.find((t) => t.name === "create_calendar_event")!;
  const prop = (
    tool.inputSchema.properties as Record<
      string,
      { enum?: string[]; description?: string }
    >
  ).send_updates;
  expect(prop.enum).toEqual(["all", "externalOnly", "none"]);
  expect(prop.description).toMatch(
    /"none" creates the event without emailing invites to attendees/,
  );
  expect(prop.description).toMatch(
    /Pass "all" to be sure attendees are invited/,
  );
  expect(tool.description).toMatch(
    /"none" to create the event without emailing invites/,
  );
  expect(tool.inputSchema.required).toEqual(["summary"]);
});

test.each([
  ["all", "Sent to all attendees"],
  ["externalOnly", "Sent to external attendees only"],
  ["none", "None requested"],
])(
  "send_updates %j reaches events.insert as sendUpdates, and the result says so",
  async (value, line) => {
    const { result } = await create({ send_updates: value });
    expect(result.isError).toBeFalsy();
    expect(methods).toEqual(["POST"]);
    expect(inserts[0].pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(inserts[0].searchParams.get("sendUpdates")).toBe(value);
    expect(JSON.stringify(result.content)).toContain(
      `**Notifications:** ${line}`,
    );
  },
);

test("send_updates sits beside supportsAttachments on the same request", async () => {
  const { result } = await create({
    send_updates: "externalOnly",
    attachments: [{ file_url: "https://drive.google.com/file/d/x/view" }],
  });
  expect(result.isError).toBeFalsy();
  expect(inserts[0].searchParams.get("sendUpdates")).toBe("externalOnly");
  expect(inserts[0].searchParams.get("supportsAttachments")).toBe("true");
});

test("omitted, no sendUpdates is sent, so Google's own default is unchanged", async () => {
  const { result } = await create({});
  expect(result.isError).toBeFalsy();
  expect(inserts[0].search).toBe("");
  expect(JSON.stringify(result.content)).not.toContain("Notifications");
});

test("a value outside the three is refused before any request", async () => {
  const { result } = await create({ send_updates: "nobody" });
  expect(result.isError).toBe(true);
  expect(inserts).toHaveLength(0);
});
