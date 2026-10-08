import { afterAll, beforeAll, test } from "vitest";
import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { MemoryBlobStore, type WhatsAppConfig } from "../src/index.js";
import { createCdnMediaDownloader, isWhatsAppCdn } from "../src/socket.js";
import type { RawMessage } from "../src/normalize.js";
import { fakeWhatsApp, GRACE_LID, GRACE_PN, GROUP, groupText, waitFor } from "./fake-socket.js";
import { call, clock, config, connect, NOW, open, pairAndConnect } from "./harness.js";

/**
 * Attachments, end to end: a media message's descriptor is buffered (live and
 * from history sync) and survives a restart; whatsapp_get_messages describes
 * the file; whatsapp_get_attachment downloads it with the production
 * downloader (Baileys' key derivation, strad's transport) from a local stand-in
 * for WhatsApp's CDN serving real WhatsApp-encrypted bytes, decrypts it, extracts a PDF's text or returns
 * an image block, and mints a single-use link the bundle host serves.
 *
 * Every identifier in these fixtures is invented, and nothing talks to WhatsApp.
 */

// --- a local "CDN" ------------------------------------------------------------------

type Route = { status: number; body?: Buffer; hang?: boolean };
const routes = new Map<string, Route>();
const hits: string[] = [];
let cdn: Server;
let base = "";

beforeAll(async () => {
  cdn = createServer((req, res) => {
    hits.push(req.url ?? "");
    const route = routes.get(req.url ?? "");
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    if (route.hang) {
      res.writeHead(200);
      res.write(Buffer.alloc(16));
      return; // never ends
    }
    res.writeHead(route.status).end(route.body);
  });
  await new Promise<void>((r) => cdn.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`;
});
afterAll(async () => {
  cdn.closeAllConnections();
  await new Promise((r) => cdn.close(r));
});

/** WhatsApp's media encryption: HKDF-expanded key, AES-256-CBC, a 10-byte HMAC. */
const HKDF_INFO: Record<string, string> = {
  document: "WhatsApp Document Keys",
  image: "WhatsApp Image Keys",
};
function encryptMedia(plain: Buffer, type: "document" | "image") {
  const mediaKey = randomBytes(32);
  const prk = createHmac("sha256", Buffer.alloc(32)).update(mediaKey).digest();
  const blocks: Buffer[] = [];
  let prev = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < 112; i++) {
    prev = createHmac("sha256", prk)
      .update(Buffer.concat([prev, Buffer.from(HKDF_INFO[type]!), Buffer.from([i])]))
      .digest();
    blocks.push(prev);
  }
  const expanded = Buffer.concat(blocks).subarray(0, 112);
  const iv = expanded.subarray(0, 16);
  const cipherKey = expanded.subarray(16, 48);
  const macKey = expanded.subarray(48, 80);
  const cipher = createCipheriv("aes-256-cbc", cipherKey, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac("sha256", macKey).update(Buffer.concat([iv, enc])).digest().subarray(0, 10);
  const body = Buffer.concat([enc, mac]);
  return {
    mediaKey: new Uint8Array(mediaKey),
    body,
    fileSha256: new Uint8Array(createHash("sha256").update(plain).digest()),
    fileEncSha256: new Uint8Array(createHash("sha256").update(body).digest()),
  };
}

/** A two-page PDF with real text, built by hand so the suite needs no fixture file. */
function pdf(pages: string[]): Buffer {
  const objs: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out +=
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let served = 0;
/** Encrypt `plain`, serve it, and return the message WhatsApp would deliver. */
function mediaMessage(
  id: string,
  plain: Buffer,
  opts: {
    kind?: "documentMessage" | "imageMessage";
    mimetype?: string;
    fileName?: string;
    caption?: string;
    pageCount?: number;
    fileLength?: number;
    timestamp?: number;
    serve?: Route["status"] | "hang";
  } = {},
): { message: RawMessage; path: string } {
  const kind = opts.kind ?? "documentMessage";
  const enc = encryptMedia(plain, kind === "imageMessage" ? "image" : "document");
  const path = `/v/t62/${++served}.enc`;
  if (opts.serve === "hang") routes.set(path, { status: 200, hang: true });
  else routes.set(path, { status: opts.serve ?? 200, body: enc.body });
  const body: Record<string, unknown> = {
    url: `${base}${path}`,
    mimetype: opts.mimetype ?? "application/pdf",
    mediaKey: enc.mediaKey,
    fileSha256: enc.fileSha256,
    fileEncSha256: enc.fileEncSha256,
    fileLength: opts.fileLength ?? plain.length,
    mediaKeyTimestamp: NOW - 60,
    ...(opts.fileName ? { fileName: opts.fileName } : {}),
    ...(opts.caption ? { caption: opts.caption } : {}),
    ...(opts.pageCount ? { pageCount: opts.pageCount } : {}),
  };
  return {
    path,
    message: {
      key: { remoteJid: GROUP, fromMe: false, id, participant: GRACE_LID, participantAlt: GRACE_PN },
      message: { [kind]: body },
      messageTimestamp: opts.timestamp ?? NOW - 30,
      pushName: "Grace",
    },
  };
}

const LINKED = (cfg: WhatsAppConfig = config()): WhatsAppConfig => ({
  ...cfg,
  downloadLink: {
    publicBaseUrl: "https://strad.example.com",
    publicSlug: "whatsapp-tadas",
    internalToken: "internal-token-for-tests",
  },
});

/** The production downloader, with its host rule opened to the local CDN. */
const LOCAL_CDN = { mediaDownloader: createCdnMediaDownloader(() => true) };

async function paired(options: Parameters<typeof connect>[0] = {}) {
  const session = await connect({
    cfg: LINKED(),
    ...options,
    bridgeOptions: { ...LOCAL_CDN, ...options.bridgeOptions },
  });
  await pairAndConnect(session.mcp, session.fake);
  return session;
}

const deliver = (session: Awaited<ReturnType<typeof paired>>, ...messages: RawMessage[]) =>
  session.fake.latest().emit("messages.upsert", { type: "notify", messages });

const bodyOf = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> =>
  Buffer.from(await new Response(stream).arrayBuffer());

// --- the tests ------------------------------------------------------------------------

test("a PDF: metadata in get_messages, its text and a single-use link from get_attachment", async () => {
  const session = await paired();
  const contract = pdf(["Venue rental agreement", "Deposit due on signing"]);
  const { message } = mediaMessage("DOC1", contract, {
    fileName: "Contract.pdf",
    caption: "Here is the contract",
    pageCount: 2,
  });
  deliver(session, message);

  const read = await call(session.mcp, "whatsapp_get_messages", { chat_id: GROUP });
  const doc = read.json.messages.find((m: any) => m.id === "DOC1");
  assert.equal(doc.type, "document");
  assert.equal(doc.text, "Here is the contract");
  assert.deepEqual(doc.attachment, {
    file_name: "Contract.pdf",
    mime_type: "application/pdf",
    size_bytes: contract.length,
    page_count: 2,
    available: true,
  });
  // The descriptor itself — the media key — is never in a tool result.
  assert.doesNotMatch(read.text, /media_key|mediaKey|direct_path/);

  const got = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "DOC1" });
  assert.equal(got.isError, false, got.text);
  assert.equal(got.json.file_name, "Contract.pdf");
  assert.equal(got.json.mime_type, "application/pdf");
  assert.equal(got.json.size_bytes, contract.length);
  assert.equal(got.json.page_count, 2);
  assert.equal(got.json.inline, "text");
  assert.equal(got.json.text_truncated, false);
  assert.deepEqual(got.structured, got.json);
  const res = (await session.mcp.callTool({
    name: "whatsapp_get_attachment",
    arguments: { chat_id: GROUP, message_id: "DOC1" },
  })) as { content: { type: string; text: string }[] };
  assert.match(res.content[1]!.text, /--- page 1 of 2 ---\nVenue rental agreement/);
  assert.match(res.content[1]!.text, /--- page 2 of 2 ---\nDeposit due on signing/);

  // The link: through core's /mcp-download, addressed to the GATEWAY slug,
  // and opaque — neither the chat (a phone number or group) nor the message
  // is readable out of a URL that lands in an access log.
  const url: string = got.json.download_url;
  assert.match(url, /^https:\/\/strad\.example\.com\/mcp-download\/whatsapp-tadas\/[A-Za-z0-9_-]+$/);
  assert.equal(got.json.single_use, true);
  assert.match(got.json.curl, /^curl -fSL -o 'Contract\.pdf' 'https:/);
  const token = url.split("/").pop()!;
  const decoded = Buffer.from(token, "base64url").toString("latin1");
  assert.ok(!decoded.includes("120363000000000001") && !decoded.includes("DOC1"));

  const served1 = await session.created.handleDownload(token);
  assert.equal(served1.ok, true);
  if (served1.ok) {
    assert.equal(served1.filename, "Contract.pdf");
    assert.equal(served1.contentType, "application/pdf");
    assert.deepEqual(await bodyOf(served1.body), contract);
  }
  assert.deepEqual(await session.created.handleDownload(token), {
    ok: false,
    status: 410,
    error: "already_used",
  });
  const forged = await session.created.handleDownload(`${token.slice(0, -4)}AAAA`);
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.status, 403);
});

test("an image comes back as an image block", async () => {
  const session = await paired();
  const { message } = mediaMessage("IMG1", PNG, {
    kind: "imageMessage",
    mimetype: "image/png",
    caption: "the venue",
  });
  deliver(session, message);
  const got = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "IMG1" });
  assert.equal(got.isError, false, got.text);
  assert.equal(got.json.inline, "image");
  assert.equal(got.json.file_name, "IMG1.png");
  assert.equal(got.images.length, 1);
  assert.equal(got.images[0]!.mimeType, "image/png");
  assert.deepEqual(Buffer.from(got.images[0]!.data, "base64"), PNG);
  const read = await call(session.mcp, "whatsapp_get_messages", { chat_id: GROUP });
  assert.deepEqual(read.json.messages.find((m: any) => m.id === "IMG1").attachment, {
    file_name: null,
    mime_type: "image/png",
    size_bytes: PNG.length,
    available: true,
  });
});

test("the descriptor is persisted sealed and survives a restart; history sync keeps it too", async () => {
  const blobs = new MemoryBlobStore();
  const cfg = LINKED();
  const first = await paired({ blobs, cfg });
  const live = mediaMessage("LIVE1", pdf(["Live contract"]), { fileName: "Live.pdf" });
  const synced = mediaMessage("SYNC1", pdf(["Synced contract"]), { fileName: "Synced.pdf" });
  deliver(first, live.message);
  first.fake.latest().emit("messaging-history.set", {
    chats: [],
    contacts: [],
    messages: [synced.message],
  });
  await waitFor(async () => {
    const r = await call(first.mcp, "whatsapp_get_messages", { chat_id: GROUP });
    return r.json.messages.some((m: any) => m.id === "SYNC1");
  });
  await first.close();
  open.pop();
  // Sealed like everything else: neither the key nor the filename is in GCS in clear.
  for (const [, obj] of blobs.objects) {
    const raw = obj.data.toString("latin1");
    assert.ok(!raw.includes("Live.pdf") && !raw.includes("media_key"), "a chat object is sealed");
  }

  const fake = fakeWhatsApp(clock);
  fake.autoOpen = true;
  const second = await connect({ blobs, cfg, fake, bridgeOptions: LOCAL_CDN });
  await waitFor(async () => (await call(second.mcp, "whatsapp_status")).json.connected);
  for (const [id, text] of [["LIVE1", "Live contract"], ["SYNC1", "Synced contract"]] as const) {
    const res = (await second.mcp.callTool({
      name: "whatsapp_get_attachment",
      arguments: { chat_id: GROUP, message_id: id },
    })) as { content: { text: string }[]; isError?: boolean };
    assert.notEqual(res.isError, true, res.content[0]!.text);
    assert.match(res.content[1]!.text, new RegExp(text));
  }
});

test("an expired CDN copy is re-uploaded by the phone, once, and its new location kept", async () => {
  const session = await paired();
  const plain = pdf(["Re-uploaded contract"]);
  const { message, path } = mediaMessage("OLD1", plain, { fileName: "Old.pdf" });
  // The copy WhatsApp's CDN had is gone: 410, as it answers for an expired URL.
  const fresh = routes.get(path)!;
  routes.set(path, { status: 410 });
  const reuploadedPath = `${path}.reuploaded`;
  routes.set(reuploadedPath, fresh);
  session.fake.latest().reuploadTo = `${base}${reuploadedPath}`;
  deliver(session, message);

  const got = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "OLD1" });
  assert.equal(got.isError, false, got.text);
  assert.equal(got.json.reuploaded_by_phone, true);
  assert.equal(session.fake.latest().reuploads.length, 1);
  // The re-upload request names the message as WhatsApp addressed it.
  assert.deepEqual(session.fake.latest().reuploads[0]!.key, {
    remoteJid: GROUP,
    fromMe: false,
    id: "OLD1",
    participant: GRACE_LID,
  });

  // The new location is kept: the next read goes straight there.
  hits.length = 0;
  const again = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "OLD1" });
  assert.equal(again.isError, false, again.text);
  assert.equal(again.json.reuploaded_by_phone, undefined);
  assert.equal(session.fake.latest().reuploads.length, 1);
  assert.deepEqual(hits, [reuploadedPath]);
});

test("an expired copy the phone cannot re-upload is a clear error", async () => {
  const session = await paired();
  const { message } = mediaMessage("GONE1", pdf(["x"]), { serve: 404 });
  deliver(session, message);
  const got = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "GONE1" });
  assert.equal(got.isError, true);
  assert.match(got.text, /expired, and the phone did not upload it again/);
  assert.match(got.text, /phone must be online/);
});

test("limits: the size cap before and during download, and the timeout", async () => {
  const session = await paired({
    bridgeOptions: { media: { maxBytes: 1024, timeoutMs: 300 } },
  });
  // Declared too big: refused before anything is fetched.
  const declared = mediaMessage("BIG1", Buffer.alloc(10), { fileLength: 30 * 1024 * 1024 });
  // Declared small, actually big: refused as the stream passes the cap.
  const lying = mediaMessage("BIG2", Buffer.alloc(4096, 1), { fileLength: 100 });
  // A CDN that never finishes.
  const stuck = mediaMessage("SLOW1", Buffer.alloc(10), { serve: "hang" });
  deliver(session, declared.message, lying.message, stuck.message);

  const read = await call(session.mcp, "whatsapp_get_messages", { chat_id: GROUP });
  const big = read.json.messages.find((m: any) => m.id === "BIG1").attachment;
  assert.equal(big.available, false);
  assert.match(big.unavailable_reason, /30\.0 MB; this bridge downloads at most 1 KB/);

  hits.length = 0;
  const r1 = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "BIG1" });
  assert.equal(r1.isError, true);
  assert.match(r1.text, /at most/);
  assert.deepEqual(hits, [], "nothing fetched for a file declared over the cap");

  const r2 = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "BIG2" });
  assert.equal(r2.isError, true);
  assert.match(r2.text, /at most/);

  const r3 = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "SLOW1" });
  assert.equal(r3.isError, true);
  assert.match(r3.text, /took longer than/);
});

test("a tampered file fails its MAC and is not returned; a dropped CDN connection is an error, not a crash", async () => {
  const session = await paired();
  const { message, path } = mediaMessage("TAMPER1", pdf(["original"]));
  const route = routes.get(path)!;
  const flipped = Buffer.from(route.body!);
  flipped[0] ^= 1;
  routes.set(path, { status: 200, body: flipped });
  // Without the checksum, so the MAC is what has to catch it.
  delete (message.message!.documentMessage as Record<string, unknown>).fileEncSha256;
  deliver(session, message);
  const got = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "TAMPER1" });
  assert.equal(got.isError, true);
  assert.match(got.text, /failed its MAC check/);

  const cut = mediaMessage("CUT1", Buffer.alloc(64 * 1024, 7));
  routes.set(cut.path, { status: 200, hang: true });
  deliver(session, cut.message);
  const pending = call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "CUT1" });
  await waitFor(() => hits.includes(cut.path));
  cdn.closeAllConnections();
  const dropped = await pending;
  assert.equal(dropped.isError, true);
  assert.match(dropped.text, /Could not download the attachment from WhatsApp/);
});

test("a text file over 200 KB is cut, and says so", async () => {
  const session = await paired();
  const big = Buffer.from("line of the guest list\n".repeat(12_000));
  const { message } = mediaMessage("TXT1", big, { mimetype: "text/plain", fileName: "guests.txt" });
  deliver(session, message);
  const res = (await session.mcp.callTool({
    name: "whatsapp_get_attachment",
    arguments: { chat_id: GROUP, message_id: "TXT1" },
  })) as { content: { text: string }[]; isError?: boolean };
  assert.notEqual(res.isError, true, res.content[0]!.text);
  const meta = JSON.parse(res.content[0]!.text);
  assert.equal(meta.text_truncated, true);
  assert.match(meta.note, /cut at 200 KB/);
  assert.equal(Buffer.byteLength(res.content[1]!.text), 200 * 1024);
});

test("a message buffered without a descriptor is asked of the phone again", async () => {
  const session = await paired({ bridgeOptions: { media: { recoveryTimeoutMs: 2_000 } } });
  const full = mediaMessage("PRE1", pdf(["The planner's contract"]), {
    fileName: "Planner contract.pdf",
    timestamp: NOW - 100,
  });
  // What a pre-descriptor bridge kept: the type and the caption, no media key.
  const stripped: RawMessage = {
    ...full.message,
    message: { documentMessage: { caption: "contract attached", mimetype: "application/pdf" } },
  };
  deliver(session, stripped, groupText("AFTER1", NOW - 50, "did you get it?"));

  const read = await call(session.mcp, "whatsapp_get_messages", { chat_id: GROUP });
  const pre = read.json.messages.find((m: any) => m.id === "PRE1").attachment;
  assert.equal(pre.available, false);
  assert.match(pre.unavailable_reason, /buffered before the bridge kept what a download needs/);

  const socket = session.fake.latest();
  socket.answerResend = (key) => (key.id === "PRE1" ? full.message : null);
  const got = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "PRE1" });
  assert.equal(got.isError, false, got.text);
  assert.equal(got.json.recovered_from_phone, true);
  assert.equal(got.json.file_name, "Planner contract.pdf");
  assert.deepEqual(socket.resendRequests[0], {
    remoteJid: GROUP,
    fromMe: false,
    id: "PRE1",
    participant: GRACE_LID,
  });
  // And the history request is anchored on the next message buffered after it.
  assert.equal(socket.historyRequests[0]!.key.id, "AFTER1");
  assert.equal(socket.historyRequests[0]!.timestampMs, (NOW - 50) * 1000);
  const after = await call(session.mcp, "whatsapp_get_messages", { chat_id: GROUP });
  assert.equal(after.json.messages.find((m: any) => m.id === "PRE1").attachment.available, true);
});

test("an on-demand history answer recovers a descriptor too", async () => {
  const session = await paired({ bridgeOptions: { media: { recoveryTimeoutMs: 2_000 } } });
  const full = mediaMessage("PRE2", pdf(["From history"]), { timestamp: NOW - 100 });
  deliver(
    session,
    { ...full.message, message: { documentMessage: { mimetype: "application/pdf" } } },
    groupText("AFTER2", NOW - 50, "next"),
  );
  session.fake.latest().answerHistory = (key) => (key.id === "AFTER2" ? [full.message] : []);
  const got = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "PRE2" });
  assert.equal(got.isError, false, got.text);
  assert.equal(got.json.recovered_from_phone, true);
});

test("a phone that never answers: a clear reason, not a hang", async () => {
  const session = await paired({ bridgeOptions: { media: { recoveryTimeoutMs: 200 } } });
  deliver(session, {
    key: { remoteJid: GROUP, fromMe: false, id: "PRE3", participant: GRACE_LID },
    message: { documentMessage: { mimetype: "application/pdf" } },
    messageTimestamp: NOW - 10,
  });
  const got = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "PRE3" });
  assert.equal(got.isError, true);
  assert.match(got.text, /the phone did not send it again within/);
  assert.equal(session.fake.latest().historyRequests.length, 0, "no newer message to anchor on");
  // Baileys remembers an ask for an hour and skips a repeat; an unanswered
  // one is forgotten, so retrying once the phone is online asks again.
  assert.deepEqual(session.fake.latest().forgottenResends, ["PRE3"]);
});

test("a phone that never answers a re-upload costs the call its timeout, not forever", async () => {
  const session = await paired({ bridgeOptions: { media: { timeoutMs: 300 } } });
  const { message } = mediaMessage("HANG1", pdf(["x"]), { serve: 410 });
  session.fake.latest().hangReupload = true;
  deliver(session, message);
  const got = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "HANG1" });
  assert.equal(got.isError, true);
  assert.match(got.text, /took longer than/);
  assert.equal(session.fake.latest().reuploads.length, 1);
});

test("a media URL off WhatsApp's hosts is never fetched", async () => {
  assert.equal(isWhatsAppCdn(new URL("https://mmg.whatsapp.net/v/t62/x.enc")), true);
  assert.equal(isWhatsAppCdn(new URL("http://mmg.whatsapp.net/v/t62/x.enc")), false);
  assert.equal(isWhatsAppCdn(new URL("https://whatsapp.net.attacker.example/x")), false);
  assert.equal(isWhatsAppCdn(new URL("https://169.254.169.254/latest")), false);
  // The production rule, against a message a sender pointed at this host.
  const session = await paired({ bridgeOptions: { mediaDownloader: createCdnMediaDownloader() } });
  const { message } = mediaMessage("SSRF1", pdf(["x"]));
  deliver(session, message);
  hits.length = 0;
  const got = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "SSRF1" });
  assert.equal(got.isError, true);
  assert.match(got.text, /not WhatsApp's; not fetched/);
  assert.deepEqual(hits, []);
});

test("a history copy of a buffered message adds its descriptor and does not undo an edit", async () => {
  const session = await paired();
  const full = mediaMessage("EDIT1", pdf(["x"]), { caption: "original caption" });
  deliver(session, {
    ...full.message,
    message: { documentMessage: { caption: "original caption", mimetype: "application/pdf" } },
  });
  session.fake.latest().emit("messages.update", [
    {
      key: full.message.key,
      update: { message: { editedMessage: { message: { documentMessage: { caption: "edited caption" } } } } },
    },
  ]);
  session.fake.latest().emit("messaging-history.set", { chats: [], contacts: [], messages: [full.message] });
  await waitFor(async () => {
    const r = await call(session.mcp, "whatsapp_get_messages", { chat_id: GROUP });
    return r.json.messages.find((m: any) => m.id === "EDIT1")?.attachment?.available === true;
  });
  const r = await call(session.mcp, "whatsapp_get_messages", { chat_id: GROUP });
  assert.equal(r.json.messages.find((m: any) => m.id === "EDIT1").text, "edited caption");
});

test("no link configuration: the file is still read, and the result says why there is no link", async () => {
  const session = await connect({ bridgeOptions: LOCAL_CDN });
  await pairAndConnect(session.mcp, session.fake);
  const { message } = mediaMessage("NOLINK", pdf(["Still readable"]));
  deliver(session as never, message);
  const got = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "NOLINK" });
  assert.equal(got.isError, false, got.text);
  assert.equal(got.json.download_url, null);
  assert.match(got.json.download_unavailable_reason, /no download link/);
  assert.deepEqual(await session.created.handleDownload("anything"), {
    ok: false,
    status: 404,
    error: "downloads_not_configured",
  });
});

test("refuses a message that is not an attachment, and logs no file contents", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    const session = await paired();
    deliver(session, groupText("TEXT1", NOW - 5, "just words"));
    const { message } = mediaMessage("SECRET1", pdf(["Passport number X1234567"]), {
      fileName: "passport-scan.pdf",
    });
    deliver(session, message);
    const notMedia = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "TEXT1" });
    assert.equal(notMedia.isError, true);
    assert.match(notMedia.text, /is a text message, not an attachment/);
    const got = await call(session.mcp, "whatsapp_get_attachment", { chat_id: GROUP, message_id: "SECRET1" });
    assert.equal(got.isError, false, got.text);
  } finally {
    console.error = original;
  }
  const logged = lines.join("\n");
  assert.doesNotMatch(logged, /X1234567|passport-scan/);
});
