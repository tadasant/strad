// Gmail `message_received` over MCP Events (SEP-3415), on a gmail mount.
//
// What is pinned here, against a fake Gmail and a fake Pub/Sub:
//
//   1. Inert without the mount's own key: no event types, no extension, and a
//      poll that names the missing variable.
//   2. The event: `gmail:<message_id>`, the payload, the permalink the tools
//      print, and what is never an event (SENT, DRAFT, SPAM, TRASH, the
//      mailbox's own mail) — Zimmer's email trigger's rules.
//   3. `include_automated`, with Zimmer's automated-mail verdict.
//   4. `query`, decided by Gmail's search per message, and an event Gmail has
//      not indexed holding the cursor rather than being skipped.
//   5. Push: `users.watch` on the topic, a notification starting a read, a
//      notification for another mailbox ignored.
//   6. A history id too old to read, recovered by search.
//   7. Webhook delivery through the shared engine, signed, with the same
//      eventId as poll, and held while a query is undecided.
//   8. Restart: the buffer, the history id and the cursor survive.
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { createMCPServer } from "../src/gmail.js";
import { readPush, readWebhookAccess } from "../src/events/config.js";
import { GmailEventsIngest, INDEX_GIVE_UP_MS, type NotificationSource } from "../src/events/ingest.js";
import { automatedReason, permalinkFor, safeMessageId } from "../src/events/normalize.js";
import { parseNotification } from "../src/events/pubsub.js";
import { MemoryBlobStore } from "../src/events/state-store.js";
import type { GmailNotification } from "../src/events/pubsub.js";
import type { WebhookResponse, WebhookTransport } from "../src/events/webhook/transport.js";

const T0 = Date.parse("2026-11-19T12:00:00Z");
const ME = "zimmer@tadasant.com";
const KEY = randomBytes(32).toString("base64");
const BASE = "https://gmail.test/gmail/v1/users/me";
const TOPIC = "projects/tadasant-mail/topics/gmail-zimmer";
const SUBSCRIPTION = "projects/tadasant-mail/subscriptions/strad-gmail-zimmer";

const CONFIGURED = {
  GMAIL_EVENTS_STATE_ENCRYPTION_KEY: KEY,
  STRAD_STATE_GCS_BUCKET: "strad-state-test",
  STRAD_STATE_GCS_CLIENT_EMAIL: "state@test.iam.gserviceaccount.com",
  STRAD_STATE_GCS_PRIVATE_KEY: "unused: the blob store is in memory",
};

// --- a fake mailbox ---------------------------------------------------------------

interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  from: string;
  subject: string;
  messageId: string;
  extraHeaders?: { name: string; value: string }[];
  /** False until Gmail's search index has it. */
  indexed: boolean;
}

/**
 * Just enough of Gmail's search for these tests: `in:inbox`, `from:`/`-from:`,
 * `subject:`, `rfc822msgid:`, `after:`, and parentheses as grouping.
 */
function matches(m: FakeMessage, q: string): boolean {
  for (const raw of q.replace(/[()]/g, " ").split(/\s+/).filter(Boolean)) {
    const neg = raw.startsWith("-");
    const term = neg ? raw.slice(1) : raw;
    const [op, ...rest] = term.split(":");
    const value = rest.join(":").toLowerCase();
    let hit: boolean;
    if (op === "in" && value === "inbox") hit = m.labelIds.includes("INBOX");
    else if (op === "from") hit = m.from.toLowerCase().includes(value);
    else if (op === "subject") hit = m.subject.toLowerCase().includes(value);
    else if (op === "rfc822msgid") hit = m.messageId.toLowerCase() === value;
    else if (op === "after") hit = m.internalDate / 1000 > Number(value);
    else if (op === "before") hit = m.internalDate / 1000 < Number(value);
    else throw new Error(`fake search cannot read "${raw}"`);
    if (hit === neg) return false;
  }
  return true;
}

class FakeGmail {
  messages: FakeMessage[] = [];
  history: { id: number; messageId: string }[] = [];
  historyId = 1000;
  /** History ids at or below this answer 404, as Gmail does for an id it no longer keeps. */
  forgottenThrough = 0;
  watches: string[] = [];
  calls: string[] = [];

  deliver(m: Partial<FakeMessage> & { id: string }): FakeMessage {
    const full: FakeMessage = {
      threadId: `t-${m.id}`,
      labelIds: ["INBOX", "UNREAD"],
      internalDate: T0,
      from: "Alice <alice@example.com>",
      subject: "Hello",
      messageId: `${m.id}@mail.example.com`,
      indexed: true,
      ...m,
    };
    this.messages.push(full);
    this.history.push({ id: ++this.historyId, messageId: full.id });
    return full;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    this.calls.push(`${init?.method ?? "GET"} ${path}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/profile") return json({ emailAddress: ME, historyId: String(this.historyId) });
    if (path === "/watch") {
      this.watches.push((JSON.parse(String(init?.body)) as { topicName: string }).topicName);
      return json({ historyId: String(this.historyId), expiration: String(T0 + 7 * 86_400_000) });
    }
    if (path === "/history") {
      const start = Number(url.searchParams.get("startHistoryId"));
      if (start <= this.forgottenThrough) return json({ error: { message: "Requested entity was not found." } }, 404);
      const records = this.history.filter((h) => h.id > start);
      return json({
        history: records.map((h) => ({
          id: String(h.id),
          messagesAdded: [
            { message: { id: h.messageId, labelIds: this.messages.find((m) => m.id === h.messageId)!.labelIds } },
          ],
        })),
        historyId: String(this.historyId),
      });
    }
    if (path === "/messages") {
      const q = url.searchParams.get("q") ?? "";
      const spamTrash = url.searchParams.get("includeSpamTrash") === "true";
      const found = this.messages
        .filter((m) => m.indexed)
        .filter((m) => spamTrash || !m.labelIds.some((l) => l === "SPAM" || l === "TRASH"))
        .filter((m) => matches(m, q))
        .sort((a, b) => b.internalDate - a.internalDate);
      return json({ messages: found.map((m) => ({ id: m.id, threadId: m.threadId })) });
    }
    const get = /^\/messages\/([^/]+)$/.exec(path);
    if (get) {
      const m = this.messages.find((x) => x.id === decodeURIComponent(get[1]!));
      if (!m) return json({ error: { message: "Not Found" } }, 404);
      return json({
        id: m.id,
        threadId: m.threadId,
        labelIds: m.labelIds,
        internalDate: String(m.internalDate),
        snippet: `snippet of ${m.id}`,
        payload: {
          headers: [
            { name: "From", value: m.from },
            { name: "To", value: ME },
            { name: "Subject", value: m.subject },
            { name: "Message-ID", value: `<${m.messageId}>` },
            ...(m.extraHeaders ?? []),
          ],
        },
      });
    }
    return json({ error: { message: `fake gmail: no route ${path}` } }, 500);
  };
}

class FakeNotifications implements NotificationSource {
  pulls = 0;
  lastAckError = null;
  async pull(): Promise<GmailNotification[]> {
    this.pulls++;
    return [];
  }
}

// --- a world -------------------------------------------------------------------------

function world(opts: { env?: Record<string, string>; blobs?: MemoryBlobStore; gmail?: FakeGmail; transport?: WebhookTransport } = {}) {
  let now = T0;
  const gmail = opts.gmail ?? new FakeGmail();
  const blobs = opts.blobs ?? new MemoryBlobStore();
  const warnings: string[] = [];
  const ingest = new GmailEventsIngest({
    env: opts.env ?? CONFIGURED,
    slug: "gmail-zimmer-ro",
    authHeaders: async () => ({ authorization: "Bearer test" }),
    blobs,
    fetch: gmail.fetch as typeof fetch,
    gmailBase: BASE,
    notifications: new FakeNotifications(),
    webhookTransport: opts.transport,
    clock: () => now,
    manualTimers: true,
    warn: (m) => warnings.push(m),
  });
  return {
    gmail,
    blobs,
    ingest,
    warnings,
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

async function connect(ingest: GmailEventsIngest): Promise<Client> {
  const server = new Server({ name: "gmail", version: "test" }, { capabilities: { tools: {} } });
  await createMCPServer({ version: "test", env: CONFIGURED, events: ingest }).registerHandlers(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return client;
}

type PollAnswer = {
  events: { eventId: string; name: string; data: Record<string, unknown> }[];
  cursor: string;
  hasMore: boolean;
  truncated: boolean;
};

async function poll(client: Client, args: Record<string, unknown>, cursor: string | null): Promise<PollAnswer> {
  return (await client.request(
    { method: "events/poll", params: { name: "message_received", arguments: args, cursor } } as never,
    ResultSchema.passthrough(),
  )) as unknown as PollAnswer;
}

/** Boots, takes the "from now" baseline, and hands back a cursor at it. */
async function baseline(w: ReturnType<typeof world>, client: Client, args: Record<string, unknown> = {}) {
  await w.ingest.start();
  await w.ingest.requestSync();
  return (await poll(client, args, null)).cursor;
}

// --- 1. inert -----------------------------------------------------------------------------

describe("a gmail mount without its events key", () => {
  it("lists no event types, does not advertise the extension, and says why on a poll", async () => {
    const w = world({ env: {} });
    const client = await connect(w.ingest);
    expect(client.getServerCapabilities()?.extensions).toBeUndefined();
    const listed = (await client.request({ method: "events/list", params: {} } as never, ResultSchema.passthrough())) as {
      events: unknown[];
    };
    expect(listed.events).toEqual([]);
    await expect(poll(client, {}, null)).rejects.toThrow(/GMAIL_EVENTS_STATE_ENCRYPTION_KEY/);
    expect(w.gmail.calls).toEqual([]);
  });

  it("names the state store's variables when only the key is set", async () => {
    const w = world({ env: { GMAIL_EVENTS_STATE_ENCRYPTION_KEY: KEY } });
    expect(w.ingest.configured).toBe(false);
    expect(w.ingest.unavailableReason).toMatch(/STRAD_STATE_GCS_BUCKET/);
  });
});

// --- 2. the event ----------------------------------------------------------------------------

describe("message_received", () => {
  it("is advertised and listed when configured", async () => {
    const w = world();
    const client = await connect(w.ingest);
    expect(client.getServerCapabilities()?.extensions).toEqual({ "io.modelcontextprotocol/events": {} });
    const listed = (await client.request({ method: "events/list", params: {} } as never, ResultSchema.passthrough())) as {
      events: { name: string; delivery: string[] }[];
    };
    expect(listed.events.map((e) => [e.name, e.delivery])).toEqual([["message_received", ["poll", "webhook"]]]);
  });

  it("starts from now, then delivers new mail as gmail:<id> with the tools' Gmail link", async () => {
    const w = world();
    w.gmail.deliver({ id: "old1" }); // before the first boot: never an event
    const client = await connect(w.ingest);
    const cursor = await baseline(w, client);

    w.gmail.deliver({ id: "m1", threadId: "th1", subject: "Lunch?", from: "Bob <bob@example.com>" });
    await w.ingest.requestSync();
    const out = await poll(client, {}, cursor);
    expect(out.events.map((e) => e.eventId)).toEqual(["gmail:m1"]);
    expect(out.events[0]!.name).toBe("message_received");
    expect(out.events[0]!.data).toEqual({
      message_id: "m1",
      thread_id: "th1",
      permalink: `https://mail.google.com/mail/?authuser=${ME}#all/m1`,
      from: "Bob <bob@example.com>",
      to: ME,
      subject: "Lunch?",
      snippet: "snippet of m1",
      received_at: new Date(T0).toISOString(),
      label_ids: ["INBOX", "UNREAD"],
      is_automated: false,
      automated_reason: null,
    });

    // The cursor moves past it; a second read of the same history adds nothing.
    await w.ingest.requestSync();
    expect((await poll(client, {}, out.cursor)).events).toEqual([]);
  });

  it("never makes an event of a sent copy, a draft, spam, trash or the mailbox's own mail", async () => {
    const w = world();
    const client = await connect(w.ingest);
    const cursor = await baseline(w, client);
    w.gmail.deliver({ id: "sent", labelIds: ["SENT"] });
    w.gmail.deliver({ id: "draft", labelIds: ["DRAFT"] });
    w.gmail.deliver({ id: "spam", labelIds: ["SPAM"] });
    w.gmail.deliver({ id: "trash", labelIds: ["TRASH"] });
    w.gmail.deliver({ id: "self", from: `Zimmer <${ME}>`, labelIds: ["INBOX"] });
    w.gmail.deliver({ id: "real" });
    await w.ingest.requestSync();
    expect((await poll(client, { include_automated: true }, cursor)).events.map((e) => e.eventId)).toEqual([
      "gmail:real",
    ]);
    // A sent copy and a draft are skipped on their history labels, without a read.
    expect(w.gmail.calls).not.toContain("GET /messages/sent");
    expect(w.gmail.calls).not.toContain("GET /messages/draft");
  });

  it("builds the permalink exactly as the gmail tools print it", () => {
    expect(permalinkFor(ME, "abc")).toBe("https://mail.google.com/mail/?authuser=zimmer@tadasant.com#all/abc");
  });
});

// --- 3. include_automated ----------------------------------------------------------------------

describe("include_automated", () => {
  it("drops automated mail by default and marks it when included, with Zimmer's reasons", async () => {
    const w = world();
    const client = await connect(w.ingest);
    const cursor = await baseline(w, client);
    w.gmail.deliver({ id: "list", extraHeaders: [{ name: "List-Id", value: "<news.example.com>" }] });
    w.gmail.deliver({ id: "promo", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] });
    w.gmail.deliver({ id: "noreply", from: "no-reply@service.example.com" });
    w.gmail.deliver({ id: "ooo", subject: "Out of office: back Monday" });
    w.gmail.deliver({ id: "autosub", extraHeaders: [{ name: "Auto-Submitted", value: "auto-replied" }] });
    w.gmail.deliver({ id: "autono", extraHeaders: [{ name: "Auto-Submitted", value: "no" }] });
    w.gmail.deliver({ id: "updates", labelIds: ["INBOX", "CATEGORY_UPDATES"] });
    w.gmail.deliver({ id: "human" });
    await w.ingest.requestSync();

    const plain = await poll(client, {}, cursor);
    expect(plain.events.map((e) => e.eventId)).toEqual(["gmail:autono", "gmail:updates", "gmail:human"]);

    const all = await poll(client, { include_automated: true }, cursor);
    expect(Object.fromEntries(all.events.map((e) => [e.eventId, e.data.automated_reason]))).toEqual({
      "gmail:list": "automated: List-Id header",
      "gmail:promo": "automated: label CATEGORY_PROMOTIONS",
      "gmail:noreply": "automated: no-reply or mail-system sender",
      "gmail:ooo": "automated: auto-reply or bounce subject",
      "gmail:autosub": "automated: Auto-Submitted header",
      "gmail:autono": null,
      "gmail:updates": null,
      "gmail:human": null,
    });
  });

  it("checks headers before labels before sender before subject, as Zimmer does", () => {
    expect(
      automatedReason({
        id: "x",
        threadId: "t",
        labelIds: ["CATEGORY_SOCIAL"],
        internalDate: "0",
        snippet: "",
        headers: [
          { name: "From", value: "noreply@x.com" },
          { name: "list-id", value: "<l>" },
        ],
      }),
    ).toBe("automated: List-Id header");
  });

  it("refuses an unknown argument rather than ignoring it", async () => {
    const w = world();
    const client = await connect(w.ingest);
    await expect(poll(client, { labels: ["INBOX"] }, null)).rejects.toThrow(/unknown argument "labels"/);
  });
});

// --- 4. query ---------------------------------------------------------------------------------------

describe("query", () => {
  it("is decided by Gmail's search per message: trigger #24756's filter", async () => {
    const w = world();
    const client = await connect(w.ingest);
    const args = { query: "in:inbox -from:zimmer@tadasant.com" };
    const cursor = await baseline(w, client, args);
    w.gmail.deliver({ id: "inbox" });
    w.gmail.deliver({ id: "archived", labelIds: ["UNREAD"] });
    await w.ingest.requestSync();
    const out = await poll(client, args, cursor);
    expect(out.events.map((e) => e.eventId)).toEqual(["gmail:inbox"]);
    // Without the query both are events.
    expect((await poll(client, {}, cursor)).events.map((e) => e.eventId)).toEqual(["gmail:inbox", "gmail:archived"]);
  });

  it("holds the cursor before a message Gmail has not indexed, and delivers it once indexed", async () => {
    const w = world();
    const client = await connect(w.ingest);
    const args = { query: "subject:invoice" };
    const cursor = await baseline(w, client, args);
    w.gmail.deliver({ id: "a", subject: "Invoice 1" });
    const lagging = w.gmail.deliver({ id: "b", subject: "Invoice 2", indexed: false });
    w.gmail.deliver({ id: "c", subject: "Invoice 3" });
    await w.ingest.requestSync();

    const first = await poll(client, args, cursor);
    expect(first.events.map((e) => e.eventId)).toEqual(["gmail:a"]);
    expect(first.hasMore).toBe(false);

    lagging.indexed = true;
    const second = await poll(client, args, first.cursor);
    expect(second.events.map((e) => e.eventId)).toEqual(["gmail:b", "gmail:c"]);
  });

  it("puts a sender's Message-ID into a search only when it is one token", async () => {
    expect(safeMessageId("<CAF=abc+1@mail.gmail.com>")).toBe("CAF=abc+1@mail.gmail.com");
    for (const bad of ["<a b@x>", '<"x"@y>', "<a)OR(in:inbox@x>", "<{a}@x>"]) expect(safeMessageId(bad)).toBeUndefined();
    // A crafted one is decided by time window instead, and still matches at once.
    const w = world();
    const client = await connect(w.ingest);
    const args = { query: "subject:invoice" };
    const cursor = await baseline(w, client, args);
    w.gmail.deliver({ id: "crafted", subject: "Invoice", messageId: "x) OR (in:spam" });
    await w.ingest.requestSync();
    expect((await poll(client, args, cursor)).events.map((e) => e.eventId)).toEqual(["gmail:crafted"]);
  });

  it("decides a new query from the head, so a week of mail does not starve the queries in use", async () => {
    const w = world();
    const client = await connect(w.ingest);
    await baseline(w, client);
    for (let i = 0; i < 30; i++) w.gmail.deliver({ id: `old${i}`, internalDate: T0 + i });
    await w.ingest.requestSync();
    const searches = () => w.gmail.calls.filter((c) => c === "GET /messages").length;
    const before = searches();
    // A query first used now, from now, has nothing in the past to decide.
    await poll(client, { query: "subject:fresh" }, null);
    await w.ingest.evaluatePending();
    expect(searches()).toBe(before);
  });

  it("decides an unindexed message as not matching after 30 minutes", async () => {
    const w = world();
    const client = await connect(w.ingest);
    const args = { query: "subject:invoice" };
    const cursor = await baseline(w, client, args);
    w.gmail.deliver({ id: "never", subject: "Invoice", indexed: false });
    w.gmail.deliver({ id: "later", subject: "Invoice 2" });
    await w.ingest.requestSync();
    expect((await poll(client, args, cursor)).events).toEqual([]);
    w.advance(INDEX_GIVE_UP_MS + 1);
    const out = await poll(client, args, cursor);
    expect(out.events.map((e) => e.eventId)).toEqual(["gmail:later"]);
    expect(w.warnings.some((m) => m.includes("not in Gmail's search index"))).toBe(true);
  });
});

// --- 5. push ---------------------------------------------------------------------------------------------

describe("push", () => {
  const PUSH = { ...CONFIGURED, GMAIL_EVENTS_PUBSUB_TOPIC: TOPIC, GMAIL_EVENTS_PUBSUB_SUBSCRIPTION: SUBSCRIPTION };

  it("watches the topic, and a notification for this mailbox starts a read", async () => {
    const w = world({ env: PUSH });
    const client = await connect(w.ingest);
    const cursor = await baseline(w, client);
    expect(w.gmail.watches).toEqual([TOPIC]);
    expect(w.ingest.status()).toMatchObject({ mode: "push", watch: { last_error: null } });

    w.gmail.deliver({ id: "pushed" });
    const before = w.gmail.calls.filter((c) => c.startsWith("GET /history")).length;
    w.ingest.onNotifications([{ emailAddress: "someone-else@tadasant.com", historyId: "9" }]);
    expect(w.gmail.calls.filter((c) => c.startsWith("GET /history")).length).toBe(before);

    w.ingest.onNotifications([{ emailAddress: ME.toUpperCase(), historyId: String(w.gmail.historyId) }]);
    await w.ingest.requestSync();
    expect((await poll(client, {}, cursor)).events.map((e) => e.eventId)).toEqual(["gmail:pushed"]);
  });

  it("renews the watch once a day, not on every read", async () => {
    const w = world({ env: PUSH });
    await w.ingest.start();
    await w.ingest.requestSync();
    await w.ingest.requestSync();
    expect(w.gmail.watches.length).toBe(1);
    w.advance(86_400_000 + 1);
    await w.ingest.requestSync();
    expect(w.gmail.watches.length).toBe(2);
  });

  it("parses Gmail's notification, and anything else as an anonymous nudge", () => {
    const data = Buffer.from(JSON.stringify({ emailAddress: ME, historyId: 1234 })).toString("base64");
    expect(parseNotification(data)).toEqual({ emailAddress: ME, historyId: "1234" });
    expect(parseNotification("not json")).toEqual({ emailAddress: null, historyId: null });
  });

  it("refuses half a Pub/Sub pair and a malformed name, and falls back to polling", () => {
    expect(() => readPush({ GMAIL_EVENTS_PUBSUB_TOPIC: TOPIC })).toThrow(/GMAIL_EVENTS_PUBSUB_SUBSCRIPTION/);
    expect(() => readPush({ GMAIL_EVENTS_PUBSUB_TOPIC: "gmail", GMAIL_EVENTS_PUBSUB_SUBSCRIPTION: SUBSCRIPTION })).toThrow(
      /not a topic name/,
    );
    const w = world({ env: { ...CONFIGURED, GMAIL_EVENTS_PUBSUB_TOPIC: TOPIC } });
    expect(w.ingest.configured).toBe(true);
    expect(w.ingest.status()).toMatchObject({ mode: "poll" });
  });

  it("sends the Access token only to a configured prefix's host and path", () => {
    expect(readWebhookAccess({})).toBeNull();
    expect(() => readWebhookAccess({ GMAIL_EVENTS_WEBHOOK_ACCESS_PREFIXES: "https://zimmer.tadasant.com/webhooks/mcp_events/" })).toThrow(
      /ZIMMER_APPROVAL_CF_ACCESS_CLIENT_ID/,
    );
    expect(
      readWebhookAccess({
        GMAIL_EVENTS_WEBHOOK_ACCESS_PREFIXES: "https://zimmer.tadasant.com/webhooks/mcp_events/",
        ZIMMER_APPROVAL_CF_ACCESS_CLIENT_ID: "id",
        ZIMMER_APPROVAL_CF_ACCESS_CLIENT_SECRET: "secret",
      })?.prefixes,
    ).toEqual([{ host: "zimmer.tadasant.com", path: "/webhooks/mcp_events/" }]);
  });
});

// --- 6. recovery ---------------------------------------------------------------------------------------------

describe("a history id Gmail no longer keeps", () => {
  it("is recovered by searching mail since just before the last complete read", async () => {
    const w = world();
    const client = await connect(w.ingest);
    const cursor = await baseline(w, client);
    w.advance(60_000);
    w.gmail.deliver({ id: "missed1", internalDate: w.now });
    w.gmail.deliver({ id: "missed2", internalDate: w.now + 1 });
    w.gmail.forgottenThrough = w.gmail.historyId;
    await w.ingest.requestSync();
    expect((await poll(client, {}, cursor)).events.map((e) => e.eventId)).toEqual(["gmail:missed1", "gmail:missed2"]);
    expect(w.ingest.status()).toMatchObject({ last_sync: { recovered: true } });
    // And reads go on from the mailbox's current history id.
    w.gmail.forgottenThrough = 0;
    w.gmail.deliver({ id: "next" });
    await w.ingest.requestSync();
    expect((await poll(client, {}, cursor)).events.map((e) => e.eventId)).toContain("gmail:next");
  });
});

// --- 7. webhooks -------------------------------------------------------------------------------------------------

class Receiver implements WebhookTransport {
  received: { headers: Record<string, string>; body: string; json: Record<string, unknown> }[] = [];
  secret = "";
  async post(_url: string, headers: Record<string, string>, body: string): Promise<WebhookResponse> {
    const json = JSON.parse(body) as Record<string, unknown>;
    this.received.push({ headers, body, json });
    if (json.type === "verification") return { status: 200, body: JSON.stringify({ challenge: json.challenge }) };
    return { status: 200, body: "" };
  }
  get deliveries() {
    return this.received.filter((r) => r.json.type !== "verification");
  }
}

function signedBy(secret: string, r: { headers: Record<string, string>; body: string }): boolean {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const want = createHmac("sha256", key)
    .update(`${r.headers["webhook-id"]}.${r.headers["webhook-timestamp"]}.${r.body}`)
    .digest("base64");
  return r.headers["webhook-signature"] === `v1,${want}`;
}

describe("webhook delivery", () => {
  it("delivers matching mail, signed, with poll's eventId, and holds while a query is undecided", async () => {
    const receiver = new Receiver();
    const w = world({ transport: receiver });
    const client = await connect(w.ingest);
    await w.ingest.start();
    await w.ingest.requestSync();
    const secret = `whsec_${randomBytes(32).toString("base64")}`;
    const args = { query: "in:inbox" };
    const sub = (await client.request(
      {
        method: "events/subscribe",
        params: {
          name: "message_received",
          arguments: args,
          delivery: { mode: "webhook", url: "https://zimmer.tadasant.com/webhooks/mcp_events/abc", secret },
          cursor: null,
          _meta: { "strad/principal": "token:zimmer", "strad/name": "gmail-zimmer-ro__message_received" },
        },
      } as never,
      ResultSchema.passthrough(),
    )) as { id: string; cursor: string };
    expect(sub.id).toMatch(/^sub_[0-9a-f]{32}$/);

    w.gmail.deliver({ id: "w1" });
    const lagging = w.gmail.deliver({ id: "w2", indexed: false });
    w.gmail.deliver({ id: "w3", labelIds: ["UNREAD"] }); // not in:inbox
    await w.ingest.requestSync();
    await w.ingest.webhookTick();
    await w.ingest.webhooksSettled();
    expect(receiver.deliveries.map((d) => d.json.eventId)).toEqual(["gmail:w1"]);

    lagging.indexed = true;
    await w.ingest.evaluatePending();
    await w.ingest.webhookTick();
    await w.ingest.webhooksSettled();
    expect(receiver.deliveries.map((d) => d.json.eventId)).toEqual(["gmail:w1", "gmail:w2"]);
    const first = receiver.deliveries[0]!;
    expect(first.json.name).toBe("gmail-zimmer-ro__message_received");
    expect(signedBy(secret, first)).toBe(true);
    expect(first.headers["x-mcp-subscription-id"]).toBe(sub.id);

    // Poll and webhook agree on the id a receiver dedupes on.
    const polled = await poll(client, args, sub.cursor);
    expect(polled.events.map((e) => e.eventId)).toEqual(["gmail:w1", "gmail:w2"]);
  });

  it("decides a subscription's query even when more than 20 other queries are in use", async () => {
    const receiver = new Receiver();
    const w = world({ transport: receiver });
    const client = await connect(w.ingest);
    await w.ingest.start();
    await w.ingest.requestSync();
    await client.request(
      {
        method: "events/subscribe",
        params: {
          name: "message_received",
          arguments: { query: "subject:rare" },
          delivery: { mode: "webhook", url: "https://zimmer.tadasant.com/webhooks/mcp_events/rare", secret: `whsec_${randomBytes(32).toString("base64")}` },
          cursor: null,
          _meta: { "strad/principal": "token:zimmer" },
        },
      } as never,
      ResultSchema.passthrough(),
    );
    // 25 queries polled since, each more recent than the subscription's: past the cap of 20.
    w.advance(1_000);
    for (let i = 0; i < 25; i++) await poll(client, { query: `subject:newer${i}` }, null);
    w.gmail.deliver({ id: "rare1", subject: "a rare one" });
    await w.ingest.requestSync();
    await w.ingest.webhookTick();
    await w.ingest.webhooksSettled();
    expect(receiver.deliveries.map((d) => d.json.eventId)).toEqual(["gmail:rare1"]);
  });

  it("refuses a subscribe that did not come through strad", async () => {
    const w = world();
    const client = await connect(w.ingest);
    await expect(
      client.request(
        {
          method: "events/subscribe",
          params: {
            name: "message_received",
            arguments: {},
            delivery: { mode: "webhook", url: "https://zimmer.tadasant.com/x", secret: "whsec_x" },
            cursor: null,
          },
        } as never,
        ResultSchema.passthrough(),
      ),
    ).rejects.toThrow(/authenticated principal/);
  });
});

// --- 8. restart ----------------------------------------------------------------------------------------------------

describe("a restart", () => {
  it("keeps the buffer, the history id and the cursor, and reads on from where it stopped", async () => {
    const gmail = new FakeGmail();
    const blobs = new MemoryBlobStore();
    const one = world({ gmail, blobs });
    const c1 = await connect(one.ingest);
    const cursor = await baseline(one, c1);
    gmail.deliver({ id: "r1" });
    await one.ingest.requestSync();
    await one.ingest.close();

    gmail.deliver({ id: "r2" }); // arrives while nothing is running
    const two = world({ gmail, blobs });
    const c2 = await connect(two.ingest);
    await two.ingest.start();
    await two.ingest.requestSync();
    expect((await poll(c2, {}, cursor)).events.map((e) => e.eventId)).toEqual(["gmail:r1", "gmail:r2"]);
  });
});
