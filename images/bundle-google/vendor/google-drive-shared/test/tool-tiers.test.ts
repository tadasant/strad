/**
 * The tiers, the groups and the credential.
 *
 * READ_TOOLS is what a read-only slug's `tools: allow:` is copied from, and
 * `GOOGLE_DRIVE_ENABLED_TOOLGROUPS` is the only narrowing a standalone server
 * has. A tool added without a tier, or a typo'd group read as "every group",
 * would each hand a narrower caller the write or edit tools.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  READ_TOOLS,
  WRITE_TOOLS,
  EDIT_TOOLS,
  toolNames,
  parseToolGroups,
  createMCPServer,
  missingCredentials,
  GOOGLE_DRIVE_ENV_NAMES,
  GOOGLE_DRIVE_SCOPES,
} from "../src/index.js";

async function listed(options: Parameters<typeof createMCPServer>[0]) {
  const { server, registerHandlers } = createMCPServer(options);
  await registerHandlers(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

test("every registered tool is in exactly one tier", () => {
  assert.deepEqual(toolNames().sort(), [...READ_TOOLS, ...WRITE_TOOLS, ...EDIT_TOOLS].sort());
});

test("readwrite only creates: everything that changes an existing file is in full", async () => {
  assert.deepEqual([...WRITE_TOOLS], ["create_folder", "create_file"]);
  const readwrite = (await listed({ version: "0", env: {}, enabledToolGroups: "readwrite" })).map((t) => t.name);
  for (const name of readwrite) assert.doesNotMatch(name, /^(update|replace|delete|trash|restore|move|share|copy|rename)/);
  for (const name of EDIT_TOOLS) assert.ok(!readwrite.includes(name), name);
});

test("no tier deletes permanently or shares", () => {
  for (const name of toolNames()) assert.doesNotMatch(name, /delete|share|permission|empty/);
});

test("annotations agree with the tiers", async () => {
  const tools = await listed({ version: "0", env: {} });
  const destructive = ["replace_file_content", "update_file_metadata", "move_file", "trash_file"];
  for (const tool of tools) {
    const read = (READ_TOOLS as readonly string[]).includes(tool.name);
    assert.equal(tool.annotations?.readOnlyHint, read, tool.name);
    assert.equal(tool.annotations?.destructiveHint, destructive.includes(tool.name), tool.name);
  }
});

test("each tier holds the one before it; unset lists every tool", async () => {
  const names = async (groups?: string) =>
    (await listed({ version: "0", env: {}, enabledToolGroups: groups })).map((t) => t.name);
  assert.deepEqual(await names("readonly"), [...READ_TOOLS]);
  assert.equal((await listed({ version: "0", env: { GOOGLE_DRIVE_ENABLED_TOOLGROUPS: "readonly" } })).length, 3);
  assert.deepEqual(await names("readwrite"), [...READ_TOOLS, ...WRITE_TOOLS]);
  assert.deepEqual(await names("full"), [...READ_TOOLS, ...WRITE_TOOLS, ...EDIT_TOOLS]);
  assert.equal((await listed({ version: "0", env: {} })).length, 11);
});

test("an unknown tool group throws rather than widening to every tool", () => {
  assert.throws(() => parseToolGroups("read-only"), /unknown tool group\(s\) "read-only"/);
  assert.throws(() => createMCPServer({ version: "0", env: { GOOGLE_DRIVE_ENABLED_TOOLGROUPS: "readonly,admin" } }), /"admin"/);
  assert.deepEqual(parseToolGroups(" ReadOnly , "), ["readonly"]);
  assert.deepEqual(parseToolGroups(""), ["readonly", "readwrite", "full"]);
  assert.throws(() => parseToolGroups("edit"), /expected readonly, readwrite, full/);
});

test("the credential is three OAuth variables; only the full tier's scope is the full drive scope", () => {
  assert.deepEqual(missingCredentials({}), [...GOOGLE_DRIVE_ENV_NAMES]);
  assert.deepEqual(missingCredentials({ GOOGLE_DRIVE_OAUTH_CLIENT_ID: "a", GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: "b", GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: "c" }), []);
  assert.equal(GOOGLE_DRIVE_SCOPES.readonly, "https://www.googleapis.com/auth/drive.readonly");
  assert.equal(GOOGLE_DRIVE_SCOPES.file, "https://www.googleapis.com/auth/drive.file");
  assert.equal(GOOGLE_DRIVE_SCOPES.full, "https://www.googleapis.com/auth/drive");
});
