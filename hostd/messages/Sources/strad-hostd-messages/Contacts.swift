import Foundation

/// The owner's Contacts databases, read-only, so a sender's phone number or
/// email can be given a name before it leaves this Mac.
///
/// Contacts keeps one Core Data SQLite file per account under
/// `~/Library/Application Support/AddressBook`: `AddressBook-v22.abcddb` at
/// the top, and one more under `Sources/<id>/` for each account (iCloud, a
/// Google account, "On My Mac"). They are read as files, under the Full Disk
/// Access this helper already holds, not through Contacts.framework: the
/// framework asks for its own Contacts grant, a second prompt a LaunchAgent
/// with nobody at the screen cannot answer.
///
/// As with chat.db, the SQL is the daemon's (`src/messages/contacts.ts`) and
/// the guarantee is the helper's: the daemon names a source by the id this
/// enumeration returned, never by a path, and the statement runs under
/// `ReadOnlySQLite`'s guards.
final class AddressBook {
    static let fileName = "AddressBook-v22.abcddb"
    /// The id of the top-level database. A source directory is a UUID, so
    /// this never collides with one.
    static let mainID = "main"

    let root: String

    init(root: String) {
        self.root = root
    }

    /// Every Contacts database on this Mac, by id.
    func sources() throws -> [(id: String, path: String)] {
        let fm = FileManager.default
        var out: [(id: String, path: String)] = []
        // Listing the directory is what Full Disk Access decides: without the
        // grant it fails with EPERM, as open(2) on chat.db does.
        do {
            _ = try fm.contentsOfDirectory(atPath: root)
        } catch let error as NSError {
            let posix = (error.userInfo[NSUnderlyingErrorKey] as? NSError)?.code
            if error.code == NSFileReadNoSuchFileError || posix == Int(ENOENT) {
                throw HelperError(code: "contacts_missing", message: "\(root) does not exist: Contacts has never been used on this Mac")
            }
            if error.code == NSFileReadNoPermissionError || posix == Int(EPERM) || posix == Int(EACCES) {
                throw HelperError(
                    code: "contacts_denied",
                    message: "strad-hostd-messages cannot read \(root); it needs Full Disk Access")
            }
            throw HelperError(code: "contacts_unreadable", message: "cannot list \(root): \(error.localizedDescription)")
        }
        let top = (root as NSString).appendingPathComponent(Self.fileName)
        if fm.fileExists(atPath: top) { out.append((Self.mainID, top)) }
        let sourcesDir = (root as NSString).appendingPathComponent("Sources")
        let names = ((try? fm.contentsOfDirectory(atPath: sourcesDir)) ?? []).sorted()
        for name in names where Self.isSourceID(name) {
            let path = ((sourcesDir as NSString).appendingPathComponent(name) as NSString)
                .appendingPathComponent(Self.fileName)
            if fm.fileExists(atPath: path) { out.append((name, path)) }
        }
        return out
    }

    /// A source directory's name: letters, digits and dashes, so an id can
    /// never walk out of `Sources/`.
    static func isSourceID(_ name: String) -> Bool {
        !name.isEmpty && name != mainID && name.count <= 64
            && name.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || $0 == "-" }
            && name.allSatisfy(\.isASCII)
    }

    /// What `hello` and `contacts_sources` say: whether the databases can be
    /// read, how many there are, and the region a number written without a
    /// country code belongs to.
    func describe() -> [String: Any] {
        var out: [String: Any] = ["path": root]
        if let region = Locale.current.region?.identifier, region.count == 2 {
            out["region"] = region
        }
        do {
            let found = try sources()
            out["state"] = found.isEmpty ? "missing" : "readable"
            out["sources"] = found.map(\.id)
        } catch let e as HelperError {
            out["state"] =
                e.code == "contacts_denied" ? "denied" : e.code == "contacts_missing" ? "missing" : "error"
            out["sources"] = [String]()
            out["error"] = e.message
        } catch {
            out["state"] = "error"
            out["sources"] = [String]()
            out["error"] = "\(error)"
        }
        return out
    }

    func query(source: String, sql: String, params: [Any], maxRows: Int) throws -> [String: Any] {
        guard let found = try sources().first(where: { $0.id == source }) else {
            throw HelperError(code: "not_found", message: "no Contacts source has id \(source)")
        }
        return try ReadOnlySQLite.query(
            path: found.path, sql: sql, params: params, decode: [], maxRows: maxRows,
            unreadable: "contacts_unreadable")
    }
}
