import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMCPServer, toolDefinitions, UploadLeaseStore } from "../build/index.js";
import { FakeStore } from "./fake-store.mjs";

/**
 * These drive the server through a REAL MCP client over an in-memory transport —
 * the same path an agent takes — against a fake store.
 *
 * The claims under test:
 *   1. `is_sensitive` decides the KIND of link, and the sensitive one requires a
 *      sign-in and never expires.
 *   2. The default is non-sensitive with a 14-day signed link, and the caller can
 *      adjust the life.
 *   3. `refresh_link` mints a working link for an artifact whose link expired,
 *      without changing the artifact.
 *   4. The tool surface steers AWAY from `is_sensitive` in the copy an agent reads.
 */

async function connect(store, options = {}) {
  const { server, registerHandlers } = createMCPServer({
    version: "test",
    storeFactory: () => store,
    ...options,
  });
  await registerHandlers(server);
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

const call = async (client, name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.map((c) => c.text).join("\n");
  return { isError: res.isError === true, text, json: safeJson(text) };
};

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const b64 = (s) => Buffer.from(s).toString("base64");

test("tools/list exposes the seven tools with their annotations", async () => {
  const { client, close } = await connect(new FakeStore());
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "delete_file",
      "download_file",
      "get_upload_url",
      "list_files",
      "refresh_link",
      "set_sensitivity",
      "upload_file",
    ],
  );
  assert.equal(tools.find((t) => t.name === "delete_file").annotations.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === "refresh_link").annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "get_upload_url").annotations.openWorldHint, true);
  await close();
});

test("a default upload is non-sensitive, signed, and lasts 14 days", async () => {
  const store = new FakeStore();
  const { client, close } = await connect(store);
  const { json, isError } = await call(client, "upload_file", {
    source: b64("hello"),
    path: "shots/one.png",
    content_type: "image/png",
  });
  assert.equal(isError, false);
  assert.equal(json.access, "link");
  assert.equal(json.requires_sign_in, false);
  assert.equal(json.signing_version, "v2", "14 days exceeds V4's ceiling");
  const days = (Date.parse(json.expires_at) - store.now) / 86_400_000;
  assert.equal(days, 14);
  assert.equal(json.viewer_domain, undefined, "a shared artifact has no viewer domain");
  await close();
});

test("expires_in_days is adjustable, and 7 days or less stays on V4", async () => {
  const store = new FakeStore();
  const { client, close } = await connect(store);
  const short = await call(client, "upload_file", {
    source: b64("x"),
    path: "a.txt",
    expires_in_days: 3,
  });
  assert.equal(short.json.signing_version, "v4");
  assert.equal((Date.parse(short.json.expires_at) - store.now) / 86_400_000, 3);

  const long = await call(client, "upload_file", {
    source: b64("x"),
    path: "b.txt",
    expires_in_days: 90,
  });
  assert.equal(long.json.signing_version, "v2");
  assert.equal((Date.parse(long.json.expires_at) - store.now) / 86_400_000, 90);
  await close();
});

test("is_sensitive: true returns a sign-in link that does not expire", async () => {
  const { client, close } = await connect(new FakeStore({ viewerDomain: "tadasant.com" }));
  const { json } = await call(client, "upload_file", {
    source: b64("secret"),
    path: "net-worth.png",
    is_sensitive: true,
    expires_in_days: 3,
  });
  assert.equal(json.access, "restricted");
  assert.equal(json.requires_sign_in, true);
  assert.equal(json.expires_at, null, "expiry is meaningless when access is identity-gated");
  assert.equal(json.signing_version, null, "a restricted link carries no signature");
  assert.equal(json.viewer_domain, "tadasant.com");
  assert.match(json.url, /^https:\/\/storage\.cloud\.google\.com\//);
  await close();
});

test("a sensitive upload fails loudly when no viewer domain is configured", async () => {
  const { client, close } = await connect(new FakeStore({ viewerDomain: undefined }));
  const { isError, text } = await call(client, "upload_file", {
    source: b64("secret"),
    is_sensitive: true,
  });
  assert.equal(isError, true);
  assert.match(text, /viewer domain/i);
  await close();
});

test("get_upload_url returns a short-lived curlable POST target", async () => {
  const store = new FakeStore();
  const leases = new UploadLeaseStore({
    slug: "remote-filesystem-tmp-public",
    uploadBaseUrl: "https://strad.example",
    now: () => store.now,
  });
  const { client, close } = await connect(store, { uploadLeases: leases });
  const { json, isError } = await call(client, "get_upload_url", {
    path: "shots/big.png",
    content_type: "image/png",
    expires_in_days: 3,
    upload_url_expires_in_minutes: 5,
  });
  assert.equal(isError, false);
  assert.match(
    json.upload_url,
    /^https:\/\/strad\.example\/mcp-upload\/remote-filesystem-tmp-public\//,
  );
  assert.equal(json.method, "POST");
  assert.equal(json.headers["content-type"], "image/png");
  assert.match(json.curl, /--data-binary @\/path\/to\/file/);
  assert.equal((Date.parse(json.expires_at) - store.now) / 60_000, 5);
  await close();
});

test("a temporary upload URL stores bytes once and returns the artifact link", async () => {
  const store = new FakeStore();
  const created = createMCPServer({
    version: "test",
    storeFactory: () => store,
    uploadLeases: new UploadLeaseStore({
      slug: "remote-filesystem-tmp-public",
      now: () => store.now,
    }),
  });

  const lease = created.uploadLeases.create(
    {
      path: "shots/from-post.txt",
      content_type: "text/plain",
      expires_in_days: 7,
    },
    store.defaultLinkDays(),
  );
  const token = lease.upload_url.split("/").pop();
  const uploaded = await created.handleUpload(token, Buffer.from("hello from curl"));
  const body = JSON.parse(uploaded.content[0].text);
  assert.equal(uploaded.isError, undefined);
  assert.equal(body.path, "shots/from-post.txt");
  assert.equal(body.size_bytes, 15);
  assert.equal(body.content_type, "text/plain");
  assert.equal(store.objects.get("shots/from-post.txt").buffer.toString(), "hello from curl");

  const replay = await created.handleUpload(token, Buffer.from("again"));
  assert.equal(replay.isError, true);
  assert.match(replay.content[0].text, /missing or expired/);
});

test("refresh_link revives an expired link without touching the artifact", async () => {
  const store = new FakeStore();
  store.seed("screenshots/8379/v1-kpi-dashboard.png", { body: "png-bytes" });
  const { client, close } = await connect(store);

  const { json, isError } = await call(client, "refresh_link", {
    path: "screenshots/8379/v1-kpi-dashboard.png",
    expires_in_days: 30,
  });
  assert.equal(isError, false);
  assert.equal(json.path, "screenshots/8379/v1-kpi-dashboard.png");
  assert.equal(json.access, "link");
  assert.equal((Date.parse(json.expires_at) - store.now) / 86_400_000, 30);
  assert.equal(store.objects.get("screenshots/8379/v1-kpi-dashboard.png").access, "link");
  await close();
});

test("refresh_link on a restricted artifact returns its sign-in link, not a signature", async () => {
  const store = new FakeStore({ viewerDomain: "tadasant.com" });
  store.seed("secrets/exposure.png", { access: "restricted" });
  const { client, close } = await connect(store);
  const { json } = await call(client, "refresh_link", {
    path: "secrets/exposure.png",
    expires_in_days: 1,
  });
  assert.equal(json.requires_sign_in, true);
  assert.equal(json.expires_at, null);
  await close();
});

test("refresh_link on a missing path points at list_files", async () => {
  const { client, close } = await connect(new FakeStore());
  const { isError, text } = await call(client, "refresh_link", { path: "nope.png" });
  assert.equal(isError, true);
  assert.match(text, /list_files/);
  await close();
});

test("set_sensitivity restricts an artifact that was already shared", async () => {
  const store = new FakeStore({ viewerDomain: "tadasant.com" });
  store.seed("oops/balances.png");
  const { client, close } = await connect(store);

  const { json } = await call(client, "set_sensitivity", {
    path: "oops/balances.png",
    is_sensitive: true,
  });
  assert.equal(json.access, "restricted");
  assert.equal(json.requires_sign_in, true);

  const back = await call(client, "set_sensitivity", {
    path: "oops/balances.png",
    is_sensitive: false,
  });
  assert.equal(back.json.access, "link");
  assert.equal(back.json.requires_sign_in, false);
  await close();
});

test("set_sensitivity warns when the object is world-readable from an old grant", async () => {
  const store = new FakeStore();
  store.seed("legacy/public.png", { access: "public" });
  const { client, close } = await connect(store);
  const { json } = await call(client, "set_sensitivity", {
    path: "legacy/public.png",
    is_sensitive: false,
  });
  assert.equal(json.access, "public");
  assert.match(json.warning, /allUsers/);
  await close();
});

test("list_files walks one level and omits links", async () => {
  const store = new FakeStore();
  store.seed("screenshots/8379/a.png");
  store.seed("screenshots/8379/b.png");
  store.seed("screenshots/other/c.png");
  const { client, close } = await connect(store);

  const top = await call(client, "list_files", { prefix: "screenshots" });
  assert.deepEqual(top.json.directories.sort(), ["screenshots/8379", "screenshots/other"]);
  assert.equal(top.json.count, 0);

  const inner = await call(client, "list_files", { prefix: "screenshots/8379" });
  assert.equal(inner.json.count, 2);
  assert.equal(inner.json.files[0].url, undefined, "a listing carries no links");
  await close();
});

test("download_file returns text, or base64 when asked", async () => {
  const store = new FakeStore();
  store.seed("reports/summary.txt", { body: "Total: 412 rows processed\n" });
  const { client, close } = await connect(store);

  const text = await call(client, "download_file", { path: "reports/summary.txt" });
  assert.equal(text.json.encoding, "utf-8");
  assert.equal(text.json.content, "Total: 412 rows processed\n");
  assert.equal(text.json.truncated, false);

  const binary = await call(client, "download_file", {
    path: "reports/summary.txt",
    as_base64: true,
  });
  assert.equal(binary.json.encoding, "base64");
  assert.equal(Buffer.from(binary.json.content, "base64").toString(), "Total: 412 rows processed\n");
  await close();
});

test("delete_file removes the object", async () => {
  const store = new FakeStore();
  store.seed("junk.png");
  const { client, close } = await connect(store);
  const { json } = await call(client, "delete_file", { path: "junk.png" });
  assert.equal(json.deleted, true);
  assert.equal(store.objects.has("junk.png"), false);
  await close();
});

test("the readonly group withholds every mutating tool", async () => {
  const { client, close } = await connect(new FakeStore(), { toolGroups: ["readonly"] });
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["download_file", "list_files", "refresh_link"],
  );
  await close();
});

test("the is_sensitive copy steers away from itself, identically in both tools", async () => {
  const store = new FakeStore();
  const definitions = toolDefinitions(
    () => store,
    new UploadLeaseStore({ slug: "remote-filesystem-tmp-public" }),
  );
  const upload = definitions.find((t) => t.name === "upload_file");
  const set = definitions.find((t) => t.name === "set_sensitivity");

  const uploadCopy = upload.inputSchema.properties.is_sensitive.description;
  assert.equal(uploadCopy, set.inputSchema.properties.is_sensitive.description);
  assert.match(uploadCopy, /Default: false/);
  assert.match(uploadCopy, /LEAVE THIS FALSE/);
  // The concrete examples Tadas asked to be steered by.
  assert.match(uploadCopy, /net worth/i);
  assert.match(uploadCopy, /security findings/i);
  assert.match(uploadCopy, /screenshots/i);
  assert.equal(upload.inputSchema.properties.is_sensitive.default, false);
});

test("every tool description carries the sections the house style requires", () => {
  const definitions = toolDefinitions(
    () => new FakeStore(),
    new UploadLeaseStore({ slug: "remote-filesystem-tmp-public" }),
  );
  for (const tool of definitions) {
    assert.ok(tool.name.length <= 25, `${tool.name} is too long`);
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} is not snake_case`);
    assert.ok(
      !tool.name.startsWith("remote_") && !tool.name.startsWith("file_"),
      `${tool.name} carries a server prefix`,
    );
    assert.match(tool.description, /\*\*Use cases:\*\*/, `${tool.name} lists no use cases`);
    assert.ok(
      tool.description.split("\n").length >= 8,
      `${tool.name}'s description is too thin`,
    );
    for (const [param, schema] of Object.entries(tool.inputSchema.properties)) {
      assert.ok(
        typeof schema.description === "string" && schema.description.length > 40,
        `${tool.name}.${param} has a thin description`,
      );
    }
  }
});
