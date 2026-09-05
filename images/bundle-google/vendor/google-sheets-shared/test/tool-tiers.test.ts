/**
 * The tier lists, and the credential.
 *
 * READ_TOOLS is what a strad `google-sheets-*-ro` slug's `tools: allow:` has to
 * contain, and that config lives in ANOTHER REPOSITORY. An allow-list is
 * exhaustive and fail-closed, so a tool added here without a tier decision either
 * silently joins the read tier (if someone copies the wrong list) or is
 * unreachable from every slug. This is the test that makes that a CI failure
 * instead.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  READ_TOOLS,
  WRITE_TOOLS,
  toolNames,
  missingCredentials,
  createDefaultClient,
  GOOGLE_SHEETS_ENV_NAMES,
} from "../src/index.js";

test("every registered tool is in exactly one tier", () => {
  const registered = toolNames().sort();
  const tiered = [...READ_TOOLS, ...WRITE_TOOLS].sort();
  assert.deepEqual(registered, tiered);
  assert.equal(new Set(tiered).size, tiered.length);
});

test("the read tier is the four tools that cannot change a spreadsheet", () => {
  assert.deepEqual([...READ_TOOLS], [
    "get_spreadsheet",
    "get_sheet_values",
    "batch_get_sheet_values",
    "find_in_spreadsheet",
  ]);
});

test("the write tier can edit a sheet but cannot destroy one", () => {
  assert.deepEqual([...WRITE_TOOLS], [
    "update_sheet_values",
    "append_sheet_rows",
    "clear_sheet_values",
    "add_sheet",
  ]);
  // No delete_sheet, no delete_spreadsheet, no share tool: this server asks for
  // no Drive scope, so file-level and permission operations are out of reach by
  // construction rather than by policy.
  for (const name of toolNames()) {
    assert.doesNotMatch(name, /^(delete|share|create_spreadsheet)/);
  }
});

test("a mount with no credential lists tools and fails calls, naming what is missing", () => {
  assert.deepEqual(missingCredentials({}), [...GOOGLE_SHEETS_ENV_NAMES]);
  assert.throws(() => createDefaultClient({}), /has no credential/);
  // Partial is still missing: two of three is not an account.
  assert.deepEqual(
    missingCredentials({
      GOOGLE_SHEETS_OAUTH_CLIENT_ID: "id",
      GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "secret",
    }),
    ["GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN"],
  );
});

const account = (name) => ({
  GOOGLE_SHEETS_OAUTH_CLIENT_ID: `id-${name}`,
  GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: `secret-${name}`,
  GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: `refresh-${name}`,
});

/** The refresh token a client was built with, read off its OAuth2 client. */
const credentialOf = (client) =>
  Object.values(client).find((v) => v && typeof v === "object" && "credentials" in v)
    ?.credentials?.refresh_token;

test("two slugs in one process hold two different accounts", () => {
  // The whole reason the env is injected rather than read from process.env: the
  // bundle mounts this server once per slug, and each slug is one Google account.
  // Asserting the objects merely differ would pass for any two constructions —
  // what matters is that they carry different refresh tokens.
  const a = createDefaultClient(account("a"));
  const b = createDefaultClient(account("b"));

  assert.notEqual(a, b);
  assert.equal(credentialOf(a), "refresh-a");
  assert.equal(credentialOf(b), "refresh-b");
});

test("one account is one client, so its access token outlives a single request", () => {
  // Both hosts build a fresh Server per HTTP request. A client built per call
  // would throw away its token cache every time and re-authenticate to Google on
  // every single tool call.
  assert.equal(createDefaultClient(account("a")), createDefaultClient(account("a")));
  assert.notEqual(createDefaultClient(account("a")), createDefaultClient(account("c")));
});
