import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Duplex, PassThrough } from "node:stream";

/**
 * A stand-in for `strad-hostd-messages` that speaks its JSON-lines protocol
 * (messages/Sources/strad-hostd-messages/Transport.swift) in-process, against
 * a REAL SQLite file shaped like chat.db.
 *
 * The SQL the daemon sends is the SQL that runs: this fake executes it with
 * `node:sqlite` on a read-only connection, so the queries in
 * `src/messages/chatdb.ts` are tested for real on Linux. What it stands in for
 * is the Swift around them — `NSUnarchiver` (here, the same fallback scan the
 * helper uses when the unarchiver refuses), `sips` (here, a marker), and the
 * Full Disk Access check (here, a switch).
 */
export interface FakeMessagesState {
  /** What `hello` says about the database. */
  chatDb: "readable" | "denied" | "missing";
  /** Fail every connection with this message: the helper is not running. */
  fail?: string;
}

export class FakeMessagesHelper {
  readonly ops: { op: string; args: Record<string, unknown> }[] = [];
  readonly state: FakeMessagesState;

  constructor(
    readonly dbPath: string,
    over: Partial<FakeMessagesState> = {},
  ) {
    this.state = { chatDb: "readable", ...over };
  }

  transport = async (): Promise<Duplex> => {
    if (this.state.fail) throw new Error(this.state.fail);
    const toHelper = new PassThrough();
    const fromHelper = new PassThrough();
    let buffer = "";
    toHelper.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line) as {
          id?: number;
          op: string;
          args?: Record<string, unknown>;
        };
        let reply: Record<string, unknown>;
        try {
          reply = { ok: true, result: this.handle(req.op, req.args ?? {}) };
        } catch (err) {
          const e = err as { code?: string; message: string };
          reply = {
            ok: false,
            error: { code: e.code ?? "sql_error", message: e.message },
          };
        }
        fromHelper.write(JSON.stringify({ id: req.id, ...reply }) + "\n");
      }
    });
    return Duplex.from({ readable: fromHelper, writable: toHelper });
  };

  private handle(op: string, args: Record<string, unknown>): unknown {
    this.ops.push({ op, args });
    switch (op) {
      case "hello":
        return {
          version: "fake",
          pid: 1,
          executable: "/fake/strad-hostd-messages",
          chat_db: { path: this.dbPath, state: this.state.chatDb },
          full_disk_access: this.state.chatDb === "readable",
        };
      case "query":
        this.requireReadable();
        return this.query(
          String(args.sql),
          (args.params as (string | number | null)[]) ?? [],
          new Set((args.decode as string[]) ?? []),
          Number(args.max_rows ?? 500),
        );
      case "read_attachment":
        return this.readAttachment(
          Number(args.attachment_id),
          Number(args.max_bytes),
        );
      default:
        throw Object.assign(new Error(`unknown op "${op}"`), {
          code: "unknown_op",
        });
    }
  }

  private requireReadable(): void {
    if (this.state.chatDb === "denied")
      throw Object.assign(new Error("no Full Disk Access"), {
        code: "full_disk_access_denied",
      });
  }

  private query(
    sql: string,
    params: (string | number | null)[],
    decode: Set<string>,
    maxRows: number,
  ): { columns: string[]; rows: unknown[][]; truncated: boolean } {
    // Read-only, like the helper's SQLITE_OPEN_READONLY: a write the daemon
    // ever sent would fail here too.
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      const stmt = db.prepare(sql);
      const columns = stmt.columns().map((c) => c.name);
      const all = stmt.all(...params) as Record<string, unknown>[];
      const rows = all.slice(0, maxRows).map((r) =>
        columns.map((c) => {
          const v = r[c];
          if (v instanceof Uint8Array) {
            return decode.has(c)
              ? scanTypedStream(v)
              : Buffer.from(v).toString("base64");
          }
          return v ?? null;
        }),
      );
      return { columns, rows, truncated: all.length > maxRows };
    } finally {
      db.close();
    }
  }

  private readAttachment(rowid: number, maxBytes: number): unknown {
    const fail = (code: string, message: string) =>
      Object.assign(new Error(message), { code });
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    let row: Record<string, unknown> | undefined;
    try {
      row = db
        .prepare(
          "SELECT filename, mime_type, transfer_name FROM attachment WHERE ROWID = ?",
        )
        .get(rowid) as Record<string, unknown> | undefined;
    } finally {
      db.close();
    }
    if (!row) throw fail("not_found", `no attachment has id ${rowid}`);
    const stored = String(row.filename ?? "");
    const root = realpathSync(dirname(this.dbPath));
    if (!existsSync(stored))
      throw fail("file_missing", `attachment ${rowid} is not on this Mac`);
    const resolved = realpathSync(stored);
    if (!resolved.startsWith(root + "/"))
      throw fail(
        "outside_messages",
        `attachment ${rowid} points outside ${root}`,
      );
    const data = readFileSync(resolved);
    const heic = /\.(heic|heif|tiff?)$/i.test(resolved);
    const out = heic ? Buffer.from(`JPEG from ${basename(resolved)}`) : data;
    if (out.length > maxBytes)
      throw fail("too_large", `attachment ${rowid} is ${out.length} bytes`);
    return {
      file_name: (row.transfer_name as string) || basename(resolved),
      mime_type: heic ? "image/jpeg" : (row.mime_type ?? null),
      ...(heic ? { original_mime_type: row.mime_type ?? null } : {}),
      converted: heic,
      size_bytes: out.length,
      data_base64: out.toString("base64"),
    };
  }
}

/**
 * The helper's fallback reading of an `attributedBody` (AttributedBody.scan in
 * ChatDB.swift): the first NSString, five type bytes, a length, UTF-8.
 */
export function scanTypedStream(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes);
  const at = b.indexOf("NSString");
  if (at < 0) return null;
  let i = at + 8 + 5;
  let length: number;
  if (b[i] === 0x81) {
    length = b.readUInt16LE(i + 1);
    i += 3;
  } else if (b[i] === 0x82) {
    length = b.readUInt32LE(i + 1);
    i += 5;
  } else {
    length = b[i]!;
    i += 1;
  }
  if (length <= 0 || i + length > b.length) return null;
  return b.subarray(i, i + length).toString("utf8");
}

/** An `attributedBody` in the layout the scan reads. */
export function typedStream(text: string): Uint8Array {
  const body = Buffer.from(text, "utf8");
  const len =
    body.length < 0x80
      ? Buffer.from([body.length])
      : Buffer.concat([Buffer.from([0x81]), u16(body.length)]);
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]),
    Buffer.from("streamtyped"),
    Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84]),
    Buffer.from("NSMutableAttributedString"),
    Buffer.from([0x00, 0x84, 0x84]),
    Buffer.from("NSAttributedString"),
    Buffer.from([0x00, 0x84, 0x84]),
    Buffer.from("NSObject"),
    Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84, 0x84]),
    Buffer.from("NSString"),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    len,
    body,
    Buffer.from([0x86, 0x84]),
  ]);
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

/** Nanoseconds since 2001-01-01, the way chat.db stores `message.date`. */
export function appleNanos(iso: string): bigint {
  return BigInt(Date.parse(iso) / 1000 - 978307200) * 1_000_000_000n;
}

/**
 * A chat.db with the tables and columns the server reads, and a small,
 * deliberately awkward history: a group whose newest message has only an
 * `attributedBody`, a reaction, a reply, an edit, an unsend, a system event,
 * a message no chat claims yet,
 * attachments of three kinds, and one attachment that points outside the
 * Messages directory.
 */
export function buildChatDb(dir: string): string {
  mkdirSync(join(dir, "Attachments", "ab"), { recursive: true });
  const path = join(dir, "chat.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER,
      chat_identifier TEXT, service_name TEXT, display_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT,
      handle_id INTEGER DEFAULT 0, service TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0,
      cache_has_attachments INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, group_title TEXT,
      associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0, associated_message_emoji TEXT,
      attributedBody BLOB, thread_originator_guid TEXT, date_edited INTEGER DEFAULT 0, date_retracted INTEGER DEFAULT 0);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0,
      PRIMARY KEY (chat_id, message_id));
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, filename TEXT,
      mime_type TEXT, transfer_name TEXT, total_bytes INTEGER DEFAULT 0);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER, UNIQUE(message_id, attachment_id));
  `);
  db.exec(`
    INSERT INTO handle (ROWID, id, service) VALUES (1, '+15551234567', 'iMessage'), (2, 'grace@example.com', 'iMessage'),
      (3, '+15559876543', 'SMS');
    INSERT INTO chat (ROWID, guid, style, chat_identifier, service_name, display_name) VALUES
      (1, 'iMessage;+;chat111', 43, 'chat111', 'iMessage', 'Wedding planning'),
      (2, 'iMessage;-;+15551234567', 45, '+15551234567', 'iMessage', ''),
      (3, 'SMS;-;+15559876543', 45, '+15559876543', 'SMS', NULL);
    INSERT INTO chat_handle_join VALUES (1, 1), (1, 2), (2, 1), (3, 3);
  `);
  const msg = db.prepare(
    `INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me, cache_has_attachments, item_type,
       group_title, associated_message_guid, associated_message_type, attributedBody, thread_originator_guid,
       date_edited, date_retracted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const join_ = db.prepare(
    "INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)",
  );
  type Row = {
    id: number;
    chat: number;
    text?: string | null;
    body?: string;
    handle?: number;
    service?: string;
    at: string;
    me?: boolean;
    files?: boolean;
    itemType?: number;
    groupTitle?: string;
    assocGuid?: string;
    assocType?: number;
    replyTo?: string;
    edited?: boolean;
    unsent?: boolean;
  };
  const rows: Row[] = [
    {
      id: 1,
      chat: 2,
      text: "Hey, are you around?",
      handle: 1,
      at: "2026-10-01T09:00:00Z",
    },
    { id: 2, chat: 2, text: "Yes!", me: true, at: "2026-10-01T09:01:00Z" },
    {
      id: 3,
      chat: 3,
      text: "Your code is 123456",
      handle: 3,
      service: "SMS",
      at: "2026-10-02T10:00:00Z",
    },
    {
      id: 4,
      chat: 1,
      text: "Venue contract attached",
      handle: 2,
      at: "2026-10-03T12:00:00Z",
      files: true,
    },
    {
      id: 5,
      chat: 1,
      text: null,
      assocGuid: "p:0/msg-4",
      assocType: 2000,
      handle: 1,
      at: "2026-10-03T12:05:00Z",
    },
    {
      id: 6,
      chat: 1,
      text: "Can we move the tasting?",
      handle: 1,
      at: "2026-10-04T08:00:00Z",
      replyTo: "msg-4",
      edited: true,
    },
    {
      id: 7,
      chat: 1,
      text: null,
      itemType: 2,
      groupTitle: "Wedding planning",
      handle: 2,
      at: "2026-10-04T08:30:00Z",
    },
    {
      id: 8,
      chat: 2,
      text: "oops",
      me: true,
      // Messages stamps date_edited on an unsend too.
      edited: true,
      unsent: true,
      at: "2026-10-05T07:00:00Z",
    },
    {
      id: 9,
      chat: 1,
      text: "￼",
      handle: 1,
      at: "2026-10-06T18:00:00Z",
      files: true,
    },
    {
      id: 10,
      chat: 1,
      text: null,
      body: "Friday works — see you at 6",
      handle: 2,
      at: "2026-10-07T19:02:11Z",
    },
    // Not joined to any chat: a row read between Messages' two writes.
    {
      id: 11,
      chat: 0,
      text: "Not in a chat yet",
      handle: 1,
      at: "2026-10-07T20:00:00Z",
    },
  ];
  for (const r of rows) {
    msg.run(
      r.id,
      `msg-${r.id}`,
      r.text === undefined ? null : r.text,
      r.handle ?? 0,
      r.service ?? "iMessage",
      appleNanos(r.at),
      r.me ? 1 : 0,
      r.files ? 1 : 0,
      r.itemType ?? 0,
      r.groupTitle ?? null,
      r.assocGuid ?? null,
      r.assocType ?? 0,
      r.body ? typedStream(r.body) : null,
      r.replyTo ?? null,
      r.edited ? 1 : 0,
      r.unsent ? 1 : 0,
    );
    if (r.chat) join_.run(r.chat, r.id);
  }

  const files = join(dir, "Attachments", "ab");
  writeFileSync(join(files, "contract.pdf"), "%PDF-1.4 fake contract");
  writeFileSync(join(files, "IMG_0412.HEIC"), "fake heic bytes");
  writeFileSync(join(files, "map.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  const outside = join(dir, "..", `outside-${basename(dir)}.txt`);
  writeFileSync(outside, "not a Messages file");
  db.prepare(
    "INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    1,
    "att-1",
    join(files, "contract.pdf"),
    "application/pdf",
    "Venue contract.pdf",
    23,
  );
  db.prepare(
    "INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    2,
    "att-2",
    join(files, "IMG_0412.HEIC"),
    "image/heic",
    "IMG_0412.HEIC",
    15,
  );
  db.prepare(
    "INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(3, "att-3", join(files, "map.png"), "image/png", null, 8);
  db.prepare(
    "INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(4, "att-4", outside, "text/plain", "outside.txt", 19);
  db.prepare(
    "INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    5,
    "att-5",
    join(files, "offloaded.jpg"),
    "image/jpeg",
    "offloaded.jpg",
    9000,
  );
  db.exec("INSERT INTO message_attachment_join VALUES (4, 1), (9, 2), (9, 3)");
  db.close();
  return path;
}
