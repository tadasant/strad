import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  ENV,
  ConfigError,
  createMCPServer,
  loadConfig,
  missingCredentials,
  redact,
} from "../build/index.js";

/**
 * The no-credentials path, which is the state this server ships in.
 *
 * The image carries no session string; strad injects one at deploy time. Until
 * it does, every one of these must hold: the server BUILDS, it MOUNTS, it LISTS
 * its tools, and a call fails with an error a human can act on — naming the
 * variables, and never echoing a value.
 */

const CREDS = {
  [ENV.apiId]: "1234567",
  [ENV.apiHash]: "0123456789abcdef0123456789abcdef",
  [ENV.stringSession]: "1BQANOTEyMDk3AAAAAAAAAAAAA-fake-session-string-fixture",
};

/** `assert.throws` asserts and returns nothing; these tests read the message. */
function thrownBy(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected a ConfigError, and nothing was thrown");
}

test("names every missing variable, and says where the values come from", () => {
  assert.deepEqual(missingCredentials({}), [
    ENV.apiId,
    ENV.apiHash,
    ENV.stringSession,
  ]);

  const err = thrownBy(() => loadConfig({}));
  assert.ok(err instanceof ConfigError);
  for (const name of Object.values(ENV)) assert.match(err.message, new RegExp(name));
  assert.match(err.message, /my\.telegram\.org/);
  // The reason a bot token is not an option travels with the error, because
  // "just use a bot token" is the wrong fix a reader would otherwise reach for.
  assert.match(err.message, /Bot API cannot read a group's history/);
});

test("one missing variable is reported as the one that is missing", () => {
  const env = { ...CREDS };
  delete env[ENV.stringSession];
  assert.deepEqual(missingCredentials(env), [ENV.stringSession]);
  const err = thrownBy(() => loadConfig(env));
  assert.ok(err instanceof ConfigError);
  assert.match(err.message, /TELEGRAM_STRING_SESSION is not set/);
  // Blank is missing: an App Platform variable that exists and is empty is the
  // shape a half-finished secret takes.
  assert.deepEqual(missingCredentials({ ...CREDS, [ENV.apiHash]: "   " }), [
    ENV.apiHash,
  ]);
});

test("a swapped id/hash pair is caught by name", () => {
  const err = thrownBy(() => loadConfig({ ...CREDS, [ENV.apiId]: "0123456789abcdef" }));
  assert.ok(err instanceof ConfigError);
  assert.match(err.message, /not a positive integer/);
  assert.match(err.message, /not the api hash/);
});

test("with no credentials the server still mounts and lists its tools", async () => {
  // The bundle hosts sixteen other servers in this process. A missing session
  // string must cost this server its calls, not the container its boot.
  const { server, registerHandlers } = createMCPServer({ version: "test", env: {} });
  await registerHandlers(server);
  const mcp = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(a), server.connect(b)]);

  const { tools } = await mcp.listTools();
  assert.equal(tools.length, 6);

  const res = await mcp.callTool({ name: "list_chats", arguments: {} });
  const text = res.content.map((c) => c.text).join("\n");
  assert.equal(res.isError, true);
  assert.match(text, /Telegram is not configured/);
  for (const name of Object.values(ENV)) assert.match(text, new RegExp(name));

  await Promise.all([mcp.close(), server.close()]);
});

test("a credential never survives a log line", () => {
  const line = `connected with session ${CREDS[ENV.stringSession]}`;
  assert.doesNotMatch(redact(line), /fake-session-string-fixture/);
  assert.match(redact(line), /\[redacted\]/);
  assert.equal(redact("connect failed: ECONNRESET"), "connect failed: ECONNRESET");
});
