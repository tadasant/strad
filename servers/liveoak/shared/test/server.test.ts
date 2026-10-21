/**
 * The server end to end, through a real MCP client: enrol, confirm, list,
 * fetch, download — against the fake Cognito pool (real SRP), the fake
 * Apiture API and a pre-signed document host on a second origin.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seal } from "../src/crypto.js";
import type { LiveOakConfig } from "../src/config.js";
import { GcsError, MemoryBlobStore } from "../src/gcs.js";
import { createMCPServer } from "../src/server.js";
import { CLIENT_ID, FakeApiture, FakeCognito, PDF, POOL_ID } from "./fakes.js";

const USERNAME = "tadas@example.com";
const PASSWORD = "hunter2-but-longer";
const NOW = Date.parse("2026-10-09T12:00:00Z");

const DOCUMENTS = [
  { id: "stmt-2026-09", startOn: "2026-09-01", endOn: "2026-09-30", masked: "******1234" },
  { id: "stmt-2026-08", startOn: "2026-08-01", endOn: "2026-08-31", masked: "******1234" },
  { id: "stmt-2026-07", startOn: "2026-07-01", endOn: "2026-07-31", masked: "******1234" },
  { id: "stmt-2025-01", startOn: "2025-01-01", endOn: "2025-01-31", masked: "******9876" },
];

function config(overrides: Partial<LiveOakConfig> = {}): LiveOakConfig {
  return {
    username: USERNAME,
    password: PASSWORD,
    encryptionKey: Buffer.alloc(32, 7),
    bucket: "b",
    clientEmail: "e",
    privateKey: "k",
    prefix: "liveoak",
    downloadLink: {
      publicBaseUrl: "https://strad.example.com",
      internalToken: "internal-token",
      publicSlug: "liveoak-tadas",
    },
    ...overrides,
  };
}

interface Harness {
  client: Client;
  created: ReturnType<typeof createMCPServer>;
  blobs: MemoryBlobStore;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; json: any; isError: boolean }>;
  everything: string[];
}

let cognito: FakeCognito;
let api: FakeApiture;
const started: FakeApiture[] = [];

async function harness(opts: {
  cfg?: LiveOakConfig;
  blobs?: MemoryBlobStore;
  apiOptions?: Partial<ConstructorParameters<typeof FakeApiture>[0]>;
  toolGroups?: ("readonly" | "admin")[];
} = {}): Promise<Harness> {
  api = await new FakeApiture({ cognito, documents: DOCUMENTS, ...opts.apiOptions }).start();
  started.push(api);
  const blobs = opts.blobs ?? new MemoryBlobStore();
  const created = createMCPServer({
    version: "test",
    config: opts.cfg ?? config(),
    blobs,
    cognito: { userPoolId: POOL_ID, clientId: CLIENT_ID, endpoint: cognito.endpoint },
    apiture: { apiRoot: api.apiRoot },
    now: () => NOW,
    ...(opts.toolGroups ? { toolGroups: opts.toolGroups } : {}),
  });
  const server = new Server({ name: "t", version: "t" }, { capabilities: { tools: {} } });
  await created.registerHandlers(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "t" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const everything: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = res.content.map((c) => c.text ?? "").join("\n");
    everything.push(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { text, json: parsed, isError: res.isError === true };
  };
  return { client, created, blobs, call, everything };
}

async function enrolled(h: Harness): Promise<void> {
  const step1 = await h.call("enrol_device");
  expect(step1.json.status).toBe("code_sent");
  const step2 = await h.call("confirm_device", { code: cognito.smsCodes.at(-1)! });
  expect(step2.json.status).toBe("enrolled");
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

beforeEach(async () => {
  cognito = await new FakeCognito({ username: USERNAME, password: PASSWORD }).start();
});

afterEach(async () => {
  await cognito.close();
  for (const a of started.splice(0)) await a.close();
});

describe("tool surface", () => {
  it("lists five tools by default, and three under readonly", async () => {
    const h = await harness();
    const all = (await h.client.listTools()).tools.map((t) => t.name);
    expect(all).toEqual(["get_status", "list_statements", "get_statement", "enrol_device", "confirm_device"]);
    const ro = await harness({ toolGroups: ["readonly"] });
    expect((await ro.client.listTools()).tools.map((t) => t.name)).toEqual([
      "get_status",
      "list_statements",
      "get_statement",
    ]);
  });

  it("marks the reads read-only", async () => {
    const h = await harness();
    const tools = (await h.client.listTools()).tools;
    for (const name of ["get_status", "list_statements", "get_statement"]) {
      expect(tools.find((t) => t.name === name)!.annotations?.readOnlyHint).toBe(true);
    }
  });
});

describe("before enrolment", () => {
  it("status says no device, and a read refuses WITHOUT contacting LiveOak", async () => {
    const h = await harness();
    const status = await h.call("get_status");
    expect(status.json).toMatchObject({ configured: true, device_enrolled: false, enrolment_pending: false });

    const list = await h.call("list_statements");
    expect(list.isError).toBe(true);
    expect(list.text).toContain("enrol_device");
    expect(cognito.calls).toHaveLength(0);
    expect(cognito.smsCodes).toHaveLength(0);
  });
});

describe("enrolment", () => {
  it("enrol_device sends one code; confirm_device seals the device into storage", async () => {
    const h = await harness();
    const step1 = await h.call("enrol_device");
    expect(step1.json).toMatchObject({
      status: "code_sent",
      delivery_medium: "SMS",
      destination: "+*******1234",
      expires_in_seconds: 180,
    });
    expect((await h.call("get_status")).json.enrolment_pending).toBe(true);

    const step2 = await h.call("confirm_device", { code: cognito.smsCodes.at(-1)! });
    expect(step2.json.status).toBe("enrolled");

    const stored = h.blobs.objects.get("liveoak/device.sealed")!;
    expect(stored.subarray(0, 4).toString()).toBe("LOS1");
    // Sealed: none of the device secrets appears in the object.
    const device = [...cognito.devices.keys()][0]!;
    expect(stored.toString("latin1")).not.toContain(device);
    expect((await h.call("get_status")).json).toMatchObject({ device_enrolled: true, enrolment_pending: false });
  });

  it("a wrong code is retryable; an empty pending state says to call enrol_device", async () => {
    const h = await harness();
    const none = await h.call("confirm_device", { code: "123456" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("Call enrol_device first");

    await h.call("enrol_device");
    const wrong = await h.call("confirm_device", { code: "000000" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("CodeMismatchException");
    const right = await h.call("confirm_device", { code: cognito.smsCodes.at(-1)! });
    expect(right.json.status).toBe("enrolled");
  });

  it("a second enrol_device with a working device sends nothing", async () => {
    const h = await harness();
    await enrolled(h);
    const sent = cognito.smsCodes.length;
    const again = await h.call("enrol_device");
    expect(again.json.status).toBe("already_enrolled");
    expect(cognito.smsCodes.length).toBe(sent);
  });

  it("the device survives a restart: a new process logs in from the sealed state with no code", async () => {
    const blobs = new MemoryBlobStore();
    const first = await harness({ blobs });
    await enrolled(first);
    const sent = cognito.smsCodes.length;

    const second = await harness({ blobs });
    const list = await second.call("list_statements", { from: "2026-07-01", to: "2026-09-30" });
    expect(list.isError).toBe(false);
    expect(list.json.count).toBe(3);
    expect(cognito.smsCodes.length).toBe(sent);
  });

  it("a device the pool forgot: the read fails, holds the challenge, and confirm_device recovers", async () => {
    const h = await harness();
    await enrolled(h);
    cognito.forgetAllDevices();
    // A fresh process, so no token is cached.
    const fresh = await harness({ blobs: h.blobs });
    const list = await fresh.call("list_statements");
    expect(list.isError).toBe(true);
    expect(list.text).toContain("no longer accepts the enrolled device");
    const confirm = await fresh.call("confirm_device", { code: cognito.smsCodes.at(-1)! });
    expect(confirm.json.status).toBe("enrolled");
    expect((await fresh.call("list_statements")).isError).toBe(false);
  });

  it("a pool that issues no device is reported, not silently half-enrolled", async () => {
    await cognito.close();
    cognito = await new FakeCognito({ username: USERNAME, password: PASSWORD, issuesDevices: false }).start();
    const h = await harness();
    await h.call("enrol_device");
    const confirm = await h.call("confirm_device", { code: cognito.smsCodes.at(-1)! });
    expect(confirm.isError).toBe(true);
    expect(confirm.text).toContain("issued no device");
    expect(h.blobs.objects.size).toBe(0);
  });
});

describe("statements", () => {
  it("list_statements: a month's range, normalized, newest first, across pages", async () => {
    const h = await harness();
    await enrolled(h);
    const list = await h.call("list_statements", { from: "2026-07-01", to: "2026-09-30" });
    expect(list.json).toMatchObject({ from: "2026-07-01", to: "2026-09-30", count: 3 });
    expect(list.json.statements.map((s: any) => s.statement_id)).toEqual([
      "stmt-2026-09",
      "stmt-2026-08",
      "stmt-2026-07",
    ]);
    expect(list.json.statements[0]).toMatchObject({
      end_on: "2026-09-30",
      start_on: "2026-09-01",
      account: "*1234",
      account_name: "Business Savings",
    });
    // The portal's query shape.
    const q = api.requests.find((r) => r.path.startsWith("/documents/documents?"))!;
    expect(q.path).toContain("category=accountStatements%7CcustomerStatements");
    expect(q.path).toContain("startOn=2026-07-01T00%3A00%3A00.000Z");
    expect(q.path).toContain("period=P4M");
  });

  it("list_statements defaults to the last twelve months", async () => {
    const h = await harness();
    await enrolled(h);
    const list = await h.call("list_statements");
    expect(list.json.from).toBe("2025-10-01");
    expect(list.json.to).toBe("2026-10-09");
    expect(list.json.count).toBe(3);
  });

  it("get_statement: fetches the PDF from the signed link WITHOUT the bearer, and mints a single-use link", async () => {
    const h = await harness();
    await enrolled(h);
    const got = await h.call("get_statement", { statement_id: "stmt-2026-09" });
    expect(got.isError).toBe(false);
    expect(got.json).toMatchObject({
      statement_id: "stmt-2026-09",
      filename: "liveoak-statement-2026-09-30-1234.pdf",
      content_type: "application/pdf",
      size_bytes: PDF.length,
      sha256: createHash("sha256").update(PDF).digest("hex"),
    });
    expect(got.json.download_url).toMatch(/^https:\/\/strad\.example\.com\/mcp-download\/liveoak-tadas\/[A-Za-z0-9_-]+$/);

    const fileFetch = api.requests.find((r) => r.host === "files")!;
    expect(fileFetch.authorization).toBeUndefined();

    const token = got.json.download_url.split("/").pop();
    const first = await h.created.handleDownload(token);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.filename).toBe("liveoak-statement-2026-09-30-1234.pdf");
    expect((await readAll(first.body)).equals(PDF)).toBe(true);

    const second = await h.created.handleDownload(token);
    expect(second).toMatchObject({ ok: false, status: 410, error: "already_used" });
  });

  it("a link presented to a process that never held the bytes is fetched again", async () => {
    const h = await harness();
    await enrolled(h);
    const got = await h.call("get_statement", { statement_id: "stmt-2026-08" });
    const token = got.json.download_url.split("/").pop();
    const other = await harness({ blobs: h.blobs });
    const out = await other.created.handleDownload(token);
    expect(out.ok).toBe(true);
    if (out.ok) expect((await readAll(out.body)).equals(PDF)).toBe(true);
  });

  it("forged and foreign tokens are refused", async () => {
    const h = await harness();
    expect(await h.created.handleDownload("not-a-token")).toMatchObject({ ok: false, status: 403 });
    await enrolled(h);
    const got = await h.call("get_statement", { statement_id: "stmt-2026-09" });
    const token = got.json.download_url.split("/").pop();
    const otherDeployment = await harness({
      blobs: h.blobs,
      cfg: config({
        downloadLink: { publicBaseUrl: "https://x", internalToken: "different", publicSlug: "liveoak-tadas" },
      }),
    });
    expect(await otherDeployment.created.handleDownload(token)).toMatchObject({ ok: false, status: 403 });
  });

  it("falls back to the statement list when the single-document route is not served, and to /content with no link", async () => {
    const h = await harness({ apiOptions: { noSingleDocumentRoute: true, noLinks: true } });
    await enrolled(h);
    const got = await h.call("get_statement", { statement_id: "stmt-2025-01" });
    expect(got.isError).toBe(false);
    expect(got.json.account).toBe("*9876");
    const content = api.requests.find((r) => r.path.endsWith("/content"))!;
    expect(content.authorization).toMatch(/^Bearer /);
  });

  it("an unknown statement_id says where ids come from", async () => {
    const h = await harness({ apiOptions: { noSingleDocumentRoute: true } });
    await enrolled(h);
    const got = await h.call("get_statement", { statement_id: "nope" });
    expect(got.isError).toBe(true);
    expect(got.text).toContain("list_statements");
  });

  it("an HTML page served in place of the PDF is refused, not handed over", async () => {
    const h = await harness({
      apiOptions: { body: { bytes: Buffer.from("<!doctype html><html>log in</html>"), type: "text/html" } },
    });
    await enrolled(h);
    const got = await h.call("get_statement", { statement_id: "stmt-2026-09" });
    expect(got.isError).toBe(true);
    expect(got.text).toContain("not a PDF");
  });

  it("without link config the statement is still checksummed, and the tool says why there is no link", async () => {
    const h = await harness({
      cfg: config({ downloadLink: undefined, downloadUnavailable: "no download link: LIVEOAK_PUBLIC_SLUG is not set on this deployment" }),
    });
    await enrolled(h);
    const got = await h.call("get_statement", { statement_id: "stmt-2026-09" });
    expect(got.json.download_url).toBeUndefined();
    expect(got.json.download_unavailable).toContain("LIVEOAK_PUBLIC_SLUG");
    expect(got.json.sha256).toHaveLength(64);
  });

  it("one login serves a list, a fetch and a download", async () => {
    const h = await harness();
    await enrolled(h);
    const before = cognito.calls.filter((c) => c.target === "InitiateAuth").length;
    const got = await h.call("get_statement", { statement_id: "stmt-2026-09" });
    await h.call("list_statements");
    await h.created.handleDownload(got.json.download_url.split("/").pop());
    expect(cognito.calls.filter((c) => c.target === "InitiateAuth").length).toBe(before);
  });
});

describe("the boundary", () => {
  it("is read-only on the wire: every request to LiveOak's API is a GET", async () => {
    const h = await harness({ apiOptions: { noSingleDocumentRoute: true } });
    await enrolled(h);
    await h.call("list_statements");
    const got = await h.call("get_statement", { statement_id: "stmt-2026-09" });
    await h.created.handleDownload(got.json.download_url.split("/").pop());
    expect(api.requests.length).toBeGreaterThan(0);
    expect(new Set(api.requests.map((r) => r.method))).toEqual(new Set(["GET"]));
  });

  it("never returns the password, even when it is in the upstream's error text", async () => {
    // A Cognito that echoes what it was sent would be a bug on their side; the
    // scrub is what makes it not one on ours. The fake pool echoes the
    // username it does not know, and this username contains the password.
    await cognito.close();
    cognito = await new FakeCognito({ username: USERNAME, password: PASSWORD, echoUnknownUsername: true }).start();
    const h = await harness({ cfg: config({ username: `${PASSWORD}@example.com` }) });
    const res = await h.call("enrol_device");
    expect(res.isError).toBe(true);
    expect(res.text).toContain("[redacted]@example.com");
    await h.call("get_status");
    await h.call("list_statements");
    for (const text of h.everything) expect(text).not.toContain(PASSWORD);
  });

  it("refuses unknown arguments and malformed dates by name", async () => {
    const h = await harness();
    expect((await h.call("list_statements", { since: "2026-01-01" })).text).toContain("Unknown argument");
    expect((await h.call("list_statements", { from: "Sept 2026" })).text).toContain("YYYY-MM-DD");
    expect((await h.call("confirm_device", { code: "abc" })).text).toContain("numeric code");
  });
});

describe("unconfigured", () => {
  it("names every missing variable, and the download route answers 404", async () => {
    const created = createMCPServer({ version: "t", env: {} });
    const server = new Server({ name: "t", version: "t" }, { capabilities: { tools: {} } });
    await created.registerHandlers(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "t" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = (await client.callTool({ name: "get_status", arguments: {} })) as any;
    expect(res.isError).toBe(true);
    for (const name of [
      "LIVEOAK_USERNAME",
      "LIVEOAK_PASSWORD",
      "LIVEOAK_STATE_ENCRYPTION_KEY",
      "LIVEOAK_GCS_BUCKET",
      "LIVEOAK_GCS_CLIENT_EMAIL",
      "LIVEOAK_GCS_PRIVATE_KEY",
    ]) {
      expect(res.content[0].text).toContain(name);
    }
    expect(await created.handleDownload("x")).toMatchObject({ ok: false, status: 404 });
  });
});

/** A store whose reads or writes fail the way an unusable GCS credential does. */
class BrokenBlobStore extends MemoryBlobStore {
  failReads = false;
  failWrites = false;
  override async read(name: string): Promise<Buffer | null> {
    if (this.failReads) throw new GcsError(0, "sign", "LIVEOAK_GCS_PRIVATE_KEY could not sign a Google token request.");
    return super.read(name);
  }
  override async write(name: string, data: Buffer): Promise<void> {
    if (this.failWrites) throw new GcsError(403, "write the device state");
    return super.write(name, data);
  }
}

describe("unusable device storage", () => {
  it("enrol_device refuses BEFORE logging in, so no code is texted", async () => {
    const blobs = new BrokenBlobStore();
    blobs.failWrites = true;
    const h = await harness({ blobs });
    for (const force of [false, true]) {
      const res = await h.call("enrol_device", { force });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/^No code was sent: this server cannot write to its device storage/);
      expect(res.text).toContain("HTTP 403");
    }
    expect(cognito.calls).toHaveLength(0);
    expect(cognito.smsCodes).toHaveLength(0);
  });

  it("get_status reports a store it cannot read, rather than failing", async () => {
    const blobs = new BrokenBlobStore();
    blobs.failReads = true;
    const h = await harness({ blobs });
    const status = await h.call("get_status");
    expect(status.isError).toBe(false);
    expect(status.json.device_store_error).toContain("LIVEOAK_GCS_PRIVATE_KEY could not sign");
    expect(status.json.device_enrolled).toBe(false);
  });

  it("a device confirmed but not stored is held, used, and stored by enrol_device with no new code", async () => {
    const blobs = new BrokenBlobStore();
    const h = await harness({ blobs });
    expect((await h.call("enrol_device")).json.status).toBe("code_sent");
    // Storage breaks between the code being sent and being answered.
    blobs.failWrites = true;
    const confirm = await h.call("confirm_device", { code: cognito.smsCodes.at(-1)! });
    expect(confirm.isError).toBe(true);
    expect(confirm.text).toContain("LiveOak confirmed this server as a remembered device");
    expect(confirm.text).toContain("call enrol_device WITHOUT force");
    expect(confirm.text).not.toContain("Unexpected error");
    expect((await h.call("get_status")).json).toMatchObject({ device_enrolled: false, device_unsaved: true });

    // Reads work meanwhile, from the held device, with no new code.
    const sent = cognito.smsCodes.length;
    expect((await h.call("list_statements")).isError).toBe(false);

    // Still broken: the retry fails the same way and keeps holding the device.
    const retry = await h.call("enrol_device");
    expect(retry.isError).toBe(true);
    expect((await h.call("get_status")).json.device_unsaved).toBe(true);

    blobs.failWrites = false;
    const stored = await h.call("enrol_device");
    expect(stored.json.status).toBe("enrolled");
    expect(stored.json.message).toContain("No code was sent");
    expect(cognito.smsCodes.length).toBe(sent);
    expect(blobs.objects.has("liveoak/device.sealed")).toBe(true);
    const status = (await h.call("get_status")).json;
    expect(status.device_enrolled).toBe(true);
    expect(status.device_unsaved).toBeUndefined();

    // And a fresh process logs in from what was stored, with no code.
    const fresh = await harness({ blobs });
    expect((await fresh.call("list_statements")).isError).toBe(false);
    expect(cognito.smsCodes.length).toBe(sent);
  });

  it("after a restart lost the held device, enrol_device force: true enrols again cleanly", async () => {
    const blobs = new BrokenBlobStore();
    const first = await harness({ blobs });
    await first.call("enrol_device");
    blobs.failWrites = true;
    expect((await first.call("confirm_device", { code: cognito.smsCodes.at(-1)! })).isError).toBe(true);
    blobs.failWrites = false;

    // The container restarted: the orphaned device lives only in Cognito.
    const second = await harness({ blobs });
    expect((await second.call("get_status")).json).toMatchObject({ device_enrolled: false });
    expect((await second.call("enrol_device", { force: true })).json.status).toBe("code_sent");
    const confirm = await second.call("confirm_device", { code: cognito.smsCodes.at(-1)! });
    expect(confirm.json.status).toBe("enrolled");
    expect((await second.call("list_statements")).isError).toBe(false);
  });

  it("a mangled key in the environment is reported by name at boot and on every tool, never as `Unexpected error`", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const created = createMCPServer({
        version: "t",
        env: {
          LIVEOAK_USERNAME: USERNAME,
          LIVEOAK_PASSWORD: PASSWORD,
          LIVEOAK_STATE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
          LIVEOAK_GCS_BUCKET: "b",
          LIVEOAK_GCS_CLIENT_EMAIL: "sa@example.com",
          LIVEOAK_GCS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----MIIEvQIBADANBg",
        },
      });
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
        "LIVEOAK_GCS_PRIVATE_KEY is set but is not a usable private key",
      );
      const server = new Server({ name: "t", version: "t" }, { capabilities: { tools: {} } });
      await created.registerHandlers(server);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "t" });
      await Promise.all([server.connect(a), client.connect(b)]);
      for (const name of ["get_status", "enrol_device"]) {
        const res = (await client.callTool({ name, arguments: {} })) as any;
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain("no matching END line");
        expect(res.content[0].text).not.toContain("Unexpected error");
      }
      expect(cognito.calls).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("review fixes", () => {
  it("force: true recovers from a changed encryption key, and keeps the old object until a new device exists", async () => {
    const blobs = new MemoryBlobStore();
    blobs.objects.set("liveoak/device.sealed", seal(Buffer.alloc(32, 1), "liveoak/device.sealed", Buffer.from("{}")));
    const h = await harness({ blobs });
    const status = await h.call("get_status");
    expect(status.json.device_enrolled).toBe(false);
    expect(status.json.device_state_unreadable).toContain("LIVEOAK_STATE_ENCRYPTION_KEY");

    const plain = await h.call("enrol_device");
    expect(plain.isError).toBe(true);
    const forced = await h.call("enrol_device", { force: true });
    expect(forced.json.status).toBe("code_sent");
    // Not deleted on the way in: an unconfirmed force leaves what was there.
    expect(blobs.objects.has("liveoak/device.sealed")).toBe(true);
    const confirmed = await h.call("confirm_device", { code: cognito.smsCodes.at(-1)! });
    expect(confirmed.json.status).toBe("enrolled");
    expect((await h.call("get_status")).json.device_enrolled).toBe(true);
  });

  it("an unconfirmed force leaves a working device working", async () => {
    const h = await harness();
    await enrolled(h);
    const before = Buffer.from(h.blobs.objects.get("liveoak/device.sealed")!);
    await h.call("enrol_device", { force: true });
    expect(h.blobs.objects.get("liveoak/device.sealed")!.equals(before)).toBe(true);
    // A fresh process (no pending challenge) still logs in with the old device, no code.
    const sent = cognito.smsCodes.length;
    const fresh = await harness({ blobs: h.blobs });
    expect((await fresh.call("list_statements")).isError).toBe(false);
    expect(cognito.smsCodes.length).toBe(sent);
  });

  it("while a challenge waits for its code, reads refuse WITHOUT texting a new one", async () => {
    const h = await harness();
    await h.call("enrol_device");
    const sent = cognito.smsCodes.length;
    const calls = cognito.calls.length;
    const list = await h.call("list_statements");
    expect(list.isError).toBe(true);
    expect(list.text).toContain("waiting for its MFA code");
    expect(cognito.smsCodes.length).toBe(sent);
    expect(cognito.calls.length).toBe(calls);
    // And the pending code still works.
    expect((await h.call("confirm_device", { code: cognito.smsCodes.at(-1)! })).json.status).toBe("enrolled");
  });

  it("a JSON body served with a 200 in place of the PDF is refused", async () => {
    const h = await harness({
      apiOptions: { body: { bytes: Buffer.from('{"error":"nope"}'), type: "application/json" } },
    });
    await enrolled(h);
    const got = await h.call("get_statement", { statement_id: "stmt-2026-09" });
    expect(got.isError).toBe(true);
    expect(got.text).toContain("JSON");
  });

  it("logs carry no password, token, statement id or device secret", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const h = await harness({ apiOptions: { noLinks: true } });
      await enrolled(h);
      await h.call("list_statements");
      const got = await h.call("get_statement", { statement_id: "stmt-2026-09" });
      const token = got.json.download_url.split("/").pop();
      await h.created.handleDownload(token);
      // A failing download, which logs.
      await api.close();
      await h.call("get_statement", { statement_id: "stmt-2026-08" });
      const other = await harness({ blobs: h.blobs });
      await api.close();
      // The link was spent in `h`'s ledger, not in `other`'s, and `other` holds
      // no bytes for it: it logs in, finds the API down, and logs the failure.
      expect(await other.created.handleDownload(token)).toMatchObject({ ok: false, status: 502 });
      expect(lines.some((l) => l.includes("download failed: ApiError"))).toBe(true);
      const device = [...cognito.devices.keys()];
      for (const line of lines) {
        expect(line).not.toContain(PASSWORD);
        expect(line).not.toContain("stmt-");
        for (const t of cognito.accessTokens) expect(line).not.toContain(t);
        for (const d of device) expect(line).not.toContain(d);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
