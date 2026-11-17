/**
 * The tools, through a REAL MCP client, against the fake bridge process
 * (fake-bridge.mjs, the same loopback protocol as the Go program) and an
 * in-memory GCS with real generation preconditions. Nothing talks to Meta.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createMCPServer,
  loadConfig,
  MemoryBlobStore,
  missingCredentials,
  SEAL_FORMAT,
  startSidecar,
  toolNames,
  type BridgeOptions,
  type MessengerConfig,
} from "../src/index.js";
import { open as unseal } from "../src/state-store.js";

const FAKE = fileURLToPath(new URL("./fake-bridge.mjs", import.meta.url));

function config(key = randomBytes(32)): MessengerConfig {
  return {
    encryptionKey: key,
    bucket: "test-bucket",
    clientEmail: "bridge@example.iam.gserviceaccount.com",
    privateKey: "unused",
    prefix: "messenger/test",
    bufferMaxAgeDays: 30,
  };
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connect(
  options: {
    blobs?: MemoryBlobStore;
    cfg?: MessengerConfig;
    groups?: ("readonly" | "admin")[];
    bridge?: Partial<BridgeOptions>;
  } = {},
) {
  const blobs = options.blobs ?? new MemoryBlobStore();
  const created = createMCPServer({
    version: "test",
    config: options.cfg ?? config(),
    blobs,
    ...(options.groups ? { toolGroups: options.groups } : {}),
    bridgeOptions: {
      command: process.execPath,
      args: [FAKE],
      snapshotIntervalMs: 3_600_000,
      restartBaseMs: 10,
      handoffPollMs: 20,
      ...options.bridge,
    },
  });
  await created.registerHandlers(created.server);
  const mcp = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(a), created.server.connect(b)]);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await created.close();
    await mcp.close();
  };
  cleanups.push(close);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string; resource?: { blob: string } }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    return res;
  };
  const inject = async (m: Record<string, unknown>) =>
    (await created.bridge()!.client()).request("POST", "/_test/message", m);
  return { mcp, call, blobs, created, close, inject };
}

async function logIn(call: Awaited<ReturnType<typeof connect>>["call"]) {
  await call("messenger_login_start", { flow: "android" });
  await call("messenger_login_submit", { input: { username: "owner@example.com", password: "correct horse" } });
  await call("messenger_login_submit", {});
  return call("messenger_login_submit", { input: { pin: "" } });
}

describe("tool surface", () => {
  it("lists four read tools for readonly and eight for admin, and no send tool", async () => {
    expect(toolNames(["readonly"])).toEqual([
      "messenger_status",
      "messenger_list_threads",
      "messenger_get_messages",
      "messenger_get_attachment",
    ]);
    expect(toolNames()).toHaveLength(8);
    expect(toolNames().some((n) => /send/.test(n))).toBe(false);
    const { mcp } = await connect({ groups: ["readonly"] });
    const listed = (await mcp.listTools()).tools.map((t) => t.name);
    expect(listed).toEqual(toolNames(["readonly"]));
  });
});

describe("login", () => {
  it("walks the steps, never echoes a value, and saves the login at once", async () => {
    const { call, blobs } = await connect();
    const first = await call("messenger_login_start", { flow: "android" });
    expect(first.structuredContent).toMatchObject({ type: "user_input", step_id: "fi.mau.meta.messengerlite.email_password" });
    expect((first.structuredContent!.fields as unknown[]).length).toBe(2);

    const approve = await call("messenger_login_submit", { input: { username: "owner@example.com", password: "correct horse" } });
    expect(approve.structuredContent).toMatchObject({ type: "display_and_wait" });
    expect(JSON.stringify(approve)).not.toContain("correct horse");
    expect(JSON.stringify(approve)).not.toContain("owner@example.com");

    const pin = await call("messenger_login_submit", {});
    expect(pin.structuredContent).toMatchObject({ step_id: "fi.mau.meta.history_pin" });
    expect(pin.content.some((c) => c.type === "image")).toBe(true);

    const done = await call("messenger_login_submit", { input: { pin: "" } });
    expect(done.structuredContent).toMatchObject({ type: "complete", saved: true, account: { id: "100001" } });
    expect(await blobs.read("messenger/test/bridge.db.sealed")).not.toBeNull();

    const status = await call("messenger_status");
    expect(status.structuredContent).toMatchObject({ logged_in: true, connected: true });
    expect(status.structuredContent!.last_saved_at).toEqual(expect.any(String));
  });

  it("ends the login on a wrong password and refuses a second login while connected", async () => {
    const { call } = await connect();
    await call("messenger_login_start", {});
    const wrong = await call("messenger_login_submit", { input: { username: "a", password: "nope" } });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0]!.text).toContain("Incorrect password");
    const orphan = await call("messenger_login_submit", { input: {} });
    expect(orphan.content[0]!.text).toContain("messenger_login_start");

    await logIn(call);
    const again = await call("messenger_login_start", { flow: "cookies" });
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toContain("messenger_logout");
  });

  it("rejects malformed input before it reaches the bridge", async () => {
    const { call } = await connect();
    expect((await call("messenger_login_submit", { input: { password: 5 } })).content[0]!.text).toContain("must be a string");
    expect((await call("messenger_login_start", { flow: "carrier-pigeon" })).isError).toBe(true);
  });
});

describe("reading", () => {
  it("pages every thread by cursor and filters by thread and time", async () => {
    const { call, inject } = await connect();
    await logIn(call);
    const t0 = Date.parse("2026-11-16T10:00:00Z");
    for (let i = 0; i < 5; i++) {
      await inject({ thread_id: i % 2 ? "7001" : "7002", text: `m${i}`, timestamp_ms: t0 + i * 60_000 });
    }
    const first = await call("messenger_get_messages", { limit: 3 });
    const page1 = first.structuredContent as { messages: Array<Record<string, unknown>>; next_cursor: number; has_more: boolean };
    expect(page1.messages.map((m) => m.text)).toEqual(["m0", "m1", "m2"]);
    expect(page1.has_more).toBe(true);
    expect(page1.messages[0]!.timestamp).toBe("2026-11-16T10:00:00.000Z");
    expect(page1.messages[0]).not.toHaveProperty("timestamp_ms");

    const page2 = (await call("messenger_get_messages", { cursor: page1.next_cursor })).structuredContent as typeof page1;
    expect(page2.messages.map((m) => m.text)).toEqual(["m3", "m4"]);
    expect(page2.has_more).toBe(false);

    const one = (await call("messenger_get_messages", { thread_id: "7001" })).structuredContent as typeof page1;
    expect(one.messages.map((m) => m.text)).toEqual(["m1", "m3"]);
    const since = (await call("messenger_get_messages", { since: "2026-11-16T10:03:00Z" })).structuredContent as typeof page1;
    expect(since.messages.map((m) => m.text)).toEqual(["m3", "m4"]);

    const threads = (await call("messenger_list_threads", { updated_after: "2026-11-16T10:04:00Z" })).structuredContent as {
      threads: Array<Record<string, unknown>>;
    };
    expect(threads.threads.map((t) => t.id)).toEqual(["7002"]);
    expect(threads.threads[0]!.last_message_at).toBe("2026-11-16T10:04:00.000Z");

    expect((await call("messenger_get_messages", { thread_id: "nope" })).isError).toBe(true);
    expect((await call("messenger_get_messages", { since: "yesterday-ish" })).content[0]!.text).toContain("ISO 8601");
    expect((await call("messenger_get_messages", { limit: 501 })).isError).toBe(true);
  });

  it("returns an image attachment as an image and a PDF as an embedded file", async () => {
    const { call, inject } = await connect();
    await logIn(call);
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await inject({ thread_id: "7001", text: "", type: "image", timestamp_ms: 1, attachment: { name: "p.png", mime_type: "image/png", bytes: png.toString("base64") } });
    await inject({ thread_id: "7001", text: "", type: "file", timestamp_ms: 2, attachment: { name: "résumé.pdf", mime_type: "application/pdf", bytes: Buffer.from("%PDF").toString("base64") } });
    await inject({ thread_id: "7001", text: "plain", timestamp_ms: 3 });
    const img = await call("messenger_get_attachment", { message_id: "$e1" });
    expect(img.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    const pdf = await call("messenger_get_attachment", { message_id: "$e2" });
    expect(pdf.content[1]!.type).toBe("resource");
    expect(Buffer.from(pdf.content[1]!.resource!.blob, "base64").toString()).toBe("%PDF");
    expect(pdf.structuredContent).toMatchObject({ name: "résumé.pdf", size_bytes: 4 });
    const none = await call("messenger_get_attachment", { message_id: "$e3" });
    expect(none.isError).toBe(true);
  });
});

describe("state", () => {
  it("seals the snapshot under the key, restores it after a restart, and nothing is readable without the key", async () => {
    const blobs = new MemoryBlobStore();
    const cfg = config();
    const first = await connect({ blobs, cfg });
    await logIn(first.call);
    await first.inject({ thread_id: "7001", text: "remember me", timestamp_ms: 5 });
    await first.close(); // SIGTERM path: final snapshot

    const sealed = (await blobs.read("messenger/test/bridge.db.sealed"))!.data;
    expect(sealed.subarray(0, 4).toString()).toBe(SEAL_FORMAT.magic);
    expect(sealed.includes(Buffer.from("remember me"))).toBe(false);
    const plain = gunzipSync(unseal(cfg.encryptionKey, "messenger/test/bridge.db.sealed", sealed, SEAL_FORMAT)).toString();
    expect(plain).toContain("remember me");

    const second = await connect({ blobs, cfg });
    const msgs = (await second.call("messenger_get_messages")).structuredContent as { messages: Array<{ text: string }> };
    expect(msgs.messages.map((m) => m.text)).toEqual(["remember me"]);
    expect((await second.call("messenger_status")).structuredContent).toMatchObject({ logged_in: true });
    await second.close();

    const wrongKey = await connect({ blobs, cfg: config() });
    const refused = await wrongKey.call("messenger_status");
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("MESSENGER_STATE_ENCRYPTION_KEY");
  });

  it("logout deletes the saved state and leaves a fresh, logged-out bridge", async () => {
    const { call, blobs, inject } = await connect();
    await logIn(call);
    await inject({ thread_id: "7001", text: "gone soon", timestamp_ms: 5 });
    expect((await call("messenger_logout", {})).isError).toBe(true);
    const out = await call("messenger_logout", { confirm: true });
    expect(out.structuredContent).toMatchObject({ logged_out: 1, deleted: true });
    expect(await blobs.read("messenger/test/bridge.db.sealed")).toBeNull();
    const status = (await call("messenger_status")).structuredContent!;
    expect(status).toMatchObject({ logged_in: false });
    expect((await call("messenger_get_messages")).structuredContent).toMatchObject({ messages: [] });
  });

  it("a deploy hands over: the new process waits for the old one's final snapshot, then has everything", async () => {
    const blobs = new MemoryBlobStore();
    const cfg = config();
    const older = await connect({ blobs, cfg });
    await logIn(older.call);
    const newer = await connect({ blobs, cfg });
    let answered = false;
    const pending = newer.call("messenger_get_messages").then((r) => {
      answered = true;
      return r;
    });
    // Arrives at the old process while the new one is waiting for it.
    await older.inject({ thread_id: "7001", text: "during the overlap", timestamp_ms: 9 });
    await new Promise((r) => setTimeout(r, 200));
    expect(answered).toBe(false);
    await older.close(); // SIGTERM: final snapshot, then release
    const got = (await pending).structuredContent as { messages: Array<{ text: string }> };
    expect(got.messages.map((m) => m.text)).toEqual(["during the overlap"]);
  });

  it("a newer process that times out waiting takes the lease, the older one stops, and takes it back once the newer one is gone", async () => {
    const blobs = new MemoryBlobStore();
    const cfg = config();
    const older = await connect({ blobs, cfg });
    await logIn(older.call);
    const newer = await connect({ blobs, cfg, bridge: { handoffWaitMs: 50 } });
    expect((await newer.call("messenger_status")).structuredContent).toMatchObject({ logged_in: true });
    await older.created.bridge()!.snapshot();
    const stale = await older.call("messenger_status");
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toContain("taken over");

    await newer.close(); // releases the lease
    await older.created.bridge()!.maintain();
    expect((await older.call("messenger_status")).structuredContent).toMatchObject({ logged_in: true });
  });

  it("a bridge that cannot start is not restarted in a loop, and the next call boots again", async () => {
    let spawns = 0;
    const { call } = await connect({
      bridge: {
        startSidecar: async (opts) => {
          spawns += 1;
          if (spawns === 1) {
            opts.onExit?.(1); // a child that died before listening
            throw new Error("simulated start failure");
          }
          return startSidecar(opts);
        },
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(spawns).toBe(1);
    expect((await call("messenger_status")).structuredContent).toMatchObject({ logged_in: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(spawns).toBe(2);
  });

  it("restarts the bridge process when it dies", async () => {
    const { call, created } = await connect();
    await logIn(call);
    await (await created.bridge()!.client()).request("POST", "/_test/crash");
    let status: Awaited<ReturnType<typeof call>> | undefined;
    for (let i = 0; i < 100; i++) {
      status = await call("messenger_status");
      if (!status.isError) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status!.structuredContent).toMatchObject({ logged_in: true });
  });
});

describe("configuration", () => {
  it("names every missing variable and never starts", async () => {
    expect(missingCredentials({})).toEqual([
      "MESSENGER_STATE_ENCRYPTION_KEY",
      "STRAD_STATE_GCS_BUCKET",
      "STRAD_STATE_GCS_CLIENT_EMAIL",
      "STRAD_STATE_GCS_PRIVATE_KEY",
    ]);
    const created = createMCPServer({ version: "t", env: {} });
    await created.registerHandlers(created.server);
    const mcp = new Client({ name: "t", version: "1" }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(a), created.server.connect(b)]);
    const res = (await mcp.callTool({ name: "messenger_status", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("MESSENGER_STATE_ENCRYPTION_KEY");
    expect(created.bridge()).toBeUndefined();
    await mcp.close();
  });

  it("keeps the folder under messenger/ and refuses a malformed proxy without quoting it", () => {
    const base = {
      MESSENGER_STATE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      STRAD_STATE_GCS_BUCKET: "b",
      STRAD_STATE_GCS_CLIENT_EMAIL: "e@example.com",
      STRAD_STATE_GCS_PRIVATE_KEY: "k",
    };
    expect(loadConfig(base).prefix).toBe("messenger");
    expect(loadConfig({ ...base, MESSENGER_STATE_PREFIX: "messenger/prod" }).prefix).toBe("messenger/prod");
    expect(() => loadConfig({ ...base, MESSENGER_STATE_PREFIX: "whatsapp" })).toThrow();
    expect(() => loadConfig({ ...base, MESSENGER_PROXY: "user:hunter2@host" })).toThrow(/^(?!.*hunter2)/);
    expect(loadConfig({ ...base, MESSENGER_PROXY: "socks5://u:p@h:1080" }).proxy).toBe("socks5://u:p@h:1080");
  });
});
