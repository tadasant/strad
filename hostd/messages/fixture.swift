// Build a small chat.db the way Messages shapes one, for CI's macOS smoke
// test: `swift fixture.swift <dir>`. The point of doing it in Swift is the
// `attributedBody` — written here with NSArchiver, it is a real typedstream,
// so the helper's NSUnarchiver path is exercised on bytes Foundation itself
// produced rather than on a hand-made imitation.
import AppKit
import Foundation
import SQLite3

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: swift fixture.swift <dir>\n".data(using: .utf8)!)
    exit(2)
}
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
let attachments = dir.appendingPathComponent("Attachments/ab")
try FileManager.default.createDirectory(at: attachments, withIntermediateDirectories: true)
let dbPath = dir.appendingPathComponent("chat.db").path
unlink(dbPath)

var db: OpaquePointer?
guard sqlite3_open(dbPath, &db) == SQLITE_OK else { fatalError("open") }

func exec(_ sql: String) {
    var err: UnsafeMutablePointer<CChar>?
    guard sqlite3_exec(db, sql, nil, nil, &err) == SQLITE_OK else {
        fatalError("\(String(cString: err!)) in \(sql)")
    }
}

exec("""
    PRAGMA journal_mode = WAL;
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER,
      chat_identifier TEXT, service_name TEXT, display_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT,
      handle_id INTEGER DEFAULT 0, service TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0,
      cache_has_attachments INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, group_title TEXT,
      associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0,
      attributedBody BLOB, thread_originator_guid TEXT, date_edited INTEGER DEFAULT 0, date_retracted INTEGER DEFAULT 0);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, PRIMARY KEY (chat_id, message_id));
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, filename TEXT,
      mime_type TEXT, transfer_name TEXT, total_bytes INTEGER DEFAULT 0);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER, UNIQUE(message_id, attachment_id));
    INSERT INTO handle VALUES (1, '+15551234567', 'iMessage'), (2, 'grace@example.com', 'iMessage');
    INSERT INTO chat VALUES (1, 'iMessage;+;chat111', 43, 'chat111', 'iMessage', 'Wedding planning'),
      (2, 'iMessage;-;+15551234567', 45, '+15551234567', 'iMessage', NULL);
    INSERT INTO chat_handle_join VALUES (1, 1), (1, 2), (2, 1);
    """)

// 2026-10-08T19:02:11Z, in nanoseconds since 2001-01-01; message N is N minutes later.
let base: Int64 = (1_791_486_131 - 978_307_200) * 1_000_000_000
let body = NSAttributedString(string: "Friday works — see you at 6 🎉")
let archived = NSArchiver.archivedData(withRootObject: body)

var stmt: OpaquePointer?
sqlite3_prepare_v2(db, """
    INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me, cache_has_attachments,
      associated_message_guid, associated_message_type, attributedBody)
    VALUES (?, ?, ?, ?, 'iMessage', ?, ?, ?, ?, ?, ?)
    """, -1, &stmt, nil)
let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
func message(_ id: Int64, text: String?, handle: Int64, me: Bool, files: Bool, assoc: (String, Int64)?, blob: Data?) {
    sqlite3_reset(stmt)
    sqlite3_bind_int64(stmt, 1, id)
    sqlite3_bind_text(stmt, 2, "msg-\(id)", -1, transient)
    if let t = text { sqlite3_bind_text(stmt, 3, t, -1, transient) } else { sqlite3_bind_null(stmt, 3) }
    sqlite3_bind_int64(stmt, 4, handle)
    sqlite3_bind_int64(stmt, 5, base + id * 60_000_000_000)
    sqlite3_bind_int64(stmt, 6, me ? 1 : 0)
    sqlite3_bind_int64(stmt, 7, files ? 1 : 0)
    if let (g, t) = assoc {
        sqlite3_bind_text(stmt, 8, g, -1, transient)
        sqlite3_bind_int64(stmt, 9, t)
    } else {
        sqlite3_bind_null(stmt, 8)
        sqlite3_bind_int64(stmt, 9, 0)
    }
    if let b = blob {
        _ = b.withUnsafeBytes { sqlite3_bind_blob(stmt, 10, $0.baseAddress, Int32(b.count), transient) }
    } else {
        sqlite3_bind_null(stmt, 10)
    }
    guard sqlite3_step(stmt) == SQLITE_DONE else { fatalError(String(cString: sqlite3_errmsg(db))) }
}
message(1, text: "Hey, are you around?", handle: 1, me: false, files: false, assoc: nil, blob: nil)
message(2, text: "\u{FFFC}", handle: 2, me: false, files: true, assoc: nil, blob: nil)
message(3, text: nil, handle: 1, me: false, files: false, assoc: ("p:0/msg-2", 2001), blob: nil)
message(4, text: nil, handle: 2, me: false, files: false, assoc: nil, blob: archived)
sqlite3_finalize(stmt)
exec("INSERT INTO chat_message_join VALUES (2, 1), (1, 2), (1, 3), (1, 4)")

// A 4x4 TIFF, which the helper converts to JPEG with sips.
let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 4, bitsPerSample: 8, samplesPerPixel: 3,
    hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
let tiff = attachments.appendingPathComponent("scan.tiff")
try rep.tiffRepresentation!.write(to: tiff)
let outside = dir.deletingLastPathComponent().appendingPathComponent("outside-\(dir.lastPathComponent).txt")
try "not a Messages file".write(to: outside, atomically: true, encoding: .utf8)
exec("""
    INSERT INTO attachment VALUES (1, 'att-1', '\(tiff.path)', 'image/tiff', 'scan.tiff', 0),
      (2, 'att-2', '\(outside.path)', 'text/plain', 'outside.txt', 0),
      (3, 'att-3', '\(attachments.appendingPathComponent("gone.jpg").path)', 'image/jpeg', 'gone.jpg', 0);
    INSERT INTO message_attachment_join VALUES (2, 1);
    """)
sqlite3_close(db)
print(dbPath)
