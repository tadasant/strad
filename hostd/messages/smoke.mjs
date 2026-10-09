// Drive a built strad-hostd-messages over --stdio against a fixture chat.db
// (fixture.swift), and run the daemon's OWN queries through it: the SQL in
// build/messages/chatdb.js, the real SQLite on macOS, and NSUnarchiver on a
// typedstream Foundation wrote. It runs from CI's hostd-ax workflow; locally:
//
//   swift fixture.swift /tmp/fx && node smoke.mjs .build/release/strad-hostd-messages /tmp/fx/chat.db
//
// A runner's own ~/Library/Messages holds no one's history, so it is checked
// only for what the helper says about it.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [binary, dbPath] = process.argv.slice(2);
if (!binary || !dbPath) {
  console.error(
    "usage: node smoke.mjs <strad-hostd-messages> <fixture chat.db>",
  );
  process.exit(2);
}

const child = spawn(binary, ["--stdio", "--db", dbPath], {
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let seq = 0;
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  p(msg);
});
const call = (op, args = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${op} did not answer in 30s`));
    }, 30_000).unref();
    child.stdin.write(JSON.stringify({ id, op, args }) + "\n");
  });

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

try {
  const hello = await call("hello");
  check(
    "hello reports the fixture readable",
    hello.ok &&
      hello.result.chat_db.state === "readable" &&
      hello.result.full_disk_access === true,
    JSON.stringify(hello.result),
  );

  const decoded = await call("query", {
    sql: "SELECT ROWID, attributedBody FROM message WHERE ROWID = ?",
    params: [4],
    decode: ["attributedBody"],
  });
  check(
    "NSUnarchiver decodes an attributedBody Foundation wrote",
    decoded.ok &&
      decoded.result.rows[0][1] === "Friday works — see you at 6 🎉",
    JSON.stringify(decoded.result ?? decoded.error),
  );
  const raw = await call("query", {
    sql: "SELECT attributedBody FROM message WHERE ROWID = 4",
  });
  check(
    "an undecoded blob comes back as base64",
    raw.ok &&
      Buffer.from(raw.result.rows[0][0], "base64")
        .subarray(2, 13)
        .toString() === "streamtyped",
  );

  for (const [name, sql] of [
    ["a DELETE", "DELETE FROM message"],
    ["an UPDATE", "UPDATE message SET text = 'x'"],
    ["a second statement", "SELECT 1; DELETE FROM message"],
    ["an ATTACH", "ATTACH DATABASE '/tmp/x.db' AS x"],
  ]) {
    const r = await call("query", { sql });
    check(
      `${name} is refused`,
      !r.ok && r.error.code === "bad_sql",
      JSON.stringify(r.error),
    );
  }
  const still = await call("query", { sql: "SELECT COUNT(*) FROM message" });
  check("and nothing was written", still.ok && still.result.rows[0][0] === 4);

  const capped = await call("query", {
    sql: "SELECT ROWID FROM message",
    max_rows: 2,
  });
  check(
    "max_rows truncates and says so",
    capped.ok &&
      capped.result.rows.length === 2 &&
      capped.result.truncated === true,
  );

  const tiff = await call("read_attachment", { attachment_id: 1 });
  const jpeg = tiff.ok
    ? Buffer.from(tiff.result.data_base64, "base64")
    : Buffer.alloc(0);
  check(
    "a TIFF attachment is converted to JPEG by sips",
    tiff.ok &&
      tiff.result.converted === true &&
      tiff.result.mime_type === "image/jpeg" &&
      jpeg[0] === 0xff &&
      jpeg[1] === 0xd8,
    JSON.stringify({ ...(tiff.result ?? tiff.error), data_base64: undefined }),
  );
  const outside = await call("read_attachment", { attachment_id: 2 });
  check(
    "an attachment outside the Messages directory is refused",
    !outside.ok && outside.error.code === "outside_messages",
  );
  const gone = await call("read_attachment", { attachment_id: 3 });
  check(
    "a missing file says so",
    !gone.ok && gone.error.code === "file_missing",
  );
  const none = await call("read_attachment", { attachment_id: 99 });
  check(
    "an unknown attachment is not_found",
    !none.ok && none.error.code === "not_found",
  );
  const tooBig = await call("read_attachment", {
    attachment_id: 1,
    max_bytes: 10,
  });
  check(
    "max_bytes is enforced",
    !tooBig.ok && tooBig.error.code === "too_large",
  );

  const bad = await call("no_such_op");
  check(
    "an unknown op is refused with unknown_op",
    !bad.ok && bad.error.code === "unknown_op",
  );

  // The daemon's own queries, through this helper.
  const { ChatDb } = await import(
    new URL("../build/messages/chatdb.js", import.meta.url)
  );
  const db = new ChatDb(async (sql, params, decode) => {
    const r = await call("query", {
      sql,
      params,
      ...(decode ? { decode } : {}),
      max_rows: 5000,
    });
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.result;
  });
  const chats = await db.chats({ limit: 10 });
  check(
    "the daemon's chat list runs on macOS SQLite",
    chats.map((c) => c.chat_id).join(",") ===
      "iMessage;+;chat111,iMessage;-;+15551234567" &&
      chats[0].is_group === true &&
      chats[0].participants.join(",") === "+15551234567,grace@example.com",
    JSON.stringify(chats),
  );
  const page = await db.messages({ after: 0, limit: 10 });
  const byId = new Map(page.messages.map((m) => [m.rowid, m]));
  check(
    "the daemon's message read runs, oldest first, exclusive cursor",
    page.messages.map((m) => m.rowid).join(",") === "1,2,3,4" &&
      page.hasMore === false,
  );
  check(
    "an attributedBody-only message reads as text, through the daemon",
    byId.get(4)?.text === "Friday works — see you at 6 🎉" &&
      byId.get(4)?.sent_at ===
        new Date((1_791_486_131 + 4 * 60) * 1000).toISOString(),
    JSON.stringify(byId.get(4)),
  );
  check(
    "a reaction and an attachment-only message map as they should",
    byId.get(3)?.kind === "reaction" &&
      byId.get(3)?.reaction?.type === "like" &&
      byId.get(3)?.reaction?.target_guid === "msg-2" &&
      byId.get(2)?.text === null &&
      byId.get(2)?.attachments?.[0]?.attachment_id === 1,
    JSON.stringify([byId.get(2), byId.get(3)]),
  );
  const after2 = await db.messages({ after: 2, limit: 10 });
  check(
    "after_rowid 2 returns 3 and 4",
    after2.messages.map((m) => m.rowid).join(",") === "3,4",
  );
} catch (err) {
  check("smoke ran to the end", false, err.message);
} finally {
  child.stdin.end();
}

// The runner's own Messages database: whatever the image grants — it has
// answered "readable" — the helper must report a state rather than crash.
const status = spawn(binary, ["--status"], {
  stdio: ["ignore", "pipe", "inherit"],
});
let out = "";
status.stdout.on("data", (d) => (out += d));
await new Promise((r) => status.once("exit", r));
const real = JSON.parse(out);
check(
  "--status on the real ~/Library/Messages reports a state, not a crash",
  ["denied", "missing", "readable"].includes(real.chat_db.state),
  JSON.stringify(real.chat_db),
);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
