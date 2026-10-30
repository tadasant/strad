/**
 * The per-account google-docs layer, and the cross-account trap it exists to
 * close.
 *
 * What this tests is strad's own `src/docs.ts`, not the vendored tree: the
 * injected env, the two credential modes, and the name lists the bundle host's
 * per-slug discovery keys on. It is `test/gmail.test.ts` again, deliberately —
 * google-docs has the same two auth modes on the same container, so it has the
 * same failure: an unconnected per-slug mount that inherited the bare
 * service-account names would serve a Workspace user's documents under a slug
 * named for a personal account, and every call would succeed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  OAuth2GoogleDocsClient,
  ServiceAccountGoogleDocsClient,
} from "google-docs-workspace-mcp-server-shared";
import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createDefaultClient,
  createMCPServer,
  missingCredentials,
  GOOGLE_DOCS_ENV_NAMES,
  GOOGLE_DOCS_OAUTH_APP_ENV_NAMES,
  GOOGLE_DOCS_OAUTH_ENV_NAMES,
  GOOGLE_DOCS_SERVICE_ACCOUNT_ENV_NAMES,
  type EnvLike,
} from "../src/docs.js";

/** A complete service-account credential — what the conventional /google-docs mount runs on. */
const SERVICE_ACCOUNT: EnvLike = {
  GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL: "dwd@tadasant.iam.gserviceaccount.com",
  GOOGLE_DOCS_SERVICE_ACCOUNT_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
  GOOGLE_DOCS_IMPERSONATE_EMAIL: "tadas@tadasant.com",
};

const account = (name: string): EnvLike => ({
  GOOGLE_DOCS_OAUTH_CLIENT_ID: `id-${name}`,
  GOOGLE_DOCS_OAUTH_CLIENT_SECRET: `secret-${name}`,
  GOOGLE_DOCS_OAUTH_REFRESH_TOKEN: `refresh-${name}`,
});

/** The vendored client's OAuth2Client, found by shape rather than by private name. */
const oauth2Of = (
  client: unknown,
): {
  credentials?: { refresh_token?: unknown };
  getAccessToken: () => Promise<unknown>;
} =>
  Object.values(client as Record<string, unknown>).find(
    (v) => !!v && typeof v === "object" && "credentials" in v,
  ) as never;

async function toolsOf(env: EnvLike): Promise<string[]> {
  const server = new Server(
    { name: "google-docs-workspace-mcp-server", version: "test" },
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
  assert.deepEqual(
    [...GOOGLE_DOCS_OAUTH_APP_ENV_NAMES],
    ["GOOGLE_DOCS_OAUTH_CLIENT_ID", "GOOGLE_DOCS_OAUTH_CLIENT_SECRET"],
  );
  for (const name of [
    ...GOOGLE_DOCS_OAUTH_ENV_NAMES,
    ...GOOGLE_DOCS_SERVICE_ACCOUNT_ENV_NAMES,
  ]) {
    assert.ok(
      GOOGLE_DOCS_ENV_NAMES.includes(name),
      `${name} is not in GOOGLE_DOCS_ENV_NAMES`,
    );
  }
});

test("the host's subtraction yields EVERY per-account name, service account included", () => {
  // `servers/bundle/host/src/index.ts` does exactly this, and
  // `dropInheritedNames` refuses to inherit the result.
  const app = new Set<string>(GOOGLE_DOCS_OAUTH_APP_ENV_NAMES);
  const dropped = GOOGLE_DOCS_ENV_NAMES.filter((name) => !app.has(name));

  assert.deepEqual([...dropped].sort(), [
    "GOOGLE_DOCS_IMPERSONATE_EMAIL",
    "GOOGLE_DOCS_OAUTH_REFRESH_TOKEN",
    "GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL",
    "GOOGLE_DOCS_SERVICE_ACCOUNT_PRIVATE_KEY",
  ]);
});

test("the names are the ones the vendored tree itself reads", async () => {
  // The vendored `createDefaultClient` reads `process.env` directly. If upstream
  // renamed a variable, this layer would hand the tree an env it never looks at
  // in the conventional mode, and the bundle host would discover on names no
  // config seeds. Read the tree's source rather than trusting the copy here.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../vendor/google-docs-shared/src/server.ts", import.meta.url),
    "utf8",
  );
  for (const name of GOOGLE_DOCS_ENV_NAMES)
    assert.ok(source.includes(`process.env.${name}`), `the tree does not read ${name}`);
});

test("a complete credential in EITHER mode is a working mount", () => {
  assert.deepEqual(missingCredentials(SERVICE_ACCOUNT), []);
  assert.deepEqual(missingCredentials(account("a")), []);
  assert.ok(
    createDefaultClient(SERVICE_ACCOUNT) instanceof ServiceAccountGoogleDocsClient,
  );
  assert.ok(createDefaultClient(account("a")) instanceof OAuth2GoogleDocsClient);
});

test("OAuth wins when both modes are complete, as the vendored tree decides it", () => {
  const both = { ...SERVICE_ACCOUNT, ...account("both") };
  assert.deepEqual(missingCredentials(both), []);
  assert.ok(createDefaultClient(both) instanceof OAuth2GoogleDocsClient);
});

test("an unconnected per-slug mount is told about its TOKEN, not about a service account", () => {
  const unconnected = {
    GOOGLE_DOCS_OAUTH_CLIENT_ID: "id",
    GOOGLE_DOCS_OAUTH_CLIENT_SECRET: "secret",
  };
  assert.deepEqual(missingCredentials(unconnected), [
    "GOOGLE_DOCS_OAUTH_REFRESH_TOKEN",
  ]);
  assert.throws(() => createDefaultClient(unconnected), /has no credential/);
  assert.throws(
    () => createDefaultClient(unconnected),
    /GOOGLE_DOCS_OAUTH_REFRESH_TOKEN/,
  );
});

test("a mount with nothing at all is told about the conventional mode", () => {
  assert.deepEqual(missingCredentials({}), [
    ...GOOGLE_DOCS_SERVICE_ACCOUNT_ENV_NAMES,
  ]);
  assert.throws(() => createDefaultClient({}), /has no credential/);
});

test("an EMPTY app pair is still an OAuth mount, because discovery keys on the name", () => {
  const empty = {
    GOOGLE_DOCS_OAUTH_CLIENT_ID: "",
    GOOGLE_DOCS_OAUTH_CLIENT_SECRET: "",
  };
  assert.deepEqual(missingCredentials(empty), [...GOOGLE_DOCS_OAUTH_ENV_NAMES]);
  assert.throws(() => createDefaultClient(empty), /has no credential/);
});

test("THE TRAP: the app pair beside a bare service account is a WORKING wrong Drive", () => {
  // What an unconnected `google-docs-tadas412-ro` would be without the drop:
  // `missingCredentials` reports nothing wrong and the client is real.
  const inherited = {
    ...SERVICE_ACCOUNT,
    GOOGLE_DOCS_OAUTH_CLIENT_ID: "seeded-by-the-connector",
    GOOGLE_DOCS_OAUTH_CLIENT_SECRET: "seeded-by-the-connector",
  };
  assert.deepEqual(missingCredentials(inherited), []);
  assert.ok(
    createDefaultClient(inherited) instanceof ServiceAccountGoogleDocsClient,
  );

  // And the mount the host actually builds, after `dropInheritedNames`.
  const app = new Set<string>(GOOGLE_DOCS_OAUTH_APP_ENV_NAMES);
  const afterDrop: Record<string, string | undefined> = { ...inherited };
  for (const name of GOOGLE_DOCS_ENV_NAMES.filter((n) => !app.has(n)))
    delete afterDrop[name];

  assert.deepEqual(missingCredentials(afterDrop), [
    "GOOGLE_DOCS_OAUTH_REFRESH_TOKEN",
  ]);
  assert.throws(
    () => createDefaultClient(afterDrop),
    /GOOGLE_DOCS_OAUTH_REFRESH_TOKEN/,
  );
});

test("two slugs in one process hold two different accounts", () => {
  const a = createDefaultClient(account("a"));
  const b = createDefaultClient(account("b"));
  assert.notEqual(a, b);
  assert.equal(oauth2Of(a).credentials?.refresh_token, "refresh-a");
  assert.equal(oauth2Of(b).credentials?.refresh_token, "refresh-b");
});

test("two slugs holding one token get their own client, so the reconnect link is theirs", () => {
  const shared = account("shared");
  const ro = createDefaultClient({
    ...shared,
    GOOGLE_DOCS_RECONNECT_URL: "https://strad.example/ui/google-docs-x-ro",
  });
  const rw = createDefaultClient({
    ...shared,
    GOOGLE_DOCS_RECONNECT_URL: "https://strad.example/ui/google-docs-x-rw",
  });
  assert.notEqual(ro, rw);
});

test("one account is one client, so its access token outlives a single request", () => {
  assert.equal(createDefaultClient(account("a")), createDefaultClient(account("a")));
  assert.notEqual(createDefaultClient(account("a")), createDefaultClient(account("c")));
  assert.equal(
    createDefaultClient(SERVICE_ACCOUNT),
    createDefaultClient({ ...SERVICE_ACCOUNT }),
  );
});

test("a mount lists all thirteen tools, and lists them with no credential at all", async () => {
  assert.deepEqual(await toolsOf({}), [
    "add_comment",
    "append_text",
    "create_document",
    "delete_document",
    "export_document",
    "get_document",
    "get_document_outline",
    "insert_text",
    "list_comments",
    "replace_text",
    "reply_to_comment",
    "share_document",
    "update_document",
  ]);
});

test("GOOGLE_DOCS_ENABLED_TOOLGROUPS comes from the injected env, per mount", async () => {
  const readonlyTools = await toolsOf({
    GOOGLE_DOCS_ENABLED_TOOLGROUPS: "readonly",
  });
  assert.deepEqual(readonlyTools, [
    "export_document",
    "get_document",
    "get_document_outline",
    "list_comments",
  ]);
  assert.notDeepEqual(readonlyTools, await toolsOf({}));

  // readwrite withholds share_document, the one tool that grants someone else
  // access — which is what the rw-external tier exists to hold alone.
  const rw = await toolsOf({ GOOGLE_DOCS_ENABLED_TOOLGROUPS: "readwrite" });
  assert.equal(rw.length, 12);
  assert.ok(!rw.includes("share_document"));
});

test("an expired token names the slug's console page", async () => {
  const client = createDefaultClient({
    ...account("expiring"),
    GOOGLE_DOCS_RECONNECT_URL: "https://strad.example/ui/google-docs-tadas412-ro",
  });
  oauth2Of(client).getAccessToken = () =>
    Promise.reject(new Error("invalid_grant: Token has been expired or revoked."));

  await assert.rejects(client.getDocument("doc"), (error: Error) => {
    assert.match(error.message, /invalid_grant/);
    assert.match(
      error.message,
      /https:\/\/strad\.example\/ui\/google-docs-tadas412-ro/,
    );
    assert.match(error.message, /Reconnect Google/);
    return true;
  });
});

test("any other refresh failure passes through untouched", async () => {
  const client = createDefaultClient(account("networky"));
  oauth2Of(client).getAccessToken = () => Promise.reject(new Error("ETIMEDOUT"));

  await assert.rejects(client.getDocument("doc"), (error: Error) => {
    assert.equal(error.message, "ETIMEDOUT");
    return true;
  });
});
