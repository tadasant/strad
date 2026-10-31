import Foundation

let VERSION = "0.2.0"

/// A refusal the daemon can act on: `code` is stable and machine-readable,
/// `message` is for the caller's error text.
struct HelperError: Error {
    let code: String
    let message: String
}

/// Typed access to a request's `args`, with the same error shape everywhere.
struct Args {
    let raw: [String: Any]

    func requireString(_ key: String) throws -> String {
        guard let s = raw[key] as? String, !s.isEmpty else {
            throw HelperError(code: "bad_args", message: "\(key) is required and must be a non-empty string")
        }
        return s
    }

    func int(_ key: String, default value: Int) -> Int {
        if let n = raw[key] as? NSNumber { return n.intValue }
        return value
    }

    func requireInt64(_ key: String) throws -> Int64 {
        guard let n = raw[key] as? NSNumber else {
            throw HelperError(code: "bad_args", message: "\(key) is required and must be an integer")
        }
        return n.int64Value
    }

    func bool(_ key: String, default value: Bool) -> Bool {
        if let b = raw[key] as? Bool { return b }
        return value
    }

    func strings(_ key: String) -> [String] {
        (raw[key] as? [Any])?.compactMap { $0 as? String } ?? []
    }

    func array(_ key: String) -> [Any] {
        raw[key] as? [Any] ?? []
    }
}

/// Every op the daemon may send. There are four, and none of them writes:
/// every database is opened read-only, and the only file this helper creates
/// is a converted copy of an attachment in a private temporary directory,
/// deleted before the answer is sent.
final class Dispatcher {
    let db: ChatDB
    let contacts: AddressBook

    init(db: ChatDB, contacts: AddressBook) {
        self.db = db
        self.contacts = contacts
    }

    func hello() -> [String: Any] {
        let access = db.access()
        let book = contacts.describe()
        return [
            "version": VERSION,
            "pid": Int(getpid()),
            "executable": Bundle.main.executablePath ?? CommandLine.arguments[0],
            "chat_db": access,
            "contacts": ["state": book["state"] ?? "error", "sources": (book["sources"] as? [String])?.count ?? 0],
            "full_disk_access": (access["state"] as? String) == "readable",
        ]
    }

    func handle(op: String, args: Args) throws -> Any {
        switch op {
        case "hello":
            return hello()
        case "contacts_sources":
            return contacts.describe()
        case "query":
            // A Contacts source, by the id `contacts_sources` returned; chat.db
            // otherwise.
            if let raw = args.raw["contacts_source"] {
                guard let source = raw as? String else {
                    throw HelperError(code: "bad_args", message: "contacts_source must be a string")
                }
                return try contacts.query(
                    source: source,
                    sql: args.requireString("sql"),
                    params: args.array("params"),
                    maxRows: max(1, min(args.int("max_rows", default: 500), 5000)))
            }
            return try db.query(
                sql: args.requireString("sql"),
                params: args.array("params"),
                decode: Set(args.strings("decode")),
                maxRows: max(1, min(args.int("max_rows", default: 500), 5000)))
        case "read_attachment":
            return try Attachments.read(
                db: db,
                rowid: args.requireInt64("attachment_id"),
                convert: args.bool("convert", default: true),
                maxBytes: max(1, args.int("max_bytes", default: 10 * 1024 * 1024)))
        default:
            throw HelperError(code: "unknown_op", message: "unknown op \"\(op)\"")
        }
    }
}
