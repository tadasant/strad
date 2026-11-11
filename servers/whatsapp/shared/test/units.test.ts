import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  ConfigError,
  loadConfig,
  missingCredentials,
  normalizeMessage,
  open,
  Pacer,
  parseEncryptionKey,
  redact,
  seal,
  SealError,
} from "../src/index.js";
import { mediaMessageOf } from "../src/normalize.js";

const KEY_B64 = randomBytes(32).toString("base64");
const PEM = "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----";
const FULL = {
  WHATSAPP_STATE_ENCRYPTION_KEY: KEY_B64,
  STRAD_STATE_GCS_BUCKET: "bucket",
  STRAD_STATE_GCS_CLIENT_EMAIL: "sa@example.iam.gserviceaccount.com",
  STRAD_STATE_GCS_PRIVATE_KEY: PEM,
};
/** What production holds today: the names from before the bucket was shared. */
const LEGACY = {
  WHATSAPP_STATE_ENCRYPTION_KEY: KEY_B64,
  WHATSAPP_GCS_BUCKET: "bucket",
  WHATSAPP_GCS_CLIENT_EMAIL: "sa@example.iam.gserviceaccount.com",
  WHATSAPP_GCS_PRIVATE_KEY: PEM,
  WHATSAPP_GCS_PREFIX: "whatsapp/prod",
};

describe("config", () => {
  test("names every missing variable, and loads a full set", () => {
    assert.deepEqual(missingCredentials({}), [
      "WHATSAPP_STATE_ENCRYPTION_KEY",
      "STRAD_STATE_GCS_BUCKET",
      "STRAD_STATE_GCS_CLIENT_EMAIL",
      "STRAD_STATE_GCS_PRIVATE_KEY",
    ]);
    const cfg = loadConfig(FULL);
    assert.equal(cfg.encryptionKey.length, 32);
    assert.equal(cfg.prefix, "whatsapp");
    assert.equal(cfg.bufferMaxMessages, 1000);
    assert.equal(cfg.bufferMaxAgeDays, 30);
    assert.match(cfg.privateKey, /\nabc\n/);
  });

  test("accepts base64, base64url and hex keys of exactly 32 bytes; never quotes one", () => {
    const raw = randomBytes(32);
    for (const form of [
      raw.toString("base64"),
      raw.toString("base64url"),
      raw.toString("hex"),
    ]) {
      assert.ok(parseEncryptionKey(form).equals(raw), form);
    }
    const short = randomBytes(16).toString("base64");
    assert.throws(() => parseEncryptionKey(short), (err: Error) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.message.includes(short), false);
      return true;
    });
  });

  test("refuses a prefix outside whatsapp/: the bucket is shared, and logout deletes under it", () => {
    for (const outside of ["/", "zimmer/wa", "slack-events", "whatsapp-other", "whatsappx/prod"]) {
      assert.throws(
        () => loadConfig({ ...FULL, WHATSAPP_STATE_PREFIX: outside }),
        (err: Error) => err instanceof ConfigError && /outside this server's folder/.test(err.message),
        outside,
      );
    }
    assert.equal(loadConfig({ ...FULL, WHATSAPP_STATE_PREFIX: "/whatsapp/prod/" }).prefix, "whatsapp/prod");
    assert.equal(loadConfig({ ...FULL, WHATSAPP_STATE_PREFIX: "whatsapp" }).prefix, "whatsapp");
  });

  test("production's legacy names still load, to the same bucket, folder and identity", () => {
    assert.deepEqual(missingCredentials(LEGACY), []);
    const cfg = loadConfig(LEGACY);
    assert.equal(cfg.bucket, "bucket");
    assert.equal(cfg.clientEmail, "sa@example.iam.gserviceaccount.com");
    assert.match(cfg.privateKey, /\nabc\n/);
    assert.equal(cfg.prefix, "whatsapp/prod");
    assert.equal(cfg.privateKeyVariable, "WHATSAPP_GCS_PRIVATE_KEY");
  });

  test("the shared names win over the legacy ones for the credential, mixed sets load", () => {
    const cfg = loadConfig({
      ...LEGACY,
      STRAD_STATE_GCS_BUCKET: "bucket",
      STRAD_STATE_GCS_CLIENT_EMAIL: "rotated@example.iam.gserviceaccount.com",
      STRAD_STATE_GCS_PRIVATE_KEY: PEM.replace("abc", "new"),
      WHATSAPP_STATE_PREFIX: "whatsapp/prod",
    });
    assert.equal(cfg.clientEmail, "rotated@example.iam.gserviceaccount.com");
    assert.match(cfg.privateKey, /\nnew\n/);
    assert.equal(cfg.privateKeyVariable, "STRAD_STATE_GCS_PRIVATE_KEY");
    // Only the bucket shared, the rest legacy: still a whole configuration.
    const { WHATSAPP_GCS_BUCKET: _b, ...rest } = LEGACY;
    assert.equal(loadConfig({ ...rest, STRAD_STATE_GCS_BUCKET: "bucket" }).bucket, "bucket");
  });

  test("two names that disagree about WHERE the state is are refused, never resolved", () => {
    assert.throws(
      () => loadConfig({ ...LEGACY, STRAD_STATE_GCS_BUCKET: "strad-state-prod" }),
      (err: Error) =>
        err instanceof ConfigError &&
        /STRAD_STATE_GCS_BUCKET is "strad-state-prod" but WHATSAPP_GCS_BUCKET is "bucket"/.test(err.message),
    );
    assert.throws(
      () => loadConfig({ ...LEGACY, WHATSAPP_STATE_PREFIX: "whatsapp/prod-tadas" }),
      (err: Error) => err instanceof ConfigError && /two folders/.test(err.message),
    );
    // The same folder spelled with slashes is the same folder.
    assert.equal(loadConfig({ ...LEGACY, WHATSAPP_STATE_PREFIX: "/whatsapp/prod/" }).prefix, "whatsapp/prod");
  });
});

describe("sealing", () => {
  test("round-trips, and binds a blob to its name and key", () => {
    const key = randomBytes(32);
    const sealed = seal(key, "whatsapp/auth.bin", Buffer.from("secret state"));
    assert.equal(sealed.includes(Buffer.from("secret state")), false);
    assert.equal(open(key, "whatsapp/auth.bin", sealed).toString(), "secret state");
    assert.throws(() => open(key, "whatsapp/index.bin", sealed), SealError);
    assert.throws(() => open(randomBytes(32), "whatsapp/auth.bin", sealed), SealError);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    assert.throws(() => open(key, "whatsapp/auth.bin", tampered), SealError);
  });

  test("redact removes key-shaped runs and PEM blocks", () => {
    const text = redact(
      `boom ${randomBytes(32).toString("base64")} -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- 15551234567`,
    );
    assert.equal(text, "boom [redacted] [redacted] 15551234567");
  });
});

describe("normalizeMessage", () => {
  const self = { jid: "1@s.whatsapp.net", lid: "9@lid" };
  const none = new Map<string, string>();

  test("reactions are messages; a removed reaction is not", () => {
    const base = { key: { remoteJid: "g@g.us", id: "R", participant: "2@s.whatsapp.net" }, messageTimestamp: 10 };
    const r = normalizeMessage(
      { ...base, message: { reactionMessage: { text: "👍", key: { id: "T" } } } },
      self,
      none,
    );
    assert.equal(r.kind, "message");
    assert.equal(r.kind === "message" && r.message.type, "reaction");
    assert.equal(r.kind === "message" && r.message.quoted_message_id, "T");
    assert.equal(
      normalizeMessage({ ...base, message: { reactionMessage: { text: "", key: { id: "T" } } } }, self, none).kind,
      "skip",
    );
  });

  test("protocol edits and revokes become mutations; unknown content is 'other'", () => {
    const key = { remoteJid: "g@g.us", id: "P", participant: "2@s.whatsapp.net" };
    const edit = normalizeMessage(
      {
        key,
        messageTimestamp: 10,
        message: { protocolMessage: { type: 14, key: { id: "X" }, editedMessage: { conversation: "new" } } },
      },
      self,
      none,
    );
    assert.deepEqual(edit, { kind: "mutation", mutation: { kind: "edit", chat_id: "g@g.us", id: "X", text: "new" } });
    const revoke = normalizeMessage(
      { key, messageTimestamp: 10, message: { protocolMessage: { type: 0, key: { id: "X" } } } },
      self,
      none,
    );
    assert.equal(revoke.kind === "mutation" && revoke.mutation.kind, "revoke");
    const location = normalizeMessage(
      { key, messageTimestamp: 10, message: { locationMessage: { name: "the venue" } } },
      self,
      none,
    );
    assert.equal(location.kind === "message" && location.message.type, "other");
    assert.equal(location.kind === "message" && location.message.text, "the venue");
  });

  test("status broadcasts and channels are never buffered", () => {
    for (const remoteJid of ["status@broadcast", "123@newsletter"]) {
      assert.equal(
        normalizeMessage({ key: { remoteJid, id: "S" }, messageTimestamp: 1, message: { conversation: "x" } }, self, none).kind,
        "skip",
      );
    }
  });
});

describe("pacing", () => {
  test("spaces sends, shows typing, and refuses past the hourly cap", async () => {
    let now = 0;
    const slept: number[] = [];
    const pacer = new Pacer(
      { minGapMs: 3000, perMinute: 100, perHour: 2, typingBaseMs: 500, typingPerCharMs: 10, typingMaxMs: 1000 },
      () => now,
      async (ms) => {
        slept.push(ms);
        now += ms;
      },
    );
    let typed = 0;
    await pacer.run("hello", async () => void typed++, async () => "a");
    await pacer.run("hello again, longer text here", async () => void typed++, async () => "b");
    assert.equal(typed, 2);
    // First: typing only. Second: the 3s gap after the first send, then typing.
    assert.deepEqual(slept, [550, 3000, 790]);
    await assert.rejects(pacer.run("third", async () => {}, async () => "c"), /last hour/);
  });
});

describe("auth state (real Baileys)", () => {
  test("fresh creds and keys survive serialize → restore with their Buffers intact", async () => {
    const { createMemoryAuth } = await import("../src/socket.js");
    let changes = 0;
    const fresh = await createMemoryAuth(null, () => void changes++);
    const noise = fresh.state.creds.noiseKey as { private: Uint8Array };
    await fresh.state.keys.set({ session: { "a.0": Buffer.from([1, 2, 3]) }, "pre-key": { "1": null } });
    assert.equal(changes, 1);
    const restored = await createMemoryAuth(fresh.serialize(), () => {});
    const restoredNoise = restored.state.creds.noiseKey as { private: Uint8Array };
    assert.ok(Buffer.from(restoredNoise.private).equals(Buffer.from(noise.private)));
    const got = await restored.state.keys.get("session", ["a.0", "missing"]);
    assert.deepEqual(Object.keys(got), ["a.0"]);
    assert.ok(Buffer.isBuffer(got["a.0"]));
    await restored.state.keys.set({ session: { "a.0": null } });
    assert.deepEqual(await restored.state.keys.get("session", ["a.0"]), {});
  });
});

describe("pairing identity (real Baileys)", () => {
  test("is Baileys' own macOS Chrome preset, so the phone accepts the code", async () => {
    const { PAIRING_BROWSER } = await import("../src/socket.js");
    const baileys = await import("baileys");
    assert.deepEqual([...PAIRING_BROWSER], baileys.Browsers.macOS("Chrome"));
    // What Baileys puts in the link_code_companion_reg stanza: a known
    // platform id (1 = Chrome) and "<browser> (<os>)" as the display.
    assert.equal(baileys.getCompanionPlatformId([...PAIRING_BROWSER]), "1");
    assert.equal(`${PAIRING_BROWSER[1]} (${PAIRING_BROWSER[0]})`, "Chrome (Mac OS)");
  });

  test("the QR PNG decodes back to the exact payload", async () => {
    const { qrPng } = await import("../src/socket.js");
    const { PNG } = await import("pngjs");
    const jsQR = (await import("jsqr")).default;
    const payload =
      "https://wa.me/settings/linked_devices#2@abc,bm9pc2Vub2lzZQ==,aWRlbnRpdHk=,YWR2c2VjcmV0,1";
    const png = PNG.sync.read(await qrPng(payload));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert.equal(decoded?.data, payload);
  });
});

describe("console guard", () => {
  test("libsignal's session dumps never reach the console; other callers are untouched", async () => {
    const { installConsoleGuard } = await import("../src/logging.js");
    const { createRequire } = await import("node:module");
    const lines: string[] = [];
    const sink = {
      log: (...a: unknown[]) => lines.push(`log ${a.map(String).join(" ")}`),
      info: (...a: unknown[]) => lines.push(`info ${a.map(String).join(" ")}`),
      debug: (...a: unknown[]) => lines.push(`debug ${a.map(String).join(" ")}`),
      trace: (...a: unknown[]) => lines.push(`trace ${a.map(String).join(" ")}`),
      warn: (...a: unknown[]) => lines.push(`warn ${a.map(String).join(" ")}`),
      error: (...a: unknown[]) => lines.push(`error ${a.map(String).join(" ")}`),
    } as unknown as Console;
    installConsoleGuard(sink);

    // The real library, printing through the guarded sink.
    const real = globalThis.console;
    globalThis.console = sink;
    try {
      const { SessionRecord } = createRequire(import.meta.url)("libsignal");
      const secret = "ab".repeat(32);
      const session = { indexInfo: { closed: -1 }, currentRatchet: { rootKey: secret } };
      const record = new SessionRecord();
      record.closeSession(session); // console.info("Closing session:", session)
      record.closeSession(session); // console.warn("Session already closed", session)
      assert.equal(lines.join("\n").includes(secret), false);
      assert.deepEqual(lines, ["warn [whatsapp] WARN [signal] Session already closed"]);

      sink.info("an unrelated server's line", { kept: true });
      assert.equal(lines[1], "info an unrelated server's line [object Object]");
    } finally {
      globalThis.console = real;
    }
  });
});

test("a media message keeps its download descriptor; the descriptor rebuilds a Baileys message", () => {
  const mediaKey = new Uint8Array(32).fill(7);
  const n = normalizeMessage(
    {
      key: { remoteJid: "120363000000000001@g.us", id: "DOC9", participant: "900000000000002@lid" },
      message: {
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              url: "https://mmg.whatsapp.net/v/t62/x.enc",
              directPath: "/v/t62/x.enc",
              mimetype: "application/pdf",
              fileName: "Contract.pdf",
              mediaKey,
              fileSha256: new Uint8Array([1, 2]),
              fileEncSha256: { type: "Buffer", data: [3, 4] },
              fileLength: { toNumber: () => 182311 },
              mediaKeyTimestamp: "1790000000",
              pageCount: 4,
              caption: "the contract",
            },
          },
        },
      },
      messageTimestamp: 1790000000,
    },
    { jid: null, lid: null },
    new Map(),
  );
  assert.equal(n.kind, "message");
  if (n.kind !== "message") return;
  assert.equal(n.message.type, "document");
  assert.equal(n.message.text, "the contract");
  assert.deepEqual(n.message.media, {
    kind: "documentMessage",
    media_key: Buffer.from(mediaKey).toString("base64"),
    direct_path: "/v/t62/x.enc",
    url: "https://mmg.whatsapp.net/v/t62/x.enc",
    file_enc_sha256: Buffer.from([3, 4]).toString("base64"),
    file_sha256: Buffer.from([1, 2]).toString("base64"),
    file_length: 182311,
    mimetype: "application/pdf",
    file_name: "Contract.pdf",
    media_key_timestamp: 1790000000,
    page_count: 4,
    key: {
      remote_jid: "120363000000000001@g.us",
      from_me: false,
      id: "DOC9",
      participant: "900000000000002@lid",
    },
  });
  const rebuilt = mediaMessageOf(n.message.media!);
  const body = (rebuilt.message as Record<string, Record<string, unknown>>).documentMessage!;
  assert.deepEqual(body.mediaKey, Buffer.from(mediaKey));
  assert.equal(body.directPath, "/v/t62/x.enc");
  assert.equal(body.fileLength, 182311);

  // No media key, no descriptor: the attachment is described, not downloadable.
  const bare = normalizeMessage(
    {
      key: { remoteJid: "15550000002@s.whatsapp.net", id: "IMG9" },
      message: { imageMessage: { mimetype: "image/jpeg" } },
      messageTimestamp: 1790000000,
    },
    { jid: null, lid: null },
    new Map(),
  );
  assert.ok(bare.kind === "message" && bare.message.media === undefined);
  // A text message carries none.
  const text = normalizeMessage(
    {
      key: { remoteJid: "15550000002@s.whatsapp.net", id: "T9" },
      message: { conversation: "hi" },
      messageTimestamp: 1790000000,
    },
    { jid: null, lid: null },
    new Map(),
  );
  assert.ok(text.kind === "message" && !("media" in text.message));
});

describe("state written before the bucket was shared", () => {
  // The live bucket holds objects sealed by the previous crypto.ts and a lease
  // written by the previous store.ts. Nothing in their layout may have moved.
  test("an object sealed in the old layout (WAS1 | iv | tag | body, name as AAD) still opens", async () => {
    const { createCipheriv } = await import("node:crypto");
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("whatsapp/prod/auth.bin", "utf8"));
    const body = Buffer.concat([cipher.update(Buffer.from('{"creds":1}')), cipher.final()]);
    const old = Buffer.concat([Buffer.from("WAS1"), iv, cipher.getAuthTag(), body]);
    assert.equal(open(key, "whatsapp/prod/auth.bin", old).toString(), '{"creds":1}');
    // And what this writes, the old reader would have parsed the same way.
    const fresh = seal(key, "whatsapp/prod/auth.bin", Buffer.from("x"));
    assert.equal(fresh.subarray(0, 4).toString(), "WAS1");
    assert.equal(fresh.length, 4 + 12 + 16 + 1);
  });

  test("a lease in the old shape ({owner, claimed_at}) still names its owner", async () => {
    const { MemoryBlobStore, StateStore } = await import("../src/index.js");
    const blobs = new MemoryBlobStore();
    await blobs.write(
      "whatsapp/prod/lease.json",
      Buffer.from(JSON.stringify({ owner: "the-old-process", claimed_at: 1 })),
    );
    const store = new StateStore(blobs, randomBytes(32), "whatsapp/prod");
    assert.equal(await store.checkLease(true), false);
    assert.equal(store.superseded, true);
    // The bridge's lease is read-only on a check: no heartbeat write.
    const mine = new StateStore(blobs, randomBytes(32), "whatsapp/prod");
    await mine.claimLease();
    const writes = blobs.writes;
    assert.equal(await mine.checkLease(true), true);
    assert.equal(blobs.writes, writes);
  });
});
