/**
 * The per-account gmail layer, and the cross-account trap it exists to close.
 *
 * This suite lives at the image root because what it tests is strad's own
 * `src/gmail.ts`, not the gmail tree (a fork; see `vendor/gmail-shared/FORK.md`) —
 * the injected env, the two credential modes, and the name lists the bundle
 * host's per-slug discovery keys on.
 *
 * THE FAILURE IT IS ABOUT is not "a mount with no token fails". It is a mount
 * with no token that SUCCEEDS, against the wrong mailbox: gmail is the one
 * server in this image with two auth modes, both of them present on one
 * container, and an unconnected per-slug mount that inherited the bare
 * service-account names would serve a Workspace mailbox under a slug named for
 * a personal account. Nothing about that reads as broken — the tools list, the
 * calls succeed, the console page says "not connected".
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  OAuth2GmailClient,
  ServiceAccountGmailClient,
} from "gmail-workspace-mcp-server-shared";
import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createDefaultClient,
  createMCPServer,
  missingCredentials,
  GMAIL_ENV_NAMES,
  GMAIL_OAUTH_APP_ENV_NAMES,
  GMAIL_OAUTH_ENV_NAMES,
  GMAIL_SERVICE_ACCOUNT_ENV_NAMES,
  type EnvLike,
} from "../src/gmail.js";

/** A complete service-account credential — what the conventional /gmail mount runs on. */
const SERVICE_ACCOUNT: EnvLike = {
  GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL: "dwd@tadasant.iam.gserviceaccount.com",
  GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
  GMAIL_IMPERSONATE_EMAIL: "tadas@tadasant.com",
};

const account = (name: string): EnvLike => ({
  GMAIL_OAUTH_CLIENT_ID: `id-${name}`,
  GMAIL_OAUTH_CLIENT_SECRET: `secret-${name}`,
  GMAIL_OAUTH_REFRESH_TOKEN: `refresh-${name}`,
});

/** The refresh token a client was built with, read off its OAuth2 client. */
const refreshTokenOf = (client: unknown): unknown =>
  (
    Object.values(client as Record<string, unknown>).find(
      (v): v is { credentials?: { refresh_token?: unknown } } =>
        !!v && typeof v === "object" && "credentials" in v,
    )?.credentials ?? {}
  ).refresh_token;

async function toolsOf(env: EnvLike): Promise<string[]> {
  const server = new Server(
    { name: "gmail-workspace-mcp-server", version: "test" },
    { capabilities: { tools: {} } },
  );
  await createMCPServer({ version: "test", env }).registerHandlers(server);

  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

test("the env lists span BOTH auth modes, and the marker pair is neither account", () => {
  // The bundle host discovers a per-slug mount on the app pair alone, so that an
  // unconnected slug still mounts and lists its tools. They are a marker set,
  // not a credential.
  assert.deepEqual(
    [...GMAIL_OAUTH_APP_ENV_NAMES],
    ["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET"],
  );
  assert.ok(!GMAIL_OAUTH_APP_ENV_NAMES.includes("GMAIL_OAUTH_REFRESH_TOKEN"));

  // GMAIL_ENV_NAMES is not "what one mount needs" — no mount needs all six. It
  // is what the host subtracts the marker pair from, so it has to name every
  // variable that decides which mailbox is read, in either mode.
  for (const name of [...GMAIL_OAUTH_ENV_NAMES, ...GMAIL_SERVICE_ACCOUNT_ENV_NAMES]) {
    assert.ok(GMAIL_ENV_NAMES.includes(name), `${name} is not in GMAIL_ENV_NAMES`);
  }
});

test("the host's subtraction yields EVERY per-account name, service account included", () => {
  // This is the line the whole feature turns on, reproduced here because it is
  // the tree's two lists that decide it. `servers/bundle/host/src/index.ts` does
  // exactly this, and `dropInheritedNames` refuses to inherit the result.
  const app = new Set<string>(GMAIL_OAUTH_APP_ENV_NAMES);
  const dropped = GMAIL_ENV_NAMES.filter((name) => !app.has(name));

  assert.deepEqual([...dropped].sort(), [
    "GMAIL_IMPERSONATE_EMAIL",
    "GMAIL_OAUTH_REFRESH_TOKEN",
    "GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL",
    "GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY",
  ]);
});

test("a complete credential in EITHER mode is a working mount", () => {
  assert.deepEqual(missingCredentials(SERVICE_ACCOUNT), []);
  assert.deepEqual(missingCredentials(account("a")), []);
  assert.ok(createDefaultClient(SERVICE_ACCOUNT) instanceof ServiceAccountGmailClient);
  assert.ok(createDefaultClient(account("a")) instanceof OAuth2GmailClient);
});

test("OAuth wins when both modes are complete, as the vendored tree decides it", () => {
  const both = { ...SERVICE_ACCOUNT, ...account("both") };
  assert.deepEqual(missingCredentials(both), []);
  assert.ok(createDefaultClient(both) instanceof OAuth2GmailClient);
});

test("an unconnected per-slug mount is told about its TOKEN, not about a service account", () => {
  // The state every `oauth:` slug deploys in: the app pair injected, the token
  // not yet minted because the console page that mints it is this mount.
  const unconnected = {
    GMAIL_OAUTH_CLIENT_ID: "id",
    GMAIL_OAUTH_CLIENT_SECRET: "secret",
  };
  assert.deepEqual(missingCredentials(unconnected), ["GMAIL_OAUTH_REFRESH_TOKEN"]);
  assert.throws(() => createDefaultClient(unconnected), /has no credential/);
  assert.throws(() => createDefaultClient(unconnected), /GMAIL_OAUTH_REFRESH_TOKEN/);
});

test("a mount with nothing at all is told about the conventional mode", () => {
  assert.deepEqual(missingCredentials({}), [...GMAIL_SERVICE_ACCOUNT_ENV_NAMES]);
  assert.throws(() => createDefaultClient({}), /has no credential/);
});

test("an EMPTY app pair is still an OAuth mount, because discovery keys on the name", () => {
  // `slugsWithPrefixedNames` walks `Object.keys`, so a slug seeded
  // `..__GMAIL_OAUTH_CLIENT_ID=""` gets a mount. Deciding the mode on
  // truthiness would then call that mount service-account and tell an operator
  // to seed the three variables it is specifically forbidden to use. The mode
  // is decided on presence; usability is still decided on the value, so all
  // three OAuth names are correctly reported missing.
  const empty = { GMAIL_OAUTH_CLIENT_ID: "", GMAIL_OAUTH_CLIENT_SECRET: "" };

  assert.deepEqual(missingCredentials(empty), [...GMAIL_OAUTH_ENV_NAMES]);
  for (const name of GMAIL_SERVICE_ACCOUNT_ENV_NAMES) {
    assert.ok(
      !missingCredentials(empty).includes(name),
      `${name} belongs to the conventional mount and must not be suggested here`,
    );
  }
  assert.throws(() => createDefaultClient(empty), /has no credential/);
});

test("THE TRAP: the app pair beside a bare service account is a WORKING wrong mailbox", () => {
  // Left in place, this is what an unconnected `gmail-personal-ro` would be. The
  // point of asserting it is that the failure is silent — `missingCredentials`
  // reports nothing wrong and the client is real. Sheets cannot express this
  // bug; it has one auth mode and its fallback is at worst another spreadsheets
  // token. Gmail's fallback is a different PERSON.
  const inherited = { ...SERVICE_ACCOUNT, ...GMAIL_OAUTH_APP_ENV_NAMES.reduce<Record<string, string>>(
    (acc, name) => ({ ...acc, [name]: "seeded-by-the-connector" }),
    {},
  ) };
  assert.deepEqual(missingCredentials(inherited), []);
  assert.ok(createDefaultClient(inherited) instanceof ServiceAccountGmailClient);

  // And this is the mount the host actually builds: `dropInheritedNames` has
  // removed every name in the subtraction above, so what is left is the marker
  // pair alone — degraded, naming the token, serving nobody's mailbox.
  const app = new Set<string>(GMAIL_OAUTH_APP_ENV_NAMES);
  const afterDrop: Record<string, string | undefined> = { ...inherited };
  for (const name of GMAIL_ENV_NAMES.filter((n) => !app.has(n)))
    delete afterDrop[name];

  assert.deepEqual(missingCredentials(afterDrop), ["GMAIL_OAUTH_REFRESH_TOKEN"]);
  assert.throws(() => createDefaultClient(afterDrop), /GMAIL_OAUTH_REFRESH_TOKEN/);
});

test("two slugs in one process hold two different accounts", () => {
  // The whole reason the env is injected rather than read from process.env: the
  // bundle mounts this server once per slug, and each slug is one Google
  // account. Asserting the objects merely differ would pass for any two
  // constructions — what matters is that they carry different refresh tokens.
  const a = createDefaultClient(account("a"));
  const b = createDefaultClient(account("b"));

  assert.notEqual(a, b);
  assert.equal(refreshTokenOf(a), "refresh-a");
  assert.equal(refreshTokenOf(b), "refresh-b");
});

test("two slugs holding one token get their own client, so the reconnect link is theirs", () => {
  // Not a credential, and in the cache key anyway. A human who copies one
  // refresh token between a `-ro` and a `-rw` slug rather than consenting twice
  // would otherwise have both mounts share a client — and whichever one hit
  // `invalid_grant` would name the OTHER slug's Reconnect button, which rotates
  // the other slug's parameter and leaves this one dead.
  const shared = account("shared");
  const ro = createDefaultClient({
    ...shared,
    GMAIL_RECONNECT_URL: "https://strad.example/ui/gmail-x-ro",
  });
  const rw = createDefaultClient({
    ...shared,
    GMAIL_RECONNECT_URL: "https://strad.example/ui/gmail-x-rw",
  });

  assert.notEqual(ro, rw);
  assert.equal(refreshTokenOf(ro), "refresh-shared");
  assert.equal(refreshTokenOf(rw), "refresh-shared");
});

test("one account is one client, so its access token outlives a single request", () => {
  // Both hosts build a fresh Server per HTTP request. A client built per call
  // would throw away its token cache every time and re-authenticate to Google on
  // every single tool call.
  assert.equal(createDefaultClient(account("a")), createDefaultClient(account("a")));
  assert.notEqual(createDefaultClient(account("a")), createDefaultClient(account("c")));
  assert.equal(
    createDefaultClient(SERVICE_ACCOUNT),
    createDefaultClient({ ...SERVICE_ACCOUNT }),
  );
});

test("a mount lists all nine tools, and lists them with no credential at all", async () => {
  // Credential-free boot is the property the whole image is built on, and it is
  // what lets an unconnected slug show a console page with a Connect button.
  const all = await toolsOf({});
  assert.deepEqual(all, [
    "change_email_conversation",
    "delete_draft_email",
    "download_email_attachments",
    "get_email_conversation",
    "list_draft_emails",
    "list_email_conversations",
    "search_email_conversations",
    "send_email",
    "upsert_draft_email",
  ]);
});

test("GMAIL_ENABLED_TOOLGROUPS comes from the injected env, per mount", async () => {
  // Read from `process.env` it would be one answer for every mount in the
  // process — the exact failure the injected env exists to prevent, arriving
  // through capability instead of through credentials. The collapsed bundle
  // scrubs this variable entirely (capability is the gateway's job there); the
  // standalone bundle-google image, which does not scrub, still honours it.
  const readonlyTools = await toolsOf({ GMAIL_ENABLED_TOOLGROUPS: "readonly" });
  assert.deepEqual(readonlyTools, [
    "download_email_attachments",
    "get_email_conversation",
    "list_draft_emails",
    "list_email_conversations",
    "search_email_conversations",
  ]);

  // Two instances, one process, two answers — the assertion that would fail if
  // the toggle were read from the global instead of from each mount's own env.
  assert.notDeepEqual(readonlyTools, await toolsOf({}));

  // readwrite adds the three mailbox writes and still withholds send_email, which
  // is the tier that can act on someone outside the org.
  const rw = await toolsOf({ GMAIL_ENABLED_TOOLGROUPS: "readwrite" });
  assert.ok(rw.includes("upsert_draft_email"));
  assert.ok(rw.includes("delete_draft_email"));
  assert.ok(!rw.includes("send_email"));
});

test("an expired token names the slug's console page, not an OAuth Playground", async () => {
  // `invalid_grant` is the normal end of a refresh token's life — seven days for
  // an app still in "testing", or any password change — and strad's recovery is
  // one button on this slug's own page. The vendored class has no way to say so,
  // which is why this layer subclasses it: the mailbox choice is strad's, and
  // it stays out of the tree.
  const client = createDefaultClient({
    ...account("expiring"),
    GMAIL_RECONNECT_URL: "https://strad.example/ui/gmail-personal-ro",
  });
  const oauth2 = Object.values(client as Record<string, unknown>).find(
    (v): v is { getAccessToken: () => Promise<unknown> } =>
      !!v && typeof v === "object" && "credentials" in v,
  )!;
  oauth2.getAccessToken = () =>
    Promise.reject(new Error("invalid_grant: Token has been expired or revoked."));

  await assert.rejects(client.listMessages(), (error: Error) => {
    assert.match(error.message, /invalid_grant/);
    assert.match(error.message, /https:\/\/strad\.example\/ui\/gmail-personal-ro/);
    assert.match(error.message, /Reconnect Google/);
    return true;
  });
});

test("any other refresh failure passes through untouched", async () => {
  // Only `invalid_grant` means "a human must re-consent". Wrapping a network
  // blip in that advice would send someone to a consent screen for an outage.
  const client = createDefaultClient(account("networky"));
  const oauth2 = Object.values(client as Record<string, unknown>).find(
    (v): v is { getAccessToken: () => Promise<unknown> } =>
      !!v && typeof v === "object" && "credentials" in v,
  )!;
  oauth2.getAccessToken = () => Promise.reject(new Error("ETIMEDOUT"));

  await assert.rejects(client.listMessages(), (error: Error) => {
    assert.equal(error.message, "ETIMEDOUT");
    return true;
  });
});
