/**
 * Show as Free / Busy — the Calendar API's event `transparency` — is a strad
 * delta on the vendored tree (`vendor/google-calendar-shared/README.md`).
 * Upstream's create and update tools build their event body from a fixed set
 * of fields, so an agent could make an event but never mark it Free.
 *
 * The tools are driven over a real MCP client, through the OAuth client and the
 * real request builders; only `fetch` and the token are stubbed. If a re-vendor
 * drops the delta, the write tests fail on the request body and the read tests
 * on the missing `**Show as:**` line.
 *
 * The fetch stub echoes a write's body back as the event, so a read-back line
 * proves the result reflects what Google returned, not that Google stored it.
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
type Call = { method: string; url: URL; body?: Record<string, unknown> };
let calls: Call[] = [];
/** What a GET for an event (or an events list) answers with. */
let stored: Record<string, unknown> = {};
let n = 0;

beforeEach(() => {
  calls = [];
  stored = {};
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
    const method = String(init.method ?? "GET");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: u, body });
    const event = {
      id: "evt1",
      summary: "Away",
      start: { date: "2026-12-01" },
      end: { date: "2026-12-03" },
      htmlLink: "https://www.google.com/calendar/event?eid=abc",
      ...stored,
      ...body,
    };
    if (method === "GET" && u.pathname.endsWith("/events")) {
      return new Response(
        JSON.stringify({ summary: "me", timeZone: "UTC", items: [event] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(event), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function connect(enabledToolGroups?: string) {
  n += 1;
  const env = {
    GOOGLE_CALENDAR_AUTH_MODE: "oauth",
    GOOGLE_CALENDAR_OAUTH_CLIENT_ID: `show-as-${n}`,
    GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: "secret",
    GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN: `refresh-${n}`,
  };
  const { server, registerHandlers } = createMCPServer({
    version: "0",
    enabledToolGroups,
  });
  await registerHandlers(server, () => createDefaultClient(env));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}

async function call(name: string, args: Record<string, unknown>) {
  const client = await connect();
  try {
    const result = await client.callTool({ name, arguments: args });
    return { result, text: JSON.stringify(result.content) };
  } finally {
    await client.close();
  }
}

const allDay = {
  summary: "Away",
  start_date: "2026-12-01",
  end_date: "2026-12-03",
};

test("create and update advertise transparency and show_as; the read tools take neither", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    for (const name of ["create_calendar_event", "update_calendar_event"]) {
      const props = tools.find((t) => t.name === name)!.inputSchema
        .properties as Record<
        string,
        { enum?: string[]; description?: string }
      >;
      expect(props.transparency.enum).toEqual(["opaque", "transparent"]);
      expect(props.transparency.description).toMatch(
        /"opaque" shows the event as Busy; "transparent" shows it as Free/,
      );
      expect(props.show_as.enum).toEqual(["free", "busy"]);
    }
    for (const name of [
      "list_calendar_events",
      "get_calendar_event",
      "list_calendars",
      "query_calendar_freebusy",
    ]) {
      const props = tools.find((t) => t.name === name)!.inputSchema
        .properties as Record<string, unknown>;
      expect(props).not.toHaveProperty("transparency");
      expect(props).not.toHaveProperty("show_as");
    }
  } finally {
    await client.close();
  }
});

test("the readonly group serves no tool that can set Show as", async () => {
  const client = await connect("readonly");
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_calendar_event",
      "list_calendar_events",
      "list_calendars",
      "query_calendar_freebusy",
    ]);
  } finally {
    await client.close();
  }
});

test.each([
  [{ transparency: "transparent" }, "transparent", "Free (transparent)"],
  [{ transparency: "opaque" }, "opaque", "Busy (opaque)"],
  [{ show_as: "free" }, "transparent", "Free (transparent)"],
  [{ show_as: "busy" }, "opaque", "Busy (opaque)"],
  [
    { show_as: "free", transparency: "transparent" },
    "transparent",
    "Free (transparent)",
  ],
])(
  "create %j sends transparency %j to events.insert and reads it back",
  async (args, sent, line) => {
    const { result, text } = await call("create_calendar_event", {
      ...allDay,
      ...args,
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body!.transparency).toBe(sent);
    expect(text).toContain(`**Show as:** ${line}`);
  },
);

test("create without either sends no transparency, and reports Google's default, Busy", async () => {
  const { result, text } = await call("create_calendar_event", allDay);
  expect(result.isError).toBeFalsy();
  expect(calls[0].body).not.toHaveProperty("transparency");
  expect(text).toContain("**Show as:** Busy (opaque)");
});

test("update with only show_as PATCHes transparency and nothing else", async () => {
  const { result, text } = await call("update_calendar_event", {
    event_id: "evt1",
    show_as: "free",
  });
  expect(result.isError).toBeFalsy();
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe("PATCH");
  expect(calls[0].url.pathname).toBe(
    "/calendar/v3/calendars/primary/events/evt1",
  );
  expect(calls[0].body).toEqual({ transparency: "transparent" });
  expect(text).toContain("**Show as:** Free (transparent)");
});

test("update with transparency opaque flips a Free event back to Busy", async () => {
  stored = { transparency: "transparent" };
  const { result, text } = await call("update_calendar_event", {
    event_id: "evt1",
    transparency: "opaque",
  });
  expect(result.isError).toBeFalsy();
  expect(calls[0].body).toEqual({ transparency: "opaque" });
  expect(text).toContain("**Show as:** Busy (opaque)");
});

test("update without either leaves transparency out of the PATCH", async () => {
  stored = { transparency: "transparent" };
  const { result, text } = await call("update_calendar_event", {
    event_id: "evt1",
    summary: "Away (work)",
  });
  expect(result.isError).toBeFalsy();
  expect(calls[0].body).toEqual({ summary: "Away (work)" });
  expect(text).toContain("**Show as:** Free (transparent)");
});

test.each(["create_calendar_event", "update_calendar_event"])(
  "%s refuses show_as and transparency that disagree, before any request",
  async (name) => {
    const { result, text } = await call(name, {
      ...allDay,
      event_id: "evt1",
      show_as: "free",
      transparency: "opaque",
    });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/disagree/);
    expect(calls).toHaveLength(0);
  },
);

test.each(["create_calendar_event", "update_calendar_event"])(
  "%s refuses a value outside the enum, before any request",
  async (name) => {
    const { result } = await call(name, {
      ...allDay,
      event_id: "evt1",
      show_as: "tentative",
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  },
);

test.each([
  [{ transparency: "transparent" }, "Free (transparent)"],
  [{ transparency: "opaque" }, "Busy (opaque)"],
  [{}, "Busy (opaque)"],
])(
  "get_calendar_event and list_calendar_events print Show as for %j",
  async (event, line) => {
    stored = event;
    const got = await call("get_calendar_event", { event_id: "evt1" });
    expect(got.result.isError).toBeFalsy();
    expect(got.text).toContain(`**Show as:** ${line}`);

    const listed = await call("list_calendar_events", {});
    expect(listed.result.isError).toBeFalsy();
    expect(listed.text).toContain(`**Show as:** ${line}`);
  },
);

test("update with show_as and transparency that agree sends the one value", async () => {
  const { result } = await call("update_calendar_event", {
    event_id: "evt1",
    show_as: "busy",
    transparency: "opaque",
  });
  expect(result.isError).toBeFalsy();
  expect(calls[0].body).toEqual({ transparency: "opaque" });
});

test("a cancelled event gets no Show as line, not an inferred Busy", async () => {
  stored = { status: "cancelled" };
  const got = await call("get_calendar_event", { event_id: "evt1" });
  expect(got.text).toContain("**Status:** cancelled");
  expect(got.text).not.toContain("Show as");

  const listed = await call("list_calendar_events", {});
  expect(listed.text).toContain("**Status:** cancelled");
  expect(listed.text).not.toContain("Show as");
});

test("a transparency value Google may add later is printed as Unknown, never as Free or Busy", async () => {
  stored = { transparency: "tentative" };
  const got = await call("get_calendar_event", { event_id: "evt1" });
  expect(got.text).toContain("**Show as:** Unknown (tentative)");
});
