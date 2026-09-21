/**
 * create_spreadsheet over a real MCP client, into the same decorated client the
 * bundle host builds, with Google stubbed at fetch.
 *
 * What it guards: the tool answers with the id and URL a caller needs to go on
 * writing to the file, it refuses a request Google would refuse before anything
 * is created, and a Google failure comes back as a tool error rather than as a
 * success with no file behind it.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createRegisterTools } from "../src/tools.js";
import { withOfficeFallback } from "../src/office/client.js";
import { OfficeWorkbookLoader } from "../src/office/load.js";
import { createSpreadsheet } from "../src/google-sheets-client/lib/create-spreadsheet.js";

const NEW_ID = "1NewSheetIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

let calls = [];
let reply = () => new Response("{}", { status: 200 });
const realFetch = globalThis.fetch;

/** A Sheets client whose one method is the real wire, over the stubbed fetch. */
const wireClient = () => {
  const inner = {
    createSpreadsheet: (request) => createSpreadsheet({ Authorization: "Bearer t" }, request),
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

beforeEach(() => {
  calls = [];
  reply = () =>
    new Response(
      JSON.stringify({
        spreadsheetId: NEW_ID,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${NEW_ID}/edit`,
        properties: { title: "Housing listings" },
        sheets: [
          { properties: { sheetId: 0, title: "Listings", index: 0 } },
          { properties: { sheetId: 1234567, title: "Notes", index: 1 } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    return reply();
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("it answers with the id, the URL and every tab's gid", async () => {
  const mcp = await connect(wireClient());
  const result = await mcp.callTool({
    name: "create_spreadsheet",
    arguments: {
      title: "Housing listings",
      sheets: [{ title: "Listings", headers: ["Date", "Address", "Rent"] }, { title: "Notes" }],
    },
  });

  assert.equal(result.isError, undefined);
  const text = textOf(result);
  assert.match(text, /Created spreadsheet "Housing listings"/);
  assert.match(text, new RegExp(`\\*\\*ID:\\*\\* ${NEW_ID}`));
  assert.match(text, new RegExp(`https://docs\\.google\\.com/spreadsheets/d/${NEW_ID}/edit`));
  assert.match(text, /\*\*Listings\*\* — gid 0/);
  assert.match(text, /\*\*Notes\*\* — gid 1234567/);

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.sheets[0].data[0].rowData[0].values.length, 3);
});

test("with a title alone it creates the file and lets Google name the tab", async () => {
  reply = () =>
    new Response(
      JSON.stringify({
        spreadsheetId: NEW_ID,
        properties: { title: "Scratch" },
        sheets: [{ properties: { sheetId: 0, title: "Sheet1", index: 0 } }],
      }),
      { status: 200 },
    );
  const mcp = await connect(wireClient());
  const text = textOf(await mcp.callTool({ name: "create_spreadsheet", arguments: { title: "Scratch" } }));

  assert.deepEqual(JSON.parse(calls[0].body), { properties: { title: "Scratch" } });
  assert.match(text, /\*\*Sheet1\*\* — gid 0/);
  // No spreadsheetUrl in the reply still leaves the caller a link.
  assert.match(text, new RegExp(`https://docs\\.google\\.com/spreadsheets/d/${NEW_ID}/edit`));
});

test("two tabs whose titles differ only by case are refused before anything is created", async () => {
  const mcp = await connect(wireClient());
  const result = await mcp.callTool({
    name: "create_spreadsheet",
    arguments: { title: "x", sheets: [{ title: "Listings" }, { title: "listings" }] },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Two tabs are titled "listings"/);
  assert.deepEqual(calls, []);
});

test("a blank title is refused before anything is created", async () => {
  const mcp = await connect(wireClient());
  for (const args of [{}, { title: "   " }, { title: "x", sheets: [{ title: "" }] }]) {
    const result = await mcp.callTool({ name: "create_spreadsheet", arguments: args });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.deepEqual(calls, []);
});

test("a token without the write scope is a tool error that names the scope", async () => {
  reply = () =>
    new Response(
      JSON.stringify({
        error: { code: 403, status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes." },
      }),
      { status: 403, statusText: "Forbidden" },
    );
  const mcp = await connect(wireClient());
  const result = await mcp.callTool({ name: "create_spreadsheet", arguments: { title: "x" } });

  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /Error creating spreadsheet: Permission denied \(Create spreadsheet "x"\)/);
  assert.match(text, /https:\/\/www\.googleapis\.com\/auth\/spreadsheets\b/);
});
