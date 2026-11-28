import { test } from "vitest";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createMCPServer,
  createUploadLeaseStore,
  DESCRIPTION_BUDGET,
  LINK_HANDLING_DESCRIPTION,
  loadConfig,
  toolDefinitions,
  UploadLeaseStore,
} from "../src/index.js";
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

/**
 * The reported bug: a correct grant, a correct URL, and a 403 anyway, because
 * the reader's browser opened it as their default Google account. Nothing about
 * that is visible server-side, so the response has to carry the explanation.
 */
test("a restricted response carries the account hint that explains a 403", async () => {
  const store = new FakeStore({
    viewerDomain: "tadasant.com",
    viewerAccount: "dana@tadasant.com",
  });
  const { client, close } = await connect(store);
  const { json } = await call(client, "upload_file", {
    source: b64("secret"),
    path: "net-worth.png",
    is_sensitive: true,
  });
  assert.equal(json.viewer_account, "dana@tadasant.com");
  assert.match(json.url, /\?authuser=dana%40tadasant\.com$/);
  assert.match(json.sign_in_hint, /dana@tadasant\.com/);
  await close();
});

test("with no configured account the hint tells the reader how to pick one", async () => {
  const { client, close } = await connect(new FakeStore({ viewerDomain: "tadasant.com" }));
  const { json } = await call(client, "upload_file", {
    source: b64("secret"),
    path: "net-worth.png",
    is_sensitive: true,
  });
  assert.equal(json.viewer_account, undefined);
  assert.ok(!json.url.includes("authuser"), "no account configured means no guess");
  assert.match(json.sign_in_hint, /authuser/);
  assert.match(json.sign_in_hint, /DEFAULT Google account/);
  await close();
});

/**
 * `access` is read off the object's ACL, not off this deployment's config, so a
 * pre-existing object with someone else's domain grant reads `restricted` on a
 * server that has no viewer domain set. The hint used to splice the missing
 * domain into a placeholder and tell the reader to paste "the viewer domain".
 */
test("the hint stays coherent for a restricted object with no viewer domain set", async () => {
  const store = new FakeStore({ viewerDomain: undefined });
  store.seed("legacy/leftover.png", { access: "restricted" });
  const { client, close } = await connect(store);
  const { json } = await call(client, "refresh_link", { path: "legacy/leftover.png" });

  assert.equal(json.access, "restricted");
  assert.ok(
    !json.sign_in_hint.includes("undefined"),
    "an unset viewer domain must not reach the reader as the string 'undefined'",
  );
  assert.ok(
    !/their-the viewer domain-address/.test(json.sign_in_hint),
    "the placeholder must not be built out of a domain that does not exist",
  );
  assert.match(json.sign_in_hint, /authuser/);
  await close();
});

test("restricted responses from every tool carry the same hint fields", async () => {
  const store = new FakeStore({
    viewerDomain: "tadasant.com",
    viewerAccount: "dana@tadasant.com",
  });
  store.seed("secrets/exposure.png", { access: "restricted" });
  const { client, close } = await connect(store);

  const refreshed = await call(client, "refresh_link", { path: "secrets/exposure.png" });
  const set = await call(client, "set_sensitivity", {
    path: "secrets/exposure.png",
    is_sensitive: true,
  });
  for (const { json } of [refreshed, set]) {
    assert.equal(json.viewer_account, "dana@tadasant.com");
    assert.match(json.url, /\?authuser=dana%40tadasant\.com$/);
    assert.match(json.sign_in_hint, /dana@tadasant\.com/);
  }
  await close();
});

test("a shared artifact carries no sign-in hint, because it needs no sign-in", async () => {
  const { client, close } = await connect(new FakeStore({ viewerDomain: "tadasant.com" }));
  const { json } = await call(client, "upload_file", { source: b64("shot"), path: "a.png" });
  assert.equal(json.access, "link");
  assert.equal(json.sign_in_hint, undefined);
  assert.equal(json.viewer_account, undefined);
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

test("get_upload_url refuses a sensitive lease up front on a uniform-access store", async () => {
  const store = new FakeStore();
  store.uniformAccess = () => true;
  const leases = new UploadLeaseStore({ slug: "remote-filesystem-tmp-public", now: () => store.now });
  const { client, close } = await connect(store, { uploadLeases: leases });
  const refused = await call(client, "get_upload_url", { path: "a.png", is_sensitive: true });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /sign-in-gated links need per-object ACLs/);
  const granted = await call(client, "get_upload_url", { path: "a.png" });
  assert.equal(granted.isError, false);
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

/**
 * The POST path is the one agents are steered towards for anything nontrivial,
 * so a sensitive artifact uploaded that way must come back with the same
 * account hint as `upload_file` — it goes through the same `store.put`, and
 * this pins that it keeps going through the same response shape.
 */
test("a sensitive POST upload returns the account hint too", async () => {
  const store = new FakeStore({
    viewerDomain: "tadasant.com",
    viewerAccount: "dana@tadasant.com",
  });
  const created = createMCPServer({
    version: "test",
    storeFactory: () => store,
    uploadLeases: new UploadLeaseStore({
      slug: "remote-filesystem-tmp-public",
      now: () => store.now,
    }),
  });

  const lease = created.uploadLeases.create(
    { path: "finances/statement.html", content_type: "text/html", is_sensitive: true },
    store.defaultLinkDays(),
  );
  const uploaded = await created.handleUpload(
    lease.upload_url.split("/").pop(),
    Buffer.from("<p>balances</p>"),
  );
  const body = JSON.parse(uploaded.content[0].text);

  assert.equal(body.access, "restricted");
  assert.equal(body.viewer_domain, "tadasant.com");
  assert.equal(body.viewer_account, "dana@tadasant.com");
  assert.match(body.url, /\?authuser=dana%40tadasant\.com$/);
  assert.match(body.sign_in_hint, /authuser/);
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

/**
 * A signed URL's query string IS the credential, and altering it fails silently
 * for the publisher. The incident this guards: a working URL published bolded in
 * markdown with everything after the `?` dropped, whose 403 was then escalated as
 * a bucket that "is not public" — a false infrastructure incident from a
 * formatting bug. The last assertion is the one that would have stopped it, so it
 * is asserted separately rather than folded into a single regex over the block.
 */
test("the three tools the guidance is written for carry it verbatim", () => {
  const definitions = toolDefinitions(
    () => new FakeStore(),
    new UploadLeaseStore({ slug: "remote-filesystem-tmp-public" }),
  );
  for (const name of ["upload_file", "get_upload_url", "refresh_link"]) {
    const definition = definitions.find((t) => t.name === name);
    assert.ok(definition, `${name} is not in the tool definitions`);
    assert.ok(
      definition.description.includes(LINK_HANDLING_DESCRIPTION),
      `${name} does not carry the link-handling guidance verbatim`,
    );
  }

  // The tools that hand back no link at all must not grow a copy — a second,
  // drifting copy is how this guidance rots. `set_sensitivity` is deliberately
  // NOT on this list: it re-links an artifact through the same artifactPayload,
  // so adding the guidance there later is a fix, not a regression, and a test
  // that forbade it would stand in the way of its own point.
  for (const name of ["list_files", "download_file", "delete_file"]) {
    const definition = definitions.find((t) => t.name === name);
    assert.ok(definition, `${name} is not in the tool definitions`);
    assert.ok(
      !/query string IS the credential/i.test(definition.description),
      `${name} hands back no link but carries the link-handling guidance`,
    );
  }
});

test("the link-handling guidance keeps the three points and the four codes", () => {
  const copy = LINK_HANDLING_DESCRIPTION;

  // 1. Verbatim: no truncation, no wrapping, no emphasis, no rebuilding from path.
  assert.match(copy, /query string IS the credential/);
  assert.match(copy, /pass the\s+URL through verbatim/);
  assert.match(copy, /`\*\*<url>\*\*` glues the trailing asterisks/);
  assert.match(copy, /`path` cannot be\s+turned back into a URL/);
  assert.match(copy, /\[text\]\(url\)/);
  assert.match(copy, /Slack renders that literally/);

  // 2. Fetch it before publishing it — the whole command, not a stray "200".
  assert.match(copy, /curl -sS -o \/dev\/null -w '%\{http_code\}' "<url>"/);
  assert.match(copy, /must\s+print `200`/);

  // 3. The codes, each observed against a production bucket. Framed on the CODE
  // because the statuses disagree: MissingSecurityHeader is a 400, not a 403.
  assert.match(copy, /Read the error code, not the status/);
  assert.match(copy, /`AccessDenied`: the request\s+carried no signature/);
  assert.match(copy, /`SignatureDoesNotMatch`: characters\s+were added or removed/);
  assert.match(copy, /`MissingSecurityHeader`: the query string was only partly kept/);
  assert.match(copy, /`ExpiredToken`: the link aged out, and refresh_link mints a fresh one/);

  // The clause that would have prevented the false incident. Do not delete it.
  assert.match(copy, /None of them\s+means the bucket is misconfigured/);

  // Scoping. Unscoped, this text contradicts sign_in_hint, which tells a reader to
  // REPLACE the ?authuser= value in a restricted URL's query string.
  assert.match(copy, /For a signed link \(`access: "link"`\)/);
  assert.match(copy, /`restricted` artifact fails differently and carries no\s+signature/);
  assert.match(copy, /`sign_in_hint` diagnoses that one/);

  // It must not name a bucket: production's ends in -public, staging's does not.
  assert.ok(
    !/-public/.test(copy),
    "the guidance names a deployment-specific bucket, and is wrong on the others",
  );
});

/**
 * A description longer than the client will show is not documentation.
 *
 * Claude Code cuts a tool description at 2048 characters and says so only in its
 * own connection log, so the server never learns. Four of these seven tools were
 * over that line, `upload_file` at 4111 characters, and what fell off was what an
 * agent reads LAST: the use cases, the link-handling guidance, "keep the path".
 * Nothing failed; the text was never delivered.
 *
 * So the budget is asserted over EVERY tool this server defines rather than the
 * four that were over it, because the way this comes back is a new tool nobody
 * measured. The room is genuinely tight — three of these carry the shared
 * link-handling block, which is half the budget on its own — so an addition here
 * costs a removal, and this test is where you find that out.
 */
test("no tool description exceeds the client's truncation budget", () => {
  const definitions = toolDefinitions(
    () => new FakeStore(),
    new UploadLeaseStore({ slug: "remote-filesystem-tmp-public" }),
  );
  assert.ok(
    definitions.length > 0,
    "toolDefinitions() returned nothing, so the budget was checked against no tools",
  );
  for (const tool of definitions) {
    assert.ok(
      tool.description.length <= DESCRIPTION_BUDGET,
      `${tool.name}'s description is ${tool.description.length} chars, ` +
        `${tool.description.length - DESCRIPTION_BUDGET} over the ${DESCRIPTION_BUDGET}-char ` +
        `budget — a client will cut the tail off it. Tighten the prose or move ` +
        `the long form to docs/servers/artifact-store.md; do not append.`,
    );
  }
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

/**
 * ONE PROCESS, TWO INSTANCES, TWO BUCKETS.
 *
 * The bundle host builds one instance of this server per strad slug and hands
 * each a view of the container's environment in which its own `<SLUG>__*` values
 * shadow the bare ones. Two things have to be true for that to mean anything: the
 * instance must read the env it was handed rather than `process.env`, and the
 * `envPrefix` must survive intact — the view falls back to BARE names, and the
 * bare `GCS_BUCKET` belongs to the `gcs` server pointing at a different bucket in
 * the same container.
 */

/** Set keys on process.env for the duration of `fn`, then put it back. */
function withProcessEnv(vars, fn) {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("config comes from the env the instance was handed, under its prefix", () => {
  withProcessEnv(
    {
      REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET: "bucket-from-the-process",
      GCS_BUCKET: "the-gcs-servers-bucket",
    },
    () => {
      // The slug-scoped view the host builds: a per-slug value shadowing the bare
      // one, exactly as slugEnvView produces it.
      const view = {
        ...process.env,
        REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET: "bucket-from-the-view",
      };
      assert.equal(
        loadConfig("REMOTE_FILESYSTEM_TMP_PUBLIC", view).bucket,
        "bucket-from-the-view",
      );
      // A second instance, its own view, its own bucket — same process.
      const other = {
        ...process.env,
        REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET: "bucket-for-the-other-slug",
      };
      assert.equal(
        loadConfig("REMOTE_FILESYSTEM_TMP_PUBLIC", other).bucket,
        "bucket-for-the-other-slug",
      );
      // And never the bare name, whatever the view says: that one is the gcs
      // server's, and reading it is the bug the prefix exists to prevent.
      assert.notEqual(
        loadConfig("REMOTE_FILESYSTEM_TMP_PUBLIC", view).bucket,
        "the-gcs-servers-bucket",
      );
    },
  );
});

test("the upload base url is read from the handed-in env too", () => {
  withProcessEnv(
    { REMOTE_FILESYSTEM_TMP_PUBLIC_UPLOAD_BASE_URL: "https://from-the-process" },
    () => {
      const leases = createUploadLeaseStore({
        slug: "remote-filesystem-archive",
        envPrefix: "REMOTE_FILESYSTEM_TMP_PUBLIC",
        env: {
          REMOTE_FILESYSTEM_TMP_PUBLIC_UPLOAD_BASE_URL: "https://from-the-view",
        },
      });
      const target = leases.create({ path: "a.txt", content_type: "text/plain" }, 14);
      assert.match(target.upload_url, /^https:\/\/from-the-view/);
      // The route carries the SLUG, so two instances mint distinguishable URLs.
      assert.match(target.upload_url, /remote-filesystem-archive/);
    },
  );
});
