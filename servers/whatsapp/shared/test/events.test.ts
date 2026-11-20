import { test } from "vitest";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { MemoryBlobStore, open } from "../src/index.js";
import type { RawMessage } from "../src/normalize.js";
import type { WebhookResponse, WebhookTransport } from "../src/events/webhook/transport.js";
import { ADA_PN, fakeWhatsApp, GRACE_LID, GRACE_PN, GROUP, groupText, SELF_LID, waitFor } from "./fake-socket.js";
import { call, clock, config, connect, NOW, pairAndConnect } from "./harness.js";

/**
 * The `message_received` event through a REAL MCP client: `events/list`,
 * `events/poll` and `events/subscribe`, against the fake socket and an
 * in-memory GCS. Every identifier and every word of text here is invented.
 *
 * The claims under test:
 *   1. Off unless the slug sets WHATSAPP_EVENTS_ENABLED: no extension, no handlers.
 *   2. A live message is an event with `whatsapp:<chat>:<id>` and the payload;
 *      a history sync, a reaction and the bridge's own send never are.
 *   3. The filters: from_me excluded by default, include_groups, chat_ids.
 *   4. Arguments are refused by name when unknown or malformed.
 *   5. The buffer is sealed in the bridge's folder and survives a restart.
 *   6. Webhook delivery, signed, with poll's eventId.
 *   7. Logout wipes the event buffer with the chats.
 */

const ON = { WHATSAPP_EVENTS_ENABLED: "true" };

type PollAnswer = {
  events: { eventId: string; name: string; timestamp: string; data: Record<string, any> }[];
  cursor: string;
  hasMore: boolean;
  truncated: boolean;
};

async function poll(
  mcp: Client,
  args: Record<string, unknown> = {},
  cursor: string | null = null,
): Promise<PollAnswer> {
  return (await mcp.request(
    { method: "events/poll", params: { name: "message_received", arguments: args, cursor } } as never,
    ResultSchema.passthrough(),
  )) as unknown as PollAnswer;
}

/** Waits until a poll from `cursor` with `args` returns at least `n` events. */
async function pollUntil(mcp: Client, n: number, args: Record<string, unknown>, cursor: string) {
  let last: PollAnswer | undefined;
  await waitFor(async () => {
    last = await poll(mcp, args, cursor);
    return last.events.length >= n;
  });
  return last!;
}

function upsert(mcp: { fake: ReturnType<typeof fakeWhatsApp> }, ...messages: RawMessage[]) {
  mcp.fake.latest().emit("messages.upsert", { type: "notify", messages });
}

function direct(id: string, text: string, extra: Partial<RawMessage> = {}): RawMessage {
  return {
    key: { remoteJid: ADA_PN, fromMe: false, id },
    message: { conversation: text },
    messageTimestamp: NOW,
    pushName: "Ada",
    ...extra,
  };
}

async function eventsWorld(opts: { blobs?: MemoryBlobStore; key?: Buffer; transport?: WebhookTransport } = {}) {
  const fake = fakeWhatsApp(clock);
  const w = await connect({
    fake,
    blobs: opts.blobs,
    cfg: config(opts.key),
    eventsEnv: ON,
    webhookTransport: opts.transport,
  });
  await pairAndConnect(w.mcp, fake);
  return w;
}

// --- 1. off by default ----------------------------------------------------------------------

test("without WHATSAPP_EVENTS_ENABLED: no extension and no events handlers", async () => {
  const { mcp } = await connect({ eventsEnv: {} });
  const caps = mcp.getServerCapabilities() as Record<string, any>;
  assert.equal(caps.extensions?.["io.modelcontextprotocol/events"], undefined);
  await assert.rejects(
    mcp.request({ method: "events/list", params: {} } as never, ResultSchema.passthrough()),
    /Method not found/,
  );
});

test("only the literal true switches it on", async () => {
  const { mcp } = await connect({ eventsEnv: { WHATSAPP_EVENTS_ENABLED: "1" } });
  const caps = mcp.getServerCapabilities() as Record<string, any>;
  assert.equal(caps.extensions?.["io.modelcontextprotocol/events"], undefined);
});

test("a malformed retention is named on a poll, and the extension is not advertised", async () => {
  const { mcp } = await connect({
    eventsEnv: { ...ON, WHATSAPP_EVENTS_RETENTION_DAYS: "forever" },
  });
  const caps = mcp.getServerCapabilities() as Record<string, any>;
  assert.equal(caps.extensions?.["io.modelcontextprotocol/events"], undefined);
  await assert.rejects(poll(mcp), /WHATSAPP_EVENTS_RETENTION_DAYS="forever"/);
});

test("switched on: the extension is advertised and events/list describes message_received", async () => {
  const { mcp } = await connect({ eventsEnv: ON });
  const caps = mcp.getServerCapabilities() as Record<string, any>;
  assert.deepEqual(caps.extensions?.["io.modelcontextprotocol/events"], {});
  const listed = (await mcp.request(
    { method: "events/list", params: {} } as never,
    ResultSchema.passthrough(),
  )) as unknown as { events: { name: string; delivery: string[]; inputSchema: any }[] };
  assert.equal(listed.events.length, 1);
  const d = listed.events[0]!;
  assert.equal(d.name, "message_received");
  assert.deepEqual(d.delivery, ["poll", "webhook"]);
  assert.deepEqual(Object.keys(d.inputSchema.properties).sort(), [
    "chat_ids",
    "include_from_me",
    "include_groups",
  ]);
  // The seven tools are unchanged.
  assert.equal((await mcp.listTools()).tools.length, 7);
});

// --- 2. what is an event ----------------------------------------------------------------------

test("a live message is an event with whatsapp:<chat>:<id> and the payload", async () => {
  const w = await eventsWorld();
  const { cursor } = await poll(w.mcp);
  const long = "x".repeat(2_100);
  upsert(
    w,
    groupText("G1", NOW, "hello @bridge", { contextInfo: { mentionedJid: [SELF_LID] } }),
    direct("D1", long),
  );
  const got = await pollUntil(w.mcp, 2, {}, cursor);
  assert.deepEqual(
    got.events.map((e) => e.eventId),
    [`whatsapp:${GROUP}:G1`, `whatsapp:${ADA_PN}:D1`],
  );
  const g = got.events[0]!;
  assert.equal(g.name, "message_received");
  assert.equal(g.timestamp, new Date(NOW * 1000).toISOString());
  assert.deepEqual(g.data, {
    message_id: "G1",
    chat_id: GROUP,
    chat_name: "Wedding planning",
    is_group: true,
    sender_jid: g.data.sender_jid,
    sender_name: "Grace",
    push_name: "Grace",
    from_me: false,
    timestamp: new Date(NOW * 1000).toISOString(),
    type: "text",
    media_type: null,
    text: "hello @bridge",
    text_truncated: false,
    quoted_message_id: null,
    mentions_self: true,
    reply_to_self: false,
  });
  const d = got.events[1]!.data;
  assert.equal(d.is_group, false);
  assert.equal(d.text.length, 2_000);
  assert.equal(d.text_truncated, true);
  assert.equal(d.push_name, "Ada");
});

test("a reply to the account and a media message carry reply_to_self and media_type", async () => {
  const w = await eventsWorld();
  const { cursor: start } = await poll(w.mcp);
  upsert(w, direct("D0", "hi"));
  await pollUntil(w.mcp, 1, {}, start);
  const sent = await call(w.mcp, "whatsapp_send_message", { chat_id: ADA_PN, text: "are you coming?" });
  assert.equal(sent.isError, false, sent.text);
  const { cursor } = await poll(w.mcp);
  upsert(
    w,
    direct("R1", "", {
      message: {
        extendedTextMessage: { text: "yes", contextInfo: { stanzaId: sent.json.id, participant: ADA_PN } },
      },
    }),
    direct("I1", "", {
      message: {
        imageMessage: {
          caption: "the venue",
          mimetype: "image/jpeg",
          mediaKey: Buffer.from("k".repeat(32)).toString("base64"),
          directPath: "/v/t62/fake-path",
        },
      },
    }),
  );
  const got = await pollUntil(w.mcp, 2, {}, cursor);
  assert.equal(got.events[0]!.data.reply_to_self, true);
  assert.equal(got.events[0]!.data.quoted_message_id, sent.json.id);
  assert.equal(got.events[1]!.data.type, "image");
  assert.equal(got.events[1]!.data.media_type, "image");
  assert.equal(got.events[1]!.data.text, "the venue");
  // The payload is the schema's sixteen fields and nothing else: no media key, no CDN path.
  assert.deepEqual(Object.keys(got.events[1]!.data).sort(), [
    "chat_id", "chat_name", "from_me", "is_group", "media_type", "mentions_self", "message_id",
    "push_name", "quoted_message_id", "reply_to_self", "sender_jid", "sender_name", "text",
    "text_truncated", "timestamp", "type",
  ]);
});

test("never events: a history sync, a reaction, the bridge's own send; a redelivery is one event", async () => {
  const w = await eventsWorld();
  const { cursor } = await poll(w.mcp, { include_from_me: true });
  w.fake.latest().emit("messaging-history.set", {
    messages: [direct("H1", "from last week")],
    chats: [],
    contacts: [],
  });
  upsert(w, {
    key: { remoteJid: ADA_PN, fromMe: false, id: "X1" },
    message: { reactionMessage: { key: { id: "H1" }, text: "+1" } },
    messageTimestamp: NOW,
  });
  const sent = await call(w.mcp, "whatsapp_send_message", { chat_id: ADA_PN, text: "on my way" });
  assert.equal(sent.isError, false, sent.text);
  upsert(w, direct("N1", "new"));
  upsert(w, direct("N1", "new")); // WhatsApp redelivers on a reconnect
  const got = await pollUntil(w.mcp, 1, { include_from_me: true }, cursor);
  // The history message is buffered for the tools all the same.
  const read = await call(w.mcp, "whatsapp_get_messages", { chat_id: ADA_PN });
  assert.ok(read.json.messages.some((m: { id: string }) => m.id === "H1"));
  const again = await poll(w.mcp, { include_from_me: true }, cursor);
  assert.deepEqual(
    again.events.map((e) => e.eventId),
    [`whatsapp:${ADA_PN}:N1`],
  );
  assert.equal(got.events.length, 1);
});

// --- 3. filters -------------------------------------------------------------------------------

test("filters: from_me excluded by default, include_groups false is direct only, chat_ids", async () => {
  const w = await eventsWorld();
  const { cursor } = await poll(w.mcp);
  upsert(
    w,
    groupText("G1", NOW, "in the group"),
    direct("D1", "to me"),
    { key: { remoteJid: ADA_PN, fromMe: true, id: "ME1" }, message: { conversation: "from my phone" }, messageTimestamp: NOW },
  );
  const all = await pollUntil(w.mcp, 3, { include_from_me: true }, cursor);
  assert.deepEqual(all.events.map((e) => e.data.message_id), ["G1", "D1", "ME1"]);
  assert.equal(all.events[2]!.data.from_me, true);

  const ids = async (args: Record<string, unknown>) =>
    (await poll(w.mcp, args, cursor)).events.map((e) => e.data.message_id);
  assert.deepEqual(await ids({}), ["G1", "D1"]);
  assert.deepEqual(await ids({ include_groups: false }), ["D1"]);
  assert.deepEqual(await ids({ chat_ids: [GROUP] }), ["G1"]);
  // A device suffix and the legacy @c.us form name the same chat.
  assert.deepEqual(await ids({ chat_ids: [ADA_PN.replace("@s.whatsapp.net", ":3@c.us")] }), ["D1"]);
  assert.deepEqual(await ids({ chat_ids: [GROUP], include_groups: false }), []);
});

test("chat_ids matches a direct chat under either of its addresses", async () => {
  const w = await eventsWorld();
  const { cursor } = await poll(w.mcp);
  // WhatsApp addresses the chat by LID and gives its phone JID beside it: the
  // bridge names the chat by the phone JID, and the LID is its other address.
  upsert(w, {
    key: { remoteJid: GRACE_LID, remoteJidAlt: GRACE_PN, fromMe: false, id: "A1" },
    message: { conversation: "via lid" },
    messageTimestamp: NOW,
    pushName: "Grace",
  });
  const got = await pollUntil(w.mcp, 1, {}, cursor);
  assert.equal(got.events[0]!.data.chat_id, GRACE_PN);
  assert.equal("chat_alt" in got.events[0]!.data, false, "the other address is not delivered");
  const count = async (ids: string[]) => (await poll(w.mcp, { chat_ids: ids }, cursor)).events.length;
  assert.equal(await count([GRACE_PN]), 1);
  assert.equal(await count([GRACE_LID]), 1);
  assert.equal(await count([ADA_PN]), 0);
});

// --- 4. refusals ------------------------------------------------------------------------------

test("unknown or malformed arguments are refused by name, with -32602", async () => {
  const { mcp } = await connect({ eventsEnv: ON });
  const refused = async (args: Record<string, unknown>, pattern: RegExp) => {
    const err = (await poll(mcp, args).then(
      () => assert.fail("accepted"),
      (e: unknown) => e,
    )) as { code: number; message: string };
    assert.equal(err.code, -32602);
    assert.match(err.message, pattern);
  };
  await refused({ from_me: true }, /unknown argument "from_me"/);
  await refused({ chat_ids: ["not a jid"] }, /chat_ids entry/);
  await refused({ chat_ids: [] }, /non-empty/);
  await refused({ include_groups: "no" }, /include_groups must be a boolean/);
  const err = (await mcp
    .request({ method: "events/poll", params: { name: "message_posted", arguments: {}, cursor: null } } as never, ResultSchema.passthrough())
    .then(() => assert.fail("accepted"), (e: unknown) => e)) as { code: number };
  assert.equal(err.code, -32023);
});

// --- 5. persistence ---------------------------------------------------------------------------

test("the buffer is sealed beside the chats and a restart resumes from the cursor", async () => {
  const blobs = new MemoryBlobStore();
  const key = randomBytes(32);
  const w = await eventsWorld({ blobs, key });
  const { cursor } = await poll(w.mcp);
  upsert(w, direct("P1", "a secret plan"));
  await pollUntil(w.mcp, 1, {}, cursor);
  await w.created.events()!.flushNow();
  const object = await blobs.read("whatsapp/events/buffer.bin");
  assert.ok(object, "the buffer is in the bridge's folder");
  assert.equal(object.data.subarray(0, 4).toString(), "WAS1");
  assert.ok(!object.data.includes(Buffer.from("a secret plan")), "sealed, not plaintext");
  await w.close();

  const fake = fakeWhatsApp(clock);
  fake.autoOpen = true;
  const again = await connect({ fake, blobs, cfg: config(key), eventsEnv: ON });
  await again.created.events()!.start();
  const got = await poll(again.mcp, {}, cursor);
  assert.deepEqual(got.events.map((e) => e.eventId), [`whatsapp:${ADA_PN}:P1`]);
  assert.equal(got.truncated, false);
});

test("close() writes the last events, with no flush by hand", async () => {
  const blobs = new MemoryBlobStore();
  const key = randomBytes(32);
  const w = await eventsWorld({ blobs, key });
  const { cursor } = await poll(w.mcp);
  upsert(w, direct("C1", "just before the deploy"));
  await pollUntil(w.mcp, 1, {}, cursor);
  await w.close();
  const name = "whatsapp/events/buffer.bin";
  const object = await blobs.read(name);
  assert.ok(object, "flushed on close");
  const doc = JSON.parse(open(key, name, object.data).toString("utf8"));
  assert.deepEqual(doc.events.map((e: { eventId: string }) => e.eventId), [`whatsapp:${ADA_PN}:C1`]);
});

// --- 6. webhooks ------------------------------------------------------------------------------

class Receiver implements WebhookTransport {
  received: { headers: Record<string, string>; body: string; json: Record<string, any> }[] = [];
  async post(_url: string, headers: Record<string, string>, body: string): Promise<WebhookResponse> {
    const json = JSON.parse(body) as Record<string, any>;
    this.received.push({ headers, body, json });
    if (json.type === "verification") return { status: 200, body: JSON.stringify({ challenge: json.challenge }) };
    return { status: 200, body: "" };
  }
  get deliveries() {
    return this.received.filter((r) => r.json.type !== "verification");
  }
}

test("webhook delivery: signed, filtered, with poll's eventId", async () => {
  const receiver = new Receiver();
  const w = await eventsWorld({ transport: receiver });
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  const args = { include_groups: false };
  const sub = (await w.mcp.request(
    {
      method: "events/subscribe",
      params: {
        name: "message_received",
        arguments: args,
        delivery: { mode: "webhook", url: "https://zimmer.example.com/webhooks/mcp_events/abc", secret },
        cursor: null,
        _meta: { "strad/principal": "token:zimmer", "strad/name": "whatsapp-test__message_received" },
      },
    } as never,
    ResultSchema.passthrough(),
  )) as unknown as { id: string; cursor: string };
  assert.match(sub.id, /^sub_[0-9a-f]{32}$/);

  upsert(w, groupText("G1", NOW, "group chatter"), direct("D1", "just you"));
  await pollUntil(w.mcp, 1, args, sub.cursor);
  const events = w.created.events()!;
  await events.webhookTick();
  await events.webhooksSettled();
  assert.deepEqual(
    receiver.deliveries.map((d) => d.json.eventId),
    [`whatsapp:${ADA_PN}:D1`],
  );
  const first = receiver.deliveries[0]!;
  assert.equal(first.json.name, "whatsapp-test__message_received");
  assert.equal(first.headers["x-mcp-subscription-id"], sub.id);
  const want = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
    .update(`${first.headers["webhook-id"]}.${first.headers["webhook-timestamp"]}.${first.body}`)
    .digest("base64");
  assert.equal(first.headers["webhook-signature"], `v1,${want}`);
});

test("a subscribe that did not come through strad is refused", async () => {
  const { mcp } = await connect({ eventsEnv: ON });
  const err = (await mcp
    .request(
      {
        method: "events/subscribe",
        params: {
          name: "message_received",
          arguments: {},
          delivery: { mode: "webhook", url: "https://zimmer.example.com/x", secret: `whsec_${randomBytes(32).toString("base64")}` },
          cursor: null,
        },
      } as never,
      ResultSchema.passthrough(),
    )
    .then(() => assert.fail("accepted"), (e: unknown) => e)) as { code: number };
  assert.equal(err.code, -32024);
});

// --- 7. logout --------------------------------------------------------------------------------

test("logout wipes the event buffer with the chats; an old cursor reads as truncated", async () => {
  const blobs = new MemoryBlobStore();
  const key = randomBytes(32);
  const w = await eventsWorld({ blobs, key });
  const { cursor } = await poll(w.mcp);
  upsert(w, direct("L1", "before logout"));
  await pollUntil(w.mcp, 1, {}, cursor);
  await w.created.events()!.flushNow();
  const out = await call(w.mcp, "whatsapp_logout");
  assert.equal(out.isError, false, out.text);
  const after = await poll(w.mcp, {}, cursor);
  assert.deepEqual(after.events, []);
  assert.equal(after.truncated, true);
  const name = "whatsapp/events/buffer.bin";
  const object = await blobs.read(name);
  assert.ok(object, "the emptied buffer is written");
  const doc = JSON.parse(open(key, name, object.data).toString("utf8"));
  assert.deepEqual(doc.events, []);
  assert.ok(doc.evicted_through >= Number(cursor.slice("v1.".length)));
});

