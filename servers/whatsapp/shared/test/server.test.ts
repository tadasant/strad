import { test } from "vitest";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { GcsHttpError, MemoryBlobStore, TransientStoreError } from "../src/index.js";
import {
  ADA_PN,
  fakeWhatsApp,
  GRACE_LID,
  GRACE_PN,
  GROUP,
  groupText,
  SELF_LID,
  SELF_PN,
  waitFor,
} from "./fake-socket.js";
import { PAIRING_BROWSER } from "../src/socket.js";

/**
 * The server through a REAL MCP client over an in-memory transport — the path
 * Zimmer's poller takes — against a fake socket and an in-memory GCS.
 *
 * The claims under test:
 *   1. Pairing by code, with no shell: whatsapp_pair → code → the phone accepts
 *      → restart (515) → connected and paired, and the login is persisted
 *      SEALED.
 *   2. A restart restores the login and the buffer from the store alone.
 *   3. The get_messages contract: oldest first, `after` inclusive with the
 *      OLDEST `limit` and `has_more`, the newest `limit` without it, the
 *      `_self` flags against both the phone JID and the LID.
 *   4. A sent message is marked sent_by_bridge, however its echo arrives.
 *   5. Human pacing refuses a burst rather than queuing it.
 *   6. Two processes on one account: the newer one wins, the older one stops.
 *   7. Logout and remote logout; an unreadable state; no configuration.
 */

import {
  call,
  clock,
  config,
  connect,
  NOW,
  open,
  pairAndConnect,
} from "./harness.js";

test("tools/list: the seven contract tools, with honest annotations", async () => {
  const { mcp } = await connect();
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "whatsapp_get_attachment",
    "whatsapp_get_messages",
    "whatsapp_list_chats",
    "whatsapp_logout",
    "whatsapp_pair",
    "whatsapp_send_message",
    "whatsapp_status",
  ]);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const read of [
    "whatsapp_status",
    "whatsapp_list_chats",
    "whatsapp_get_messages",
    "whatsapp_get_attachment",
  ]) {
    assert.equal(byName[read]!.annotations?.readOnlyHint, true, read);
  }
  assert.equal(byName.whatsapp_logout!.annotations?.destructiveHint, true);
  // Every description says what this is: unofficial, against the ToS, ban risk.
  for (const tool of tools) {
    assert.match(tool.description!, /UNOFFICIAL/);
    assert.match(tool.description!, /Terms of Service/);
    assert.ok(tool.description!.length < 2048, `${tool.name} description too long`);
  }
  assert.match(byName.whatsapp_send_message!.description!, /AS THE PAIRED WHATSAPP ACCOUNT/);
});

test("pairs by code with no shell, and persists the login sealed", async () => {
  const { mcp, fake, blobs } = await connect();

  const before = await call(mcp, "whatsapp_status");
  assert.deepEqual(before.json, {
    connected: false,
    paired: false,
    self_jid: null,
    self_name: null,
    last_event_at: null,
    pairing_in_progress: false,
    last_disconnect_reason: null,
  });
  // structuredContent and the text are the same JSON.
  assert.deepEqual(before.structured, before.json);

  const pairing = call(mcp, "whatsapp_pair", { phone_number: "+1 (555) 000-0001" });
  await waitFor(() => fake.sockets.length === 1);
  // A real OS and browser: the phone refuses a code whose OS it does not know.
  assert.deepEqual([...fake.latest().options.browser], [...PAIRING_BROWSER]);
  fake.latest().offerPairing();
  const result = await pairing;
  assert.equal(result.isError, false, result.text);
  assert.equal(result.json.pairing_code, "ABCD-2EFG");
  assert.equal(fake.latest().pairingRequests[0], "15550000001");
  assert.ok(result.json.expires_in_seconds > 0);
  assert.match(result.json.instructions, /Link with phone number instead/);
  assert.match(result.json.instructions, /Linked devices/);

  const waiting = await call(mcp, "whatsapp_status");
  assert.equal(waiting.json.pairing_in_progress, true);
  assert.equal(waiting.json.paired, false);
  // Nothing is persisted for a login WhatsApp has not accepted.
  assert.equal(blobs.objects.has("whatsapp/auth.bin"), false);

  const first = fake.latest();
  first.acceptPairing();
  first.close(515);
  await waitFor(() => fake.sockets.length === 2);
  fake.latest().open();
  await waitFor(async () => (await call(mcp, "whatsapp_status")).json.connected);

  const status = await call(mcp, "whatsapp_status");
  assert.equal(status.json.paired, true);
  assert.equal(status.json.self_jid, SELF_PN);
  assert.equal(status.json.self_name, "Bridge");
  assert.equal(status.json.pairing_in_progress, false);
  assert.equal(typeof status.json.last_event_at, "number");

  await waitFor(() => blobs.objects.has("whatsapp/auth.bin"));
  const sealed = blobs.objects.get("whatsapp/auth.bin")!.data;
  assert.equal(sealed.subarray(0, 4).toString(), "WAS1");
  assert.equal(sealed.includes(Buffer.from("signedIdentityKey")), false);
  assert.equal(sealed.includes(Buffer.from("15550000001")), false);

  const again = await call(mcp, "whatsapp_pair", { phone_number: "15550000001" });
  assert.equal(again.isError, true);
  assert.match(again.text, /Already paired/);
});

test("a pairing attempt that lapses leaves nothing behind", async () => {
  const { mcp, fake } = await connect();
  const pairing = call(mcp, "whatsapp_pair", { phone_number: "15550000001" });
  await waitFor(() => fake.sockets.length === 1);
  fake.latest().offerPairing();
  await pairing;
  fake.latest().close(408); // the pairing refs ran out
  const status = await call(mcp, "whatsapp_status");
  assert.equal(status.json.pairing_in_progress, false);
  assert.equal(status.json.paired, false);
  assert.equal(status.json.last_disconnect_reason, "pairing_code_expired");
  // No reconnect loop for an unpaired device.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fake.sockets.length, 1);
});

test("pairs by QR: a PNG drawn here, the current ref on every call, no restart", async () => {
  let now = NOW * 1000;
  const { mcp, fake } = await connect({ clock: () => now });

  const first = call(mcp, "whatsapp_pair", { method: "qr" });
  await waitFor(() => fake.sockets.length === 1);
  assert.deepEqual([...fake.latest().options.browser], [...PAIRING_BROWSER]);
  fake.latest().offerPairing("REF1,noise,identity,adv,1");
  const a = await first;
  assert.equal(a.isError, false, a.text);
  assert.equal(a.json.method, "qr");
  assert.equal(a.json.qr, "REF1,noise,identity,adv,1");
  assert.equal(a.json.expires_in_seconds, 60);
  assert.match(a.json.instructions, /point the camera/);
  assert.deepEqual(a.structured, a.json);
  // The PNG rides as an MCP image block, never inside the JSON.
  assert.equal(a.images.length, 1);
  assert.equal(a.images[0]!.mimeType, "image/png");
  const png = Buffer.from(a.images[0]!.data, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal("png" in a.json, false);

  // WhatsApp rotates the ref; the next call answers with it, on the SAME socket.
  now += 30_000;
  const half = await call(mcp, "whatsapp_pair", { method: "qr" });
  assert.equal(half.json.qr, "REF1,noise,identity,adv,1");
  assert.equal(half.json.expires_in_seconds, 30);
  fake.latest().offerPairing("REF2,noise,identity,adv,1");
  const b = await call(mcp, "whatsapp_pair", { method: "qr" });
  assert.equal(b.json.qr, "REF2,noise,identity,adv,1");
  assert.notEqual(b.images[0]!.data, a.images[0]!.data);
  assert.equal(fake.sockets.length, 1, "a QR call does not start over while one is live");
  assert.equal((await call(mcp, "whatsapp_status")).json.pairing_in_progress, true);

  // Past the code TTL, the attempt is alive for as long as WhatsApp offers refs.
  now += 150_000;
  fake.latest().offerPairing("REF3,noise,identity,adv,1");
  assert.equal((await call(mcp, "whatsapp_status")).json.pairing_in_progress, true);
  assert.equal((await call(mcp, "whatsapp_pair", { method: "qr" })).json.qr, "REF3,noise,identity,adv,1");

  // Scanned: the same pair-success → 515 → open path as a code.
  fake.latest().acceptPairing();
  fake.latest().close(515);
  await waitFor(() => fake.sockets.length === 2);
  fake.latest().open();
  await waitFor(async () => (await call(mcp, "whatsapp_status")).json.paired === true);
});

test("a code call replaces a live QR attempt; method is validated", async () => {
  const { mcp, fake } = await connect();
  const qr = call(mcp, "whatsapp_pair", { method: "qr" });
  await waitFor(() => fake.sockets.length === 1);
  fake.latest().offerPairing();
  await qr;
  const code = call(mcp, "whatsapp_pair", { phone_number: "15550000001" });
  await waitFor(() => fake.sockets.length === 2);
  assert.equal(fake.sockets[0]!.ended, true, "the QR socket is gone");
  fake.latest().offerPairing();
  assert.equal((await code).isError, false);

  const bad = await call(mcp, "whatsapp_pair", { method: "smoke-signal" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /"code" or "qr"/);
  const qrWithNumber = await call(mcp, "whatsapp_pair", { method: "qr", phone_number: "15550000001" });
  assert.equal(qrWithNumber.isError, true);
  assert.match(qrWithNumber.text, /is for method "code"/);
  const noNumber = await call(mcp, "whatsapp_pair", {});
  assert.equal(noNumber.isError, true);
  assert.match(noNumber.text, /phone_number/);
});

test("pairing logs every step and close reason, and never a code, QR or number", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    const { mcp, fake } = await connect();
    const pairing = call(mcp, "whatsapp_pair", { phone_number: "15550000001" });
    await waitFor(() => fake.sockets.length === 1);
    fake.latest().offerPairing("SECRETREF,noise,identity,adv,1");
    const result = await pairing;
    fake.latest().phoneEnteredCode();
    fake.latest().emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { message: "QR refs attempts ended", output: { statusCode: 408 } } },
    });
    await waitFor(() => lines.some((l) => /ended unpaired/.test(l)));

    const log = lines.join("\n");
    assert.match(log, /pairing \(code\): started as Chrome on Mac OS/);
    assert.match(log, /WhatsApp offered a pairing session/);
    assert.match(log, /code issued/);
    assert.match(log, /the phone accepted the code/);
    assert.match(log, /connection: closed 408 \(timed_out\), during a code pairing: QR refs attempts ended/);
    assert.match(log, /ended unpaired \(pairing_code_expired\); the phone accepted the code but WhatsApp never confirmed/);
    const code = String(result.json.pairing_code);
    for (const secret of [code, code.replace("-", ""), "SECRETREF", "15550000001"]) {
      assert.equal(log.includes(secret), false, `logged ${secret}`);
    }
  } finally {
    console.error = original;
  }
});

test("refuses a malformed phone number before touching WhatsApp", async () => {
  const { mcp, fake } = await connect();
  const res = await call(mcp, "whatsapp_pair", { phone_number: "call me maybe" });
  assert.equal(res.isError, true);
  assert.match(res.text, /E\.164/);
  assert.equal(fake.sockets.length, 0);
});

test("get_messages: the contract's ordering, cursor and _self flags", async () => {
  const { mcp, fake } = await connect();
  await pairAndConnect(mcp, fake);
  const socket = fake.latest();

  socket.emit("messages.upsert", {
    type: "notify",
    messages: [
      groupText("M3", NOW - 30, "third"),
      groupText("M1", NOW - 50, "first"),
      groupText("M2", NOW - 40, "@bridge can you check?", {
        contextInfo: { mentionedJid: [SELF_LID] },
      }),
      {
        key: { remoteJid: GROUP, fromMe: true, id: "M4" },
        message: { conversation: "sent from the phone" },
        messageTimestamp: NOW - 20,
      },
      groupText("M5", NOW - 10, "replying to you", {
        participant: ADA_PN,
        participantAlt: undefined,
        pushName: "Ada",
        contextInfo: { stanzaId: "M4", participant: SELF_LID },
      }),
      // Excluded by the contract: a protocol-only message and a system stub.
      {
        key: { remoteJid: GROUP, fromMe: false, id: "P1", participant: GRACE_LID },
        message: { senderKeyDistributionMessage: { groupId: GROUP } },
        messageTimestamp: NOW - 5,
      },
      {
        key: { remoteJid: GROUP, fromMe: false, id: "S1", participant: GRACE_LID },
        messageStubType: 27,
        messageTimestamp: NOW - 4,
      },
      // A photo with a caption, wrapped the way disappearing messages are.
      {
        key: { remoteJid: GROUP, fromMe: false, id: "M6", participant: GRACE_LID, participantAlt: GRACE_PN },
        message: { ephemeralMessage: { message: { imageMessage: { caption: "the venue" } } } },
        messageTimestamp: NOW - 3,
      },
    ],
  });

  const newest = await call(mcp, "whatsapp_get_messages", { chat_id: GROUP, limit: 3 });
  assert.equal(newest.isError, false, newest.text);
  assert.deepEqual(newest.json.messages.map((m: any) => m.id), ["M4", "M5", "M6"]);
  assert.equal(newest.json.has_more, true);
  assert.equal(newest.json.chat_name, "Wedding planning");
  assert.equal(newest.json.self_jid, SELF_PN);

  const all = await call(mcp, "whatsapp_get_messages", { chat_id: GROUP });
  const byId = Object.fromEntries(all.json.messages.map((m: any) => [m.id, m]));
  assert.deepEqual(Object.keys(byId), ["M1", "M2", "M3", "M4", "M5", "M6"]);
  assert.deepEqual(byId.M1, {
    id: "M1",
    chat_id: GROUP,
    timestamp: NOW - 50,
    sender_jid: GRACE_PN,
    sender_name: "Grace",
    from_me: false,
    sent_by_bridge: false,
    text: "first",
    type: "text",
    quoted_message_id: null,
    mentions_self: false,
    reply_to_self: false,
  });
  assert.equal(byId.M2.mentions_self, true, "a mention of the LID is a mention of self");
  assert.equal(byId.M4.from_me, true);
  assert.equal(byId.M4.sent_by_bridge, false, "sent from the phone, not the bridge");
  assert.equal(byId.M4.sender_jid, SELF_PN);
  assert.equal(byId.M5.reply_to_self, true);
  assert.equal(byId.M5.quoted_message_id, "M4");
  assert.equal(byId.M5.sender_name, "Ada");
  assert.equal(byId.M6.type, "image");
  assert.equal(byId.M6.text, "the venue");

  // after is INCLUSIVE, and the OLDEST `limit` come back with has_more.
  const page1 = await call(mcp, "whatsapp_get_messages", {
    chat_id: GROUP,
    after: NOW - 40,
    limit: 2,
  });
  assert.deepEqual(page1.json.messages.map((m: any) => m.id), ["M2", "M3"]);
  assert.equal(page1.json.has_more, true);
  const page2 = await call(mcp, "whatsapp_get_messages", {
    chat_id: GROUP,
    after: page1.json.messages[1].timestamp,
    limit: 200,
  });
  assert.deepEqual(page2.json.messages.map((m: any) => m.id), ["M3", "M4", "M5", "M6"]);
  assert.equal(page2.json.has_more, false);

  const ms = await call(mcp, "whatsapp_get_messages", { chat_id: GROUP, after: NOW * 1000 });
  assert.equal(ms.isError, true);
  assert.match(ms.text, /SECONDS/);

  const unknown = await call(mcp, "whatsapp_get_messages", { chat_id: "999@g.us" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /whatsapp_list_chats/);
});

test("edits and deletions change the buffer the way they change the chat", async () => {
  const { mcp, fake } = await connect();
  await pairAndConnect(mcp, fake);
  const socket = fake.latest();
  socket.emit("messages.upsert", {
    type: "notify",
    messages: [groupText("E1", NOW - 20, "tasting at 5"), groupText("E2", NOW - 10, "oops")],
  });
  socket.emit("messages.update", [
    {
      key: { remoteJid: GROUP, id: "E1", participant: GRACE_LID },
      update: { message: { editedMessage: { message: { conversation: "tasting at 6" } } } },
    },
    {
      key: { remoteJid: GROUP, id: "E2", participant: GRACE_LID },
      update: { message: null, messageStubType: 1 },
    },
  ]);
  const res = await call(mcp, "whatsapp_get_messages", { chat_id: GROUP });
  assert.deepEqual(
    res.json.messages.map((m: any) => [m.id, m.text]),
    [["E1", "tasting at 6"]],
  );
});

test("history sync is buffered, and list_chats finds the group by name", async () => {
  const { mcp, fake } = await connect();
  await pairAndConnect(mcp, fake);
  const socket = fake.latest();
  socket.emit("messaging-history.set", {
    chats: [
      { id: GROUP, name: "Wedding planning", conversationTimestamp: NOW - 100 },
      { id: GRACE_LID, conversationTimestamp: NOW - 500 },
    ],
    contacts: [{ id: GRACE_LID, phoneNumber: GRACE_PN, notify: "Grace H" }],
    lidPnMappings: [{ lid: GRACE_LID, pn: GRACE_PN }],
    messages: [
      groupText("H1", NOW - 200, "history one"),
      // Older than the 30-day window: not kept.
      groupText("H0", NOW - 40 * 86_400, "ancient"),
      {
        key: { remoteJid: GRACE_LID, fromMe: false, id: "D1" },
        message: { conversation: "hi from grace" },
        messageTimestamp: NOW - 500,
      },
    ],
  });

  const chats = await call(mcp, "whatsapp_list_chats", {});
  assert.equal(chats.isError, false, chats.text);
  assert.deepEqual(chats.json.chats[0], {
    id: GROUP,
    name: "Wedding planning",
    is_group: true,
    last_message_at: NOW - 100,
    participant_count: 3,
  });
  // The LID-addressed 1:1 chat is folded onto the phone JID.
  const dm = chats.json.chats.find((c: any) => c.id === GRACE_PN);
  assert.equal(dm.name, "Grace H");
  assert.equal(dm.is_group, false);
  assert.equal(chats.json.chats.some((c: any) => c.id === GRACE_LID), false);

  const found = await call(mcp, "whatsapp_list_chats", { query: "WEDDING" });
  assert.deepEqual(found.json.chats.map((c: any) => c.id), [GROUP]);

  const group = await call(mcp, "whatsapp_get_messages", { chat_id: GROUP });
  assert.deepEqual(group.json.messages.map((m: any) => m.id), ["H1"]);
  const direct = await call(mcp, "whatsapp_get_messages", { chat_id: GRACE_LID });
  assert.equal(direct.json.chat_id, GRACE_PN);
  assert.deepEqual(direct.json.messages.map((m: any) => m.text), ["hi from grace"]);
});

test("send_message records sent_by_bridge, quotes, and paces", async () => {
  const { mcp, fake } = await connect();
  await pairAndConnect(mcp, fake);
  const socket = fake.latest();
  socket.emit("messages.upsert", { type: "notify", messages: [groupText("Q1", NOW - 60, "what time?")] });

  const sent = await call(mcp, "whatsapp_send_message", {
    chat_id: GROUP,
    text: "5pm works",
    reply_to_message_id: "Q1",
  });
  assert.equal(sent.isError, false, sent.text);
  assert.deepEqual(Object.keys(sent.json).sort(), ["id", "timestamp"]);
  assert.equal(sent.json.timestamp, NOW);
  assert.equal(socket.sent[0]!.quoted?.key?.id, "Q1");
  assert.deepEqual(socket.presence, [`composing:${GROUP}`]);

  // A later redelivery of the same message (history, a retry) must not clear it.
  socket.emit("messages.upsert", {
    type: "append",
    messages: [
      {
        key: { remoteJid: GROUP, fromMe: true, id: sent.json.id },
        message: { conversation: "5pm works" },
        messageTimestamp: NOW,
      },
    ],
  });
  const read = await call(mcp, "whatsapp_get_messages", { chat_id: GROUP });
  const mine = read.json.messages.find((m: any) => m.id === sent.json.id);
  assert.equal(mine.sent_by_bridge, true);
  assert.equal(mine.from_me, true);
  assert.equal(mine.quoted_message_id, "Q1");

  // Three per minute in this test's pacing: the fourth is refused, not queued.
  await call(mcp, "whatsapp_send_message", { chat_id: GROUP, text: "two" });
  await call(mcp, "whatsapp_send_message", { chat_id: GROUP, text: "three" });
  const burst = await call(mcp, "whatsapp_send_message", { chat_id: GROUP, text: "four" });
  assert.equal(burst.isError, true);
  assert.match(burst.text, /human pace/);
  assert.equal(socket.sent.length, 3);

  const unknown = await call(mcp, "whatsapp_send_message", {
    chat_id: "15559999999@s.whatsapp.net",
    text: "hello stranger",
  });
  assert.equal(unknown.isError, true, "a typo'd chat id must not message a stranger");
  assert.equal(socket.sent.length, 3);
});

test("a restart restores the login and the buffer from the store alone", async () => {
  const blobs = new MemoryBlobStore();
  const cfg = config();
  const first = await connect({ blobs, cfg });
  await pairAndConnect(first.mcp, first.fake);
  first.fake.latest().emit("messages.upsert", {
    type: "notify",
    messages: [groupText("R1", NOW - 5, "survives a deploy")],
  });
  const sent = await call(first.mcp, "whatsapp_send_message", { chat_id: GROUP, text: "me too" });
  // The id is persisted by the time the send returns — no close, no debounce.
  // A process killed right here (a crash, SIGKILL mid-deploy) must still know
  // the message was the bridge's. Snapshot the store now and restart from it.
  const atReturn = new MemoryBlobStore();
  for (const [name, obj] of blobs.objects) atReturn.objects.set(name, { ...obj });
  const crashed = fakeWhatsApp(clock);
  crashed.autoOpen = true;
  const afterCrash = await connect({ blobs: atReturn, cfg, fake: crashed });
  await waitFor(async () => (await call(afterCrash.mcp, "whatsapp_status")).json.connected);
  // WhatsApp re-delivers both on reconnect: the bridge's message, and one the
  // person typed on the phone. Both are from_me; only one is the bridge's.
  crashed.latest().emit("messages.upsert", {
    type: "append",
    messages: [
      { key: { remoteJid: GROUP, fromMe: true, id: sent.json.id }, message: { conversation: "me too" }, messageTimestamp: NOW },
      { key: { remoteJid: GROUP, fromMe: true, id: "PHONE1" }, message: { conversation: "typed on the phone" }, messageTimestamp: NOW },
    ],
  });
  const recovered = await call(afterCrash.mcp, "whatsapp_get_messages", { chat_id: GROUP });
  const flags = Object.fromEntries(
    recovered.json.messages.map((m: any) => [m.id, [m.from_me, m.sent_by_bridge]]),
  );
  assert.deepEqual(flags[sent.json.id], [true, true]);
  assert.deepEqual(flags.PHONE1, [true, false]);
  await afterCrash.close();
  open.pop();

  await first.close();
  open.pop();

  const fake = fakeWhatsApp(clock);
  fake.autoOpen = true;
  const second = await connect({ blobs, cfg, fake });
  await waitFor(async () => (await call(second.mcp, "whatsapp_status")).json.connected);
  assert.equal(fake.sockets.length, 1, "connected on its own, with no pairing");

  const read = await call(second.mcp, "whatsapp_get_messages", { chat_id: GROUP });
  assert.deepEqual(read.json.messages.map((m: any) => m.text), ["survives a deploy", "me too"]);
  assert.equal(read.json.messages[1].id, sent.json.id);
  assert.equal(read.json.messages[1].sent_by_bridge, true);
  assert.equal(read.json.chat_name, "Wedding planning");

  // At rest the buffer is sealed: no message text in any object.
  for (const [, obj] of blobs.objects) {
    assert.equal(obj.data.includes(Buffer.from("survives a deploy")), false);
  }
});

test("the newer process wins the account; the older one stops", async () => {
  const blobs = new MemoryBlobStore();
  const cfg = config();
  // The old process re-reads the lease at most every 30s; let that pass.
  let later = 0;
  const old = await connect({ blobs, cfg, clock: () => NOW * 1000 + later });
  await pairAndConnect(old.mcp, old.fake);
  await old.created.bridge()!.flush();

  // The deploy's new container: same store, same key.
  const fake = fakeWhatsApp(clock);
  fake.autoOpen = true;
  const fresh = await connect({ blobs, cfg, fake });
  await waitFor(async () => (await call(fresh.mcp, "whatsapp_status")).json.connected);
  await fresh.created.bridge()!.flush();

  // The old process learns at its next write that the lease moved.
  later = 31_000;
  old.fake.latest().emit("messages.upsert", {
    type: "notify",
    messages: [groupText("X1", NOW - 1, "seen by the old one")],
  });
  await old.created.bridge()!.flush().catch(() => {});
  const status = await call(old.mcp, "whatsapp_status");
  assert.equal(status.json.connected, false);
  assert.equal(status.json.last_disconnect_reason, "replaced_by_another_instance");
  assert.equal(old.fake.latest().ended, true);
  const refused = await call(old.mcp, "whatsapp_get_messages", { chat_id: GROUP });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /exactly ONE instance/);

  // …and the new one is unaffected.
  const ok = await call(fresh.mcp, "whatsapp_status");
  assert.equal(ok.json.connected, true);
});

test("an old process that WhatsApp replaced (440) does not reconnect over its successor", async () => {
  const blobs = new MemoryBlobStore();
  const cfg = config();
  const old = await connect({ blobs, cfg });
  await pairAndConnect(old.mcp, old.fake);
  await old.created.bridge()!.flush();

  const fake = fakeWhatsApp(clock);
  fake.autoOpen = true;
  const fresh = await connect({ blobs, cfg, fake });
  await waitFor(async () => (await call(fresh.mcp, "whatsapp_status")).json.connected);

  // The old process has nothing to write, so only WhatsApp tells it.
  const socketsBefore = old.fake.sockets.length;
  old.fake.latest().close(440);
  await waitFor(
    async () =>
      (await call(old.mcp, "whatsapp_status")).json.last_disconnect_reason ===
      "replaced_by_another_instance",
  );
  assert.equal(old.fake.sockets.length, socketsBefore, "no socket opened over the successor");
  assert.equal((await call(fresh.mcp, "whatsapp_status")).json.connected, true);
});

test("WhatsApp logging the device out (401) drops the login and stops reconnecting", async () => {
  const { mcp, fake, blobs } = await connect();
  await pairAndConnect(mcp, fake);
  await waitFor(() => blobs.objects.has("whatsapp/auth.bin"));
  fake.latest().close(401);
  const status = await call(mcp, "whatsapp_status");
  assert.equal(status.json.paired, false);
  assert.equal(status.json.connected, false);
  assert.equal(status.json.last_disconnect_reason, "logged_out");
  await waitFor(() => !blobs.objects.has("whatsapp/auth.bin"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fake.sockets.length, 2);
});

test("a dropped connection reconnects with backoff", async () => {
  const { mcp, fake } = await connect();
  await pairAndConnect(mcp, fake);
  fake.latest().close(428);
  assert.equal((await call(mcp, "whatsapp_status")).json.connected, false);
  await waitFor(() => fake.sockets.length === 3);
  fake.latest().open();
  await waitFor(async () => (await call(mcp, "whatsapp_status")).json.connected);
});

test("whatsapp_logout unlinks and wipes everything persisted", async () => {
  const { mcp, fake, blobs } = await connect();
  await pairAndConnect(mcp, fake);
  fake.latest().emit("messages.upsert", { type: "notify", messages: [groupText("L1", NOW, "bye")] });
  await waitFor(async () => (await blobs.list("whatsapp/chats/")).length === 1);
  const socket = fake.latest();

  const res = await call(mcp, "whatsapp_logout");
  assert.deepEqual(res.json, { ok: true, unlinked_on_phone: true });
  assert.equal(socket.loggedOut, true);
  assert.deepEqual(await blobs.list("whatsapp/"), ["whatsapp/lease.json"]);
  const status = await call(mcp, "whatsapp_status");
  assert.equal(status.json.paired, false);
  const chats = await call(mcp, "whatsapp_list_chats");
  assert.deepEqual(chats.json.chats, []);
});

test("a state sealed under another key is reported, not silently replaced", async () => {
  const blobs = new MemoryBlobStore();
  const first = await connect({ blobs, cfg: config() });
  await pairAndConnect(first.mcp, first.fake);
  await first.close();
  open.pop();

  const fake = fakeWhatsApp(clock);
  const rotated = await connect({ blobs, cfg: config(randomBytes(32)), fake });
  const read = await call(rotated.mcp, "whatsapp_list_chats");
  assert.equal(read.isError, true);
  assert.match(read.text, /WHATSAPP_STATE_ENCRYPTION_KEY/);
  assert.equal(fake.sockets.length, 0, "never connects on a login it cannot read");
  assert.equal((await call(rotated.mcp, "whatsapp_status")).json.last_disconnect_reason, "state_unreadable");

  // logout is the way out, and afterwards pairing works again.
  assert.equal((await call(rotated.mcp, "whatsapp_logout")).isError, false);
  assert.equal((await call(rotated.mcp, "whatsapp_list_chats")).isError, false);
});

test("unconfigured: tools list, every call names the missing variables", async () => {
  const { mcp } = await connect({ env: {} });
  const { tools } = await mcp.listTools();
  assert.equal(tools.length, 7);
  const res = await call(mcp, "whatsapp_status");
  assert.equal(res.isError, true);
  for (const name of [
    "WHATSAPP_STATE_ENCRYPTION_KEY",
    "STRAD_STATE_GCS_BUCKET",
    "STRAD_STATE_GCS_CLIENT_EMAIL",
    "STRAD_STATE_GCS_PRIVATE_KEY",
  ]) {
    assert.match(res.text, new RegExp(name));
  }
});

test("a send that reaches WhatsApp and then fails still marks its echo sent_by_bridge", async () => {
  const { mcp, fake } = await connect();
  await pairAndConnect(mcp, fake);
  const socket = fake.latest();
  socket.failNextSendAfterDelivery = true;
  const res = await call(mcp, "whatsapp_send_message", { chat_id: GROUP, text: "did this go?" });
  assert.equal(res.isError, true);
  const read = await call(mcp, "whatsapp_get_messages", { chat_id: GROUP });
  const echo = read.json.messages.find((m: any) => m.text === "did this go?");
  assert.ok(echo, "the echo is buffered");
  assert.equal(echo.sent_by_bridge, true, "its id was the bridge's before the send");
});

test("a second whatsapp_pair replaces the first without the first tearing it down", async () => {
  const { mcp, fake } = await connect();
  const first = call(mcp, "whatsapp_pair", { phone_number: "15550000001" });
  await waitFor(() => fake.sockets.length === 1);
  const second = call(mcp, "whatsapp_pair", { phone_number: "15550000001" });
  await waitFor(() => fake.sockets.length === 2);
  fake.latest().offerPairing();
  assert.equal((await second).isError, false);
  const stale = await first; // times out (500 ms here) waiting on a replaced socket
  assert.equal(stale.isError, true);
  assert.match(stale.text, /newer whatsapp_pair/);
  assert.equal(fake.sockets[1]!.ended, false, "the live pairing socket survives");
  assert.equal((await call(mcp, "whatsapp_status")).json.pairing_in_progress, true);
});

test("logout waits out an in-flight flush, so nothing it deletes is written back", async () => {
  class SlowBlobs extends MemoryBlobStore {
    slow = false;
    override async write(name: string, data: Buffer, ifGeneration?: string | null) {
      if (this.slow && name.includes("/chats/")) await new Promise((r) => setTimeout(r, 50));
      return super.write(name, data, ifGeneration);
    }
  }
  const blobs = new SlowBlobs();
  const { mcp, fake, created } = await connect({ blobs });
  await pairAndConnect(mcp, fake);
  await created.bridge()!.flush();
  blobs.slow = true;
  fake.latest().emit("messages.upsert", { type: "notify", messages: [groupText("W1", NOW, "racing")] });
  // The debounced flush starts within a millisecond and then sits in its slow
  // chat write: that is the in-flight flush logout has to wait out.
  await new Promise((r) => setTimeout(r, 15));
  const out = await call(mcp, "whatsapp_logout");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(out.isError, false);
  assert.deepEqual(await blobs.list("whatsapp/"), ["whatsapp/lease.json"]);
});

test("a message whose chat cannot be loaded right now is held, not dropped", async () => {
  class FlakyBlobs extends MemoryBlobStore {
    failChatReads = 0;
    override async read(name: string) {
      if (this.failChatReads > 0 && name.includes("/chats/")) {
        this.failChatReads--;
        throw new Error("503 backend error");
      }
      return super.read(name);
    }
  }
  const blobs = new FlakyBlobs();
  const cfg = config();
  const first = await connect({ blobs, cfg });
  await pairAndConnect(first.mcp, first.fake);
  first.fake.latest().emit("messages.upsert", { type: "notify", messages: [groupText("F0", NOW - 9, "before")] });
  await waitFor(async () => (await blobs.list("whatsapp/chats/")).length === 1);
  await first.close();
  open.pop();

  const fake = fakeWhatsApp(clock);
  fake.autoOpen = true;
  const second = await connect({ blobs, cfg, fake });
  await waitFor(async () => (await call(second.mcp, "whatsapp_status")).json.connected);
  blobs.failChatReads = 1;
  fake.latest().emit("messages.upsert", { type: "notify", messages: [groupText("F1", NOW, "after")] });
  await waitFor(async () => {
    const r = await call(second.mcp, "whatsapp_get_messages", { chat_id: GROUP });
    return !r.isError && r.json.messages.some((m: any) => m.id === "F1");
  });
  const r = await call(second.mcp, "whatsapp_get_messages", { chat_id: GROUP });
  assert.deepEqual(r.json.messages.map((m: any) => m.id), ["F0", "F1"]);
});

test("a 403 (a banned or restricted account) stops reconnecting", async () => {
  const { mcp, fake } = await connect();
  await pairAndConnect(mcp, fake);
  fake.latest().close(403);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fake.sockets.length, 2);
  const status = await call(mcp, "whatsapp_status");
  assert.equal(status.json.last_disconnect_reason, "forbidden");
  assert.equal(status.json.paired, true);
});

test("a transport error reaches whatsapp_pair as transient; retry, not the raw string", async () => {
  // A body cut off, as native fetch words it: the socket's error underneath.
  const RAW = "other side closed - Local: 10.0.0.2:41234, Remote: 142.250.65.74:443";
  const dropped = () =>
    new TypeError("terminated", {
      cause: Object.assign(new Error(RAW), { code: "UND_ERR_SOCKET" }),
    });
  class DroppingBlobs extends MemoryBlobStore {
    mode: "raw" | "exhausted" | "ok" = "raw";
    override async write(name: string, data: Buffer, ifGeneration?: string | null) {
      if (this.mode === "raw") throw dropped();
      if (this.mode === "exhausted") {
        throw new TransientStoreError(`writing ${name}`, 4, dropped());
      }
      return super.write(name, data, ifGeneration);
    }
  }
  const blobs = new DroppingBlobs();
  const { mcp, fake } = await connect({ blobs });

  for (const mode of ["raw", "exhausted"] as const) {
    blobs.mode = mode;
    const r = await call(mcp, "whatsapp_pair", { phone_number: "15550000001" });
    assert.equal(r.isError, true);
    assert.match(r.text, /transient; retry/);
    assert.doesNotMatch(r.text, /terminated|other side closed|142\.250|googleapis/);
  }

  // The start is not memoised as a failure: the retry the message asks for works.
  blobs.mode = "ok";
  await pairAndConnect(mcp, fake);
  assert.equal((await call(mcp, "whatsapp_status")).json.paired, true);
});

test("a GCS refusal is reported as GCS's, never as a WhatsApp rate limit", async () => {
  class RefusingBlobs extends MemoryBlobStore {
    override async write(name: string): Promise<string> {
      // An object name that happens to carry "429", on a 403.
      throw new GcsHttpError(403, `writing ${name}/c4291f.bin`, "Permission denied");
    }
  }
  const { mcp } = await connect({ blobs: new RefusingBlobs() });
  const r = await call(mcp, "whatsapp_pair", { phone_number: "15550000001" });
  assert.equal(r.isError, true);
  assert.match(r.text, /HTTP 403/);
  assert.doesNotMatch(r.text, /rate-limit/i);
});

test("a dropped connection during a send does not say retry: it may have gone out", async () => {
  const { mcp, fake } = await connect();
  await pairAndConnect(mcp, fake);
  fake.latest().sendMessage = async () => {
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  };
  const r = await call(mcp, "whatsapp_send_message", { chat_id: GROUP, text: "hi" });
  assert.equal(r.isError, true);
  assert.match(r.text, /may or may not have gone out/);
  assert.doesNotMatch(r.text, /transient; retry|socket hang up/);
});
