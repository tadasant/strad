/**
 * The tiers, the groups and the credential.
 *
 * READ_TOOLS is what a read-only slug's `tools: allow:` is copied from, and
 * `GOOGLE_DRIVE_ENABLED_TOOLGROUPS=readonly` is the only narrowing a standalone
 * server has. A tool added without a tier, or a typo'd group read as "every
 * group", would each hand a read-only caller the create tools.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  READ_TOOLS,
  WRITE_TOOLS,
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
  assert.deepEqual(toolNames().sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
});

test("the write tier only creates: nothing edits, deletes, moves or shares", () => {
  assert.deepEqual([...WRITE_TOOLS], ["create_folder", "create_file"]);
  for (const name of toolNames()) assert.doesNotMatch(name, /^(update|delete|trash|move|share|copy|rename)/);
});

test("annotations agree with the tiers", async () => {
  const tools = await listed({ version: "0", env: {} });
  for (const tool of tools) {
    const read = (READ_TOOLS as readonly string[]).includes(tool.name);
    assert.equal(tool.annotations?.readOnlyHint, read, tool.name);
    assert.equal(tool.annotations?.destructiveHint, false, tool.name);
  }
});

test("readonly lists the three reads; readwrite and unset list all five", async () => {
  assert.deepEqual((await listed({ version: "0", env: {}, enabledToolGroups: "readonly" })).map((t) => t.name), [...READ_TOOLS]);
  assert.equal((await listed({ version: "0", env: { GOOGLE_DRIVE_ENABLED_TOOLGROUPS: "readonly" } })).length, 3);
  assert.equal((await listed({ version: "0", env: {}, enabledToolGroups: "readwrite" })).length, 5);
  assert.equal((await listed({ version: "0", env: {} })).length, 5);
});

test("an unknown tool group throws rather than widening to every tool", () => {
  assert.throws(() => parseToolGroups("read-only"), /unknown tool group\(s\) "read-only"/);
  assert.throws(() => createMCPServer({ version: "0", env: { GOOGLE_DRIVE_ENABLED_TOOLGROUPS: "readonly,admin" } }), /"admin"/);
  assert.deepEqual(parseToolGroups(" ReadOnly , "), ["readonly"]);
  assert.deepEqual(parseToolGroups(""), ["readonly", "readwrite"]);
});

test("the credential is three OAuth variables, and neither scope is the full drive scope", () => {
  assert.deepEqual(missingCredentials({}), [...GOOGLE_DRIVE_ENV_NAMES]);
  assert.deepEqual(missingCredentials({ GOOGLE_DRIVE_OAUTH_CLIENT_ID: "a", GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: "b", GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: "c" }), []);
  for (const scope of Object.values(GOOGLE_DRIVE_SCOPES)) {
    assert.notEqual(scope, "https://www.googleapis.com/auth/drive");
  }
});
