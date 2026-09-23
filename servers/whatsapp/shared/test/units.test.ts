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

const KEY_B64 = randomBytes(32).toString("base64");
const FULL = {
  WHATSAPP_STATE_ENCRYPTION_KEY: KEY_B64,
  WHATSAPP_GCS_BUCKET: "bucket",
  WHATSAPP_GCS_CLIENT_EMAIL: "sa@example.iam.gserviceaccount.com",
  WHATSAPP_GCS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
};

describe("config", () => {
  test("names every missing variable, and loads a full set", () => {
    assert.deepEqual(missingCredentials({}), [
      "WHATSAPP_STATE_ENCRYPTION_KEY",
      "WHATSAPP_GCS_BUCKET",
      "WHATSAPP_GCS_CLIENT_EMAIL",
      "WHATSAPP_GCS_PRIVATE_KEY",
    ]);
    const cfg = loadConfig(FULL);
    assert.equal(cfg.encryptionKey.length, 32);
    assert.equal(cfg.prefix, "whatsapp");
    assert.equal(cfg.deviceName, "Zimmer");
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

  test("refuses the bucket root as a prefix: logout deletes under it", () => {
    assert.throws(() => loadConfig({ ...FULL, WHATSAPP_GCS_PREFIX: "/" }), /folder/);
    assert.equal(loadConfig({ ...FULL, WHATSAPP_GCS_PREFIX: "/zimmer/wa/" }).prefix, "zimmer/wa");
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
