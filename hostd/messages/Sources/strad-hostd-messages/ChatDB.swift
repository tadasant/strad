import Foundation
import SafeUnarchive
import SQLite3

/// `~/Library/Messages/chat.db`, read-only.
///
/// The SQL comes from the daemon (`src/messages/chatdb.ts` holds it, where it
/// is tested against a fixture database on Linux). What this side guarantees
/// is that nothing it runs can write, or read past this one file: the
/// connection is opened `SQLITE_OPEN_READONLY`, ATTACH is denied, a statement
/// SQLite does not report as read-only is refused before it steps, and so is
/// anything after the first statement.
///
/// A connection per request. The database is in WAL mode and Messages writes
/// to it constantly; a fresh connection reads the newest committed state, and
/// holding none between requests means this process never pins a WAL snapshot
/// or keeps the file open while Messages checkpoints it.
final class ChatDB {
    let path: String

    init(path: String) {
        self.path = path
    }

    /// The directory the database lives in. An attachment outside it is not
    /// one this helper will read.
    var root: String {
        URL(fileURLWithPath: path).deletingLastPathComponent().resolvingSymlinksInPath().path
    }

    /// Whether this process can read the file, and if not, why. Full Disk
    /// Access is what decides it: without the grant, open(2) on anything
    /// under ~/Library/Messages fails with EPERM, whoever owns the file.
    func access() -> [String: Any] {
        let fd = open(path, O_RDONLY)
        if fd >= 0 {
            close(fd)
            return ["path": path, "state": "readable"]
        }
        let code = errno
        let state: String
        switch code {
        case EPERM, EACCES: state = "denied"
        case ENOENT: state = "missing"
        default: state = "error"
        }
        return ["path": path, "state": state, "error": String(cString: strerror(code))]
    }

    func requireReadable() throws {
        let a = access()
        switch a["state"] as? String {
        case "readable":
            return
        case "denied":
            throw HelperError(
                code: "full_disk_access_denied",
                message: "strad-hostd-messages does not have Full Disk Access, so macOS will not let it read \(path); add it under System Settings › Privacy & Security › Full Disk Access (`strad-hostd messages --grant` opens both)")
        case "missing":
            throw HelperError(
                code: "chat_db_missing",
                message: "\(path) does not exist: Messages has never been set up for this user on this Mac")
        default:
            throw HelperError(code: "chat_db_unreadable", message: "cannot open \(path): \(a["error"] ?? "unknown error")")
        }
    }

    func query(sql: String, params: [Any], decode: Set<String>, maxRows: Int) throws -> [String: Any] {
        try requireReadable()
        var handle: OpaquePointer?
        guard sqlite3_open_v2(path, &handle, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db = handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "out of memory"
            sqlite3_close(handle)
            throw HelperError(code: "chat_db_unreadable", message: "cannot open \(path): \(message)")
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 3000)
        // `sqlite3_stmt_readonly` calls ATTACH read-only — it changes the
        // connection, not a file — and an attached database would be any
        // other SQLite file Full Disk Access reaches (Mail's index, Safari's
        // history). Refused at prepare, and the limit holds if it were not.
        sqlite3_limit(db, SQLITE_LIMIT_ATTACHED, 0)
        sqlite3_set_authorizer(db, { _, action, _, _, _, _ in
            action == SQLITE_ATTACH || action == SQLITE_DETACH ? SQLITE_DENY : SQLITE_OK
        }, nil)

        var statement: OpaquePointer?
        var tail: UnsafePointer<CChar>?
        let prepared = sql.withCString { sqlite3_prepare_v2(db, $0, -1, &statement, &tail) }
        guard prepared == SQLITE_OK, let stmt = statement else {
            throw HelperError(code: "bad_sql", message: String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        if let rest = tail, !String(cString: rest).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw HelperError(code: "bad_sql", message: "one statement per query")
        }
        guard sqlite3_stmt_readonly(stmt) != 0 else {
            throw HelperError(code: "bad_sql", message: "only read-only statements are run")
        }

        for (offset, value) in params.enumerated() {
            let index = Int32(offset + 1)
            switch value {
            case is NSNull:
                sqlite3_bind_null(stmt, index)
            case let s as String:
                sqlite3_bind_text(stmt, index, s, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            case let n as NSNumber:
                if CFNumberIsFloatType(n as CFNumber) {
                    sqlite3_bind_double(stmt, index, n.doubleValue)
                } else {
                    sqlite3_bind_int64(stmt, index, n.int64Value)
                }
            default:
                throw HelperError(code: "bad_args", message: "params[\(offset)] must be a string, a number or null")
            }
        }

        let count = sqlite3_column_count(stmt)
        let columns = (0..<count).map { String(cString: sqlite3_column_name(stmt, $0)) }
        var rows: [[Any]] = []
        var truncated = false
        while true {
            let step = sqlite3_step(stmt)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else {
                throw HelperError(code: "sql_error", message: String(cString: sqlite3_errmsg(db)))
            }
            if rows.count >= maxRows {
                truncated = true
                break
            }
            var row: [Any] = []
            for i in 0..<count {
                row.append(value(stmt, i, decode: decode.contains(columns[Int(i)])))
            }
            rows.append(row)
        }
        return ["columns": columns, "rows": rows, "truncated": truncated]
    }

    private func value(_ stmt: OpaquePointer, _ i: Int32, decode: Bool) -> Any {
        switch sqlite3_column_type(stmt, i) {
        case SQLITE_INTEGER:
            return NSNumber(value: sqlite3_column_int64(stmt, i))
        case SQLITE_FLOAT:
            return NSNumber(value: sqlite3_column_double(stmt, i))
        case SQLITE_TEXT:
            guard let bytes = sqlite3_column_text(stmt, i) else { return NSNull() }
            let length = Int(sqlite3_column_bytes(stmt, i))
            return String(decoding: UnsafeBufferPointer(start: bytes, count: length), as: UTF8.self)
        case SQLITE_BLOB:
            let length = Int(sqlite3_column_bytes(stmt, i))
            guard let bytes = sqlite3_column_blob(stmt, i), length > 0 else { return decode ? NSNull() : "" }
            let data = Data(bytes: bytes, count: length)
            if decode {
                return AttributedBody.text(data) ?? NSNull()
            }
            return data.base64EncodedString()
        default:
            return NSNull()
        }
    }
}

/// The text of `message.attributedBody`. Since macOS 13 Messages often leaves
/// `message.text` NULL and keeps the body only here.
enum AttributedBody {
    static func text(_ data: Data) -> String? {
        if let decoded = StradPlainTextFromTypedStream(data) {
            return decoded
        }
        return scan(data)
    }

    /// The fallback when the unarchiver refuses: the first NSString in the
    /// stream, read the way every chat.db tool reads it. After the class name
    /// come five bytes of type information, then the length — one byte, or
    /// 0x81 and two bytes little-endian, or 0x82 and four — then UTF-8.
    static func scan(_ data: Data) -> String? {
        let bytes = [UInt8](data)
        let marker = Array("NSString".utf8)
        guard let start = find(marker, in: bytes) else { return nil }
        var i = start + marker.count + 5
        guard i < bytes.count else { return nil }
        var length = 0
        switch bytes[i] {
        case 0x81:
            guard i + 2 < bytes.count else { return nil }
            length = Int(bytes[i + 1]) | Int(bytes[i + 2]) << 8
            i += 3
        case 0x82:
            guard i + 4 < bytes.count else { return nil }
            length = Int(bytes[i + 1]) | Int(bytes[i + 2]) << 8 | Int(bytes[i + 3]) << 16 | Int(bytes[i + 4]) << 24
            i += 5
        default:
            length = Int(bytes[i])
            i += 1
        }
        guard length > 0, i + length <= bytes.count else { return nil }
        return String(bytes: bytes[i..<(i + length)], encoding: .utf8)
    }

    private static func find(_ needle: [UInt8], in haystack: [UInt8]) -> Int? {
        guard haystack.count >= needle.count else { return nil }
        for i in 0...(haystack.count - needle.count) where haystack[i..<(i + needle.count)].elementsEqual(needle) {
            return i
        }
        return nil
    }
}
