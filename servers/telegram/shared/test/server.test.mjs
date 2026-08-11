import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createGateway, createMCPServer } from "../build/index.js";
import {
  fakeClient,
  fakeDialogsWithCollision,
  FRIEND,
  GROUP,
  ME,
} from "./fake-client.mjs";

/**
 * These drive the server through a REAL MCP client over an in-memory transport —
 * the same path an agent takes — against a fake MTProto client.
 *
 * The claims under test:
 *   1. The driving requirement: reading the history of a GROUP the account
 *      joined and does not administer, by numeric id and by @username.
 *   2. Paging goes backwards in time, and the cursor is honest about the end.
 *   3. A chat id whose access hash this session has not learned still resolves,
 *      via the dialog scan — and one that names nothing says what to do.
 *   4. The read-only tool group withholds send_message from tools/list AND
 *      refuses the call.
 *   5. No credentials is a clear, actionable tool ERROR, never a crash, and
 *      tools/list still works.
 */

async function connect(options = {}) {
  const client = options.client ?? fakeClient();
  const { server, registerHandlers } = createMCPServer({
    version: "test",
    gatewayFactory: async () => createGateway(client),
    ...options.serverOptions,
  });
  await registerHandlers(server);
  const mcp = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);
  return { mcp, client, close: () => Promise.all([mcp.close(), server.close()]) };
}

const call = async (mcp, name, args = {}) => {
  const res = await mcp.callTool({ name, arguments: args });
  const text = res.content.map((c) => c.text).join("\n");
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: res.isError === true, text, json };
};

test("tools/list exposes the six tools, and only send_message is a write", async () => {
  const { mcp, close } = await connect();
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "get_chat",
    "get_chat_history",
    "get_me",
    "list_chats",
    "search_messages",
    "send_message",
  ]);
  for (const tool of tools) {
    const readOnly = tool.annotations?.readOnlyHint === true;
    assert.equal(
      readOnly,
      tool.name !== "send_message",
      `${tool.name} annotations disagree with its tier`,
    );
  }
  await close();
});

test("reads the history of a group the account joined but does not administer", async () => {
  // THE requirement. A supergroup, addressed by the id list_chats returns, read
  // as the user account — which is the thing the Bot API cannot do at all.
  const { mcp, client, close } = await connect();
  const { json, isError } = await call(mcp, "get_chat_history", {
    chat: "-1004123456789",
    limit: 50,
  });

  assert.equal(isError, false);
  assert.equal(json.chat.kind, "group");
  assert.equal(json.chat.title, GROUP.title);
  // OLDEST first, which is how a transcript reads.
  assert.deepEqual(
    json.messages.map((m) => m.id),
    [8813, 8814, 8815],
  );
  assert.equal(json.messages[1].text, "anyone free saturday?");
  assert.equal(json.messages[1].outgoing, true);
  assert.equal(json.messages[2].author.username, FRIEND.username);
  assert.equal(json.messages[2].reply_to_message_id, 8814);
  // Media is named, never fetched.
  assert.equal(json.messages[0].media, "photo");
  assert.equal(json.messages[0].text, "");
  assert.equal(json.messages[0].edited_at, "2026-08-09T12:01:00.000Z");
  // Three messages against a limit of 50 is the end of the chat, so no cursor.
  assert.equal(json.next_offset_id, undefined);

  const history = client.calls.find((c) => c.method === "getMessages");
  assert.equal(history.params.limit, 50);
  assert.equal(history.params.offsetId, undefined);
  await close();
});

test("paging walks backwards in time and stops naming a cursor at the start", async () => {
  const { mcp, client, close } = await connect();

  const first = await call(mcp, "get_chat_history", {
    chat: "@weekendclimbing",
    limit: 2,
  });
  // Newest two, oldest-first, and a cursor pointing at the OLDER of them.
  assert.deepEqual(
    first.json.messages.map((m) => m.id),
    [8814, 8815],
  );
  assert.equal(first.json.next_offset_id, 8814);

  const second = await call(mcp, "get_chat_history", {
    chat: "@weekendclimbing",
    limit: 2,
    offset_id: first.json.next_offset_id,
  });
  assert.deepEqual(
    second.json.messages.map((m) => m.id),
    [8813],
  );
  assert.equal(second.json.next_offset_id, undefined);

  const offsets = client.calls
    .filter((c) => c.method === "getMessages")
    .map((c) => c.params.offsetId);
  assert.deepEqual(offsets, [undefined, 8814]);
  await close();
});

test("resolves a chat by id even when the session has never learned its access hash", async () => {
  // getEntity fails for a numeric peer until the session has seen it. The dialog
  // scan is what teaches it, and this is the path most group reads take.
  const client = fakeClient({ entityLookupWorks: false });
  const { mcp, close } = await connect({ client });
  const { json, isError } = await call(mcp, "get_chat", { chat: "4123456789" });
  assert.equal(isError, false);
  assert.equal(json.id, "-1004123456789");
  assert.equal(json.kind, "group");
  assert.equal(json.title, GROUP.title);
  // Resolution does not carry a chat's volatile state: a memoised unread count
  // would be reported as current for the life of the process.
  assert.equal(json.unread_count, undefined);
  assert.ok(client.calls.some((c) => c.method === "getDialogs"));
  await close();
});

test("a user whose id collides with the group's does not get the group's messages", async () => {
  // User ids and channel ids come from overlapping ranges, so "4123456789" can
  // name a PERSON while "-1004123456789" names a supergroup. Folding the two
  // together sends a message meant for a group into someone's private chat.
  const client = fakeClient();
  client.setDialogs(fakeDialogsWithCollision());
  const { mcp, close } = await connect({ client });

  const person = await call(mcp, "get_chat", { chat: "4123456789" });
  assert.equal(person.json.kind, "user");
  assert.equal(person.json.title, "Not Ada");

  const group = await call(mcp, "get_chat", { chat: "-1004123456789" });
  assert.equal(group.json.kind, "group");
  assert.equal(group.json.title, GROUP.title);
  await close();
});

test("the same collision is resolved exactly when only the dialog scan can answer", async () => {
  // With no access hash, resolution is a scan over the dialog list — and the
  // scan must prefer the id AS WRITTEN over the `-100`-folded match.
  const client = fakeClient({ entityLookupWorks: false });
  client.setDialogs(fakeDialogsWithCollision());
  const { mcp, close } = await connect({ client });

  const person = await call(mcp, "get_chat", { chat: "4123456789" });
  assert.equal(person.json.id, "4123456789");
  assert.equal(person.json.kind, "user");

  const group = await call(mcp, "get_chat", { chat: "-1004123456789" });
  assert.equal(group.json.id, "-1004123456789");
  assert.equal(group.json.kind, "group");
  await close();
});

test("a t.me link resolves, and an invite link is refused without one", async () => {
  const { mcp, close } = await connect();

  // The form a human copies out of a PRIVATE supergroup — the kind this server
  // exists to read — carries the id and nothing else usable.
  const priv = await call(mcp, "get_chat", {
    chat: "https://t.me/c/4123456789/8815",
  });
  assert.equal(priv.isError, false);
  assert.equal(priv.json.kind, "group");

  const pub = await call(mcp, "get_chat", { chat: "t.me/weekendclimbing" });
  assert.equal(pub.json.username, "weekendclimbing");

  for (const invite of ["t.me/+abcdefg", "https://t.me/joinchat/abcdefg"]) {
    const res = await call(mcp, "get_chat", { chat: invite });
    assert.equal(res.isError, true, `${invite} should be refused`);
    assert.match(res.text, /private INVITE link/);
  }
  await close();
});

test("a bad `kinds` or `query` narrows nothing and is refused, not ignored", async () => {
  // The failure direction matters: silently dropping the filter turns a narrow
  // read of someone's private chat list into the whole of it.
  const { mcp, client, close } = await connect();

  const wrongKind = await call(mcp, "list_chats", { kinds: ["supergroup"] });
  assert.equal(wrongKind.isError, true);
  assert.match(wrongKind.text, /"supergroup"/);
  assert.match(wrongKind.text, /a supergroup is a "group"/);

  const wrongQuery = await call(mcp, "list_chats", { query: 12345 });
  assert.equal(wrongQuery.isError, true);
  assert.match(wrongQuery.text, /`query` must be a string/);

  assert.equal(client.calls.filter((c) => c.method === "getDialogs").length, 0);
  await close();
});

test("Telegram's own failures come back classified, and never carry a credential", async () => {
  const client = fakeClient();
  const session = "1BQANOTEyMDk3AAAAAAAAAAAAA-fake-session-string-fixture";
  const { mcp, close } = await connect({ client });

  const cases = [
    ["FLOOD_WAIT_42", /rate-limiting/, /Wait the number of/],
    ["AUTH_KEY_UNREGISTERED", /no longer valid/, /mint a new session string/],
    ["CHAT_WRITE_FORBIDDEN", /refused this on permissions/, /still not be allowed to post/],
  ];
  for (const [raw, first, second] of cases) {
    client.setMessages([]);
    client.getMessages = async () => {
      throw new Error(raw);
    };
    const res = await call(mcp, "get_chat_history", { chat: "@weekendclimbing" });
    assert.equal(res.isError, true);
    assert.match(res.text, first);
    assert.match(res.text, second);
  }

  // The library's text reaches the caller. The session string must not.
  client.getMessages = async () => {
    throw new Error(`transport failed while sending session ${session}`);
  };
  const leaked = await call(mcp, "get_chat_history", { chat: "@weekendclimbing" });
  assert.equal(leaked.isError, true);
  assert.doesNotMatch(leaked.text, /fake-session-string-fixture/);
  assert.match(leaked.text, /\[redacted\]/);
  await close();
});

test("a chat reference that names nothing says exactly what to do next", async () => {
  const { mcp, close } = await connect();
  const unknown = await call(mcp, "get_chat_history", { chat: "-1009999999999" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /No chat matched/);
  assert.match(unknown.text, /list_chats/);

  // An invite link is an invitation, not a reference, and is refused as such.
  const invite = await call(mcp, "get_chat", { chat: "https://t.me/+abcdefg" });
  assert.equal(invite.isError, true);
  assert.match(invite.text, /private INVITE link/);
  await close();
});

test("list_chats filters by kind and by query, and skips the archive by default", async () => {
  const client = fakeClient();
  client.setArchived([
    { id: -1004333333333, title: "Old Trip", isGroup: true, entity: { ...GROUP, id: 4333333333, title: "Old Trip", username: undefined } },
  ]);
  const { mcp, close } = await connect({ client });

  const groups = await call(mcp, "list_chats", { kinds: ["group"] });
  assert.deepEqual(
    groups.json.chats.map((c) => c.title),
    ["Weekend Climbing"],
  );
  assert.equal(groups.json.returned, 1);

  const matched = await call(mcp, "list_chats", { query: "route" });
  assert.deepEqual(
    matched.json.chats.map((c) => c.kind),
    ["channel"],
  );

  const withArchive = await call(mcp, "list_chats", {
    include_archived: true,
    kinds: ["group"],
  });
  assert.deepEqual(
    withArchive.json.chats.map((c) => c.title),
    ["Weekend Climbing", "Old Trip"],
  );
  assert.equal(withArchive.json.chats[1].archived, true);
  await close();
});

test("search_messages searches inside one chat, server-side", async () => {
  const { mcp, client, close } = await connect();
  const { json, isError } = await call(mcp, "search_messages", {
    chat: "-1004123456789",
    query: "permit",
  });
  assert.equal(isError, false);
  assert.deepEqual(
    json.messages.map((m) => m.id),
    [8815],
  );
  const search = client.calls.find((c) => c.method === "getMessages");
  assert.equal(search.params.search, "permit");

  // No account-wide search: the chat is required.
  const missing = await call(mcp, "search_messages", { query: "permit" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /`chat` is required/);
  await close();
});

test("get_me names the account every other tool acts as", async () => {
  const { mcp, close } = await connect();
  const { json } = await call(mcp, "get_me");
  assert.equal(json.id, String(ME.id));
  assert.equal(json.name, "Fixture Account");
  assert.equal(json.username, ME.username);
  await close();
});

test("send_message posts as the account, threads a reply, and refuses an over-long text", async () => {
  const { mcp, client, close } = await connect();
  const { json, isError } = await call(mcp, "send_message", {
    chat: "@weekendclimbing",
    text: "on my way",
    reply_to_message_id: 8815,
    disable_link_preview: true,
  });
  assert.equal(isError, false);
  assert.equal(json.message_id, 8900);
  assert.equal(json.chat.title, GROUP.title);

  const sent = client.calls.find((c) => c.method === "sendMessage");
  assert.equal(sent.params.message, "on my way");
  assert.equal(sent.params.replyTo, 8815);
  assert.equal(sent.params.linkPreview, false);

  const long = await call(mcp, "send_message", {
    chat: "@weekendclimbing",
    text: "x".repeat(4097),
  });
  assert.equal(long.isError, true);
  assert.match(long.text, /4097 characters/);
  // Refused HERE: nothing reached Telegram.
  assert.equal(client.calls.filter((c) => c.method === "sendMessage").length, 1);
  await close();
});

test("the read-only tier does not build send_message, at list or at call", async () => {
  const { mcp, client, close } = await connect({
    serverOptions: { toolGroups: ["readonly"] },
  });
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "get_chat",
    "get_chat_history",
    "get_me",
    "list_chats",
    "search_messages",
  ]);

  const refused = await mcp
    .callTool({ name: "send_message", arguments: { chat: "@weekendclimbing", text: "hi" } })
    .then((res) => ({ thrown: false, res }))
    .catch((err) => ({ thrown: true, err }));
  const message = refused.thrown
    ? String(refused.err)
    : refused.res.content.map((c) => c.text).join("\n");
  assert.match(message, /Unknown tool: send_message/);
  // And nothing was sent.
  assert.equal(client.calls.filter((c) => c.method === "sendMessage").length, 0);
  await close();
});
