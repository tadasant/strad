import Foundation

/// One attachment's bytes, found by its `attachment.ROWID` and nothing else.
///
/// The caller never names a path. The helper looks the file up in chat.db
/// itself and refuses one that resolves outside the database's own directory,
/// so this op reads Messages' attachments and no other file Full Disk Access
/// would let it reach.
enum Attachments {
    /// Formats a model cannot read as an image, converted to JPEG with `sips`.
    static let convertible: Set<String> = ["heic", "heif", "tif", "tiff"]
    /// Image types a model can read, but which are re-encoded when larger than
    /// `largeImage`: clients refuse image blocks of a few megabytes.
    static let shrinkable: Set<String> = ["jpg", "jpeg", "png", "webp"]
    static let largeImage = 3_500_000
    /// The longest side of a converted image, in pixels.
    static let maxSide = "2048"
    /// How long one `sips` run may take before it is killed.
    static let sipsSeconds = 30.0

    static func read(db: ChatDB, rowid: Int64, convert: Bool, maxBytes: Int) throws -> [String: Any] {
        let found = try db.query(
            sql: "SELECT filename, mime_type, transfer_name FROM attachment WHERE ROWID = ?",
            params: [NSNumber(value: rowid)], decode: [], maxRows: 1)
        guard let row = (found["rows"] as? [[Any]])?.first else {
            throw HelperError(code: "not_found", message: "no attachment has id \(rowid)")
        }
        guard let stored = row[0] as? String, !stored.isEmpty else {
            throw HelperError(
                code: "file_missing",
                message: "attachment \(rowid) has no file on this Mac; it was never downloaded")
        }
        let mimeType = row[1] as? String
        let expanded = (stored as NSString).expandingTildeInPath
        let resolved = URL(fileURLWithPath: expanded).resolvingSymlinksInPath().path
        guard resolved.hasPrefix(db.root + "/") else {
            throw HelperError(
                code: "outside_messages",
                message: "attachment \(rowid) points outside \(db.root); it is not read")
        }
        guard FileManager.default.fileExists(atPath: resolved) else {
            throw HelperError(
                code: "file_missing",
                message: "attachment \(rowid) is not on this Mac (\(stored)); with Messages in iCloud, older attachments are kept in iCloud until the conversation is opened in Messages")
        }
        let fileName = (row[2] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (resolved as NSString).lastPathComponent
        let ext = (resolved as NSString).pathExtension.lowercased()
        let size = (try? FileManager.default.attributesOfItem(atPath: resolved)[.size] as? NSNumber)?.intValue ?? 0
        let foreign = convertible.contains(ext) || mimeType == "image/heic" || mimeType == "image/heif"
        let large = shrinkable.contains(ext) && size > largeImage

        if convert && (foreign || large) {
            let data = try toJPEG(resolved)
            guard data.count <= maxBytes else {
                throw HelperError(code: "too_large", message: "attachment \(rowid) is \(data.count) bytes as JPEG; the limit is \(maxBytes)")
            }
            return [
                "file_name": fileName,
                "mime_type": "image/jpeg",
                "original_mime_type": mimeType ?? NSNull(),
                "converted": true,
                "size_bytes": data.count,
                "data_base64": data.base64EncodedString(),
            ]
        }

        guard size <= maxBytes else {
            throw HelperError(code: "too_large", message: "attachment \(rowid) is \(size) bytes; the limit is \(maxBytes)")
        }
        guard let data = FileManager.default.contents(atPath: resolved) else {
            throw HelperError(code: "file_unreadable", message: "could not read attachment \(rowid)")
        }
        return [
            "file_name": fileName,
            "mime_type": mimeType ?? NSNull(),
            "converted": false,
            "size_bytes": data.count,
            "data_base64": data.base64EncodedString(),
        ]
    }

    /// `sips` into a private temporary directory, read back, then removed:
    /// JPEG, at most `maxSide` pixels on the longest side. Started by this
    /// process, `sips` inherits its Full Disk Access. A run past `sipsSeconds`
    /// is killed, so one bad file cannot hold the helper's queue.
    private static func toJPEG(_ path: String) throws -> Data {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("strad-hostd-messages-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: dir) }
        let out = dir.appendingPathComponent("converted.jpg")
        let sips = Process()
        sips.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
        sips.arguments = ["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", maxSide, path, "--out", out.path]
        sips.standardOutput = FileHandle.nullDevice
        sips.standardError = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        sips.terminationHandler = { _ in done.signal() }
        try sips.run()
        if done.wait(timeout: .now() + sipsSeconds) == .timedOut {
            sips.terminate()
            done.wait()
            throw HelperError(code: "convert_failed", message: "sips took longer than \(Int(sipsSeconds))s converting \((path as NSString).lastPathComponent)")
        }
        guard sips.terminationStatus == 0, let data = FileManager.default.contents(atPath: out.path) else {
            throw HelperError(code: "convert_failed", message: "sips could not convert \((path as NSString).lastPathComponent) to JPEG (exit \(sips.terminationStatus))")
        }
        return data
    }
}
