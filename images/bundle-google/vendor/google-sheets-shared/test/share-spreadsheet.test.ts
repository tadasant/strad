/**
 * share_spreadsheet over a real MCP client, into the same decorated client the
 * bundle host builds, with Drive stubbed at fetch.
 *
 * What it guards: the grant on the wire is exactly the one asked for, an
 * argument Google would refuse is refused before anything is granted, and a
 * token without the Drive scope fails naming that scope rather than the Sheets
 * one the generic hint would send a human after.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createRegisterTools } from "../src/tools.js";
import { withOfficeFallback } from "../src/office/client.js";
import { OfficeWorkbookLoader } from "../src/office/load.js";
import { createPermission } from "../src/drive-client/lib/permissions.js";

const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

let calls = [];
let reply = () => new Response("{}", { status: 200 });
const realFetch = globalThis.fetch;

/** A client whose one method is the real wire, over the stubbed fetch. */
const wireClient = () => {
  const inner = {
    createPermission: (fileId, options) =>
      createPermission({ Authorization: "Bearer t" }, fileId, options),
  };
  return withOfficeFallback(inner, new OfficeWorkbookLoader(async () => ({})));
};

async function connect(client) {
  const server = new Server({ name: "test", version: "0" }, { capabilities: { tools: {} } });
  createRegisterTools(() => client)(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test-client", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

const textOf = (result) => result.content.map((part) => part.text).join("\n");
const share = async (args) =>
  (await connect(wireClient())).callTool({ name: "share_spreadsheet", arguments: args });

beforeEach(() => {
  calls = [];
  reply = (body) =>
    new Response(JSON.stringify({ id: "perm-1", ...body }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: new URL(String(url)), method: init.method ?? "GET", body });
    return reply(body);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a user grant is one POST to the file's Drive permissions, from a pasted URL", async () => {
  const result = await share({
    spreadsheet_id: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
    type: "user",
    role: "writer",
    email_address: "julie@example.com",
  });

  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.method, "POST");
  assert.equal(call.url.pathname, `/drive/v3/files/${ID}/permissions`);
  assert.equal(call.url.searchParams.get("supportsAllDrives"), "true");
  // Without `fields`, Drive answers id/type/kind only and the reply could not
  // confirm what was granted.
  assert.equal(call.url.searchParams.get("fields"), "id,type,role,emailAddress,domain");
  // Unset means Google's default — it emails a user. Not forced either way.
  assert.equal(call.url.searchParams.has("sendNotificationEmail"), false);
  assert.deepEqual(call.body, { type: "user", role: "writer", emailAddress: "julie@example.com" });

  const text = textOf(result);
  assert.match(text, /julie@example\.com \(user\) is now a writer/);
  assert.match(text, /perm-1/);
  assert.match(text, new RegExp(`https://docs.google.com/spreadsheets/d/${ID}/edit`));
});

test("a silent share says so on the wire", async () => {
  await share({
    spreadsheet_id: ID,
    type: "user",
    role: "reader",
    email_address: "julie@example.com",
    send_notification_email: false,
  });
  assert.equal(calls[0].url.searchParams.get("sendNotificationEmail"), "false");
});

test("anyone and domain grants never ask Google to email, and carry only their own field", async () => {
  await share({ spreadsheet_id: ID, type: "anyone", role: "reader", email_address: "x@example.com" });
  assert.equal(calls[0].url.searchParams.get("sendNotificationEmail"), "false");
  assert.deepEqual(calls[0].body, { type: "anyone", role: "reader" });

  await share({ spreadsheet_id: ID, type: "domain", role: "commenter", domain: "example.com" });
  assert.equal(calls[1].url.searchParams.get("sendNotificationEmail"), "false");
  assert.deepEqual(calls[1].body, { type: "domain", role: "commenter", domain: "example.com" });

  await share({ spreadsheet_id: ID, type: "group", role: "reader", email_address: "team@example.com" });
  assert.equal(calls[2].url.searchParams.has("sendNotificationEmail"), false);
  assert.deepEqual(calls[2].body, { type: "group", role: "reader", emailAddress: "team@example.com" });
});

test("an incomplete or impossible grant is refused before anything reaches Google", async () => {
  for (const args of [
    { spreadsheet_id: ID, type: "user", role: "writer" },
    { spreadsheet_id: ID, type: "group", role: "reader" },
    { spreadsheet_id: ID, type: "domain", role: "reader" },
    { spreadsheet_id: ID, type: "anyone", role: "reader", send_notification_email: true },
    { spreadsheet_id: ID, type: "user", role: "owner", email_address: "julie@example.com" },
    { spreadsheet_id: ID, type: "user", role: "writer", email_address: "not-an-email" },
  ]) {
    const result = await share(args);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
});

test("a token without the drive scope is told to add drive, not spreadsheets", async () => {
  reply = () =>
    new Response(
      JSON.stringify({
        error: { status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes." },
      }),
      { status: 403, statusText: "Forbidden", headers: { "content-type": "application/json" } },
    );

  const result = await share({
    spreadsheet_id: ID,
    type: "user",
    role: "writer",
    email_address: "julie@example.com",
  });

  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /https:\/\/www\.googleapis\.com\/auth\/drive /);
  assert.match(text, /Reconnect Google/);
  assert.doesNotMatch(text, /writing needs https:\/\/www\.googleapis\.com\/auth\/spreadsheets/);
});

test("a sharing quota is a wait, not an ownership problem", async () => {
  reply = () =>
    new Response(JSON.stringify({ error: { message: "Rate limit exceeded. User message: \"Sorry, you have exceeded your sharing quota.\"" } }), {
      status: 403,
      statusText: "Forbidden",
      headers: { "content-type": "application/json" },
    });

  const text = textOf(
    await share({ spreadsheet_id: ID, type: "user", role: "reader", email_address: "julie@example.com" }),
  );
  assert.match(text, /try again/);
  assert.doesNotMatch(text, /owner of the file/);
});

test("a Drive API that is not enabled is named as Drive, not Sheets", async () => {
  reply = () =>
    new Response(JSON.stringify({ error: { message: "Google Drive API has not been used in project 123 before or it is disabled." } }), {
      status: 403,
      statusText: "Forbidden",
      headers: { "content-type": "application/json" },
    });

  const text = textOf(
    await share({ spreadsheet_id: ID, type: "user", role: "reader", email_address: "julie@example.com" }),
  );
  assert.match(text, /Google Drive API is not enabled/);
});

test("a 403 that is not about scope names who may share", async () => {
  reply = () =>
    new Response(JSON.stringify({ error: { message: "The user does not have sufficient permissions for this file." } }), {
      status: 403,
      statusText: "Forbidden",
      headers: { "content-type": "application/json" },
    });

  const text = textOf(
    await share({ spreadsheet_id: ID, type: "user", role: "reader", email_address: "julie@example.com" }),
  );
  assert.match(text, /owner of the file/);
});
