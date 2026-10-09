import Foundation

/// One connection: newline-delimited JSON in, newline-delimited JSON out — the
/// same framing as strad-hostd-ax (`hostd/ax/Sources/strad-hostd-ax/Transport.swift`),
/// so the daemon talks to both helpers through one client.
///
/// A request is `{"id":1,"op":"query","args":{...}}` and its answer is
/// `{"id":1,"ok":true,"result":...}` or `{"id":1,"ok":false,"error":{"code","message"}}`.
/// This helper sends nothing unasked: there is no banner and no button.
final class LineChannel {
    private let readFD: Int32
    private let writeFD: Int32
    private let onClose: () -> Void

    /// Every request, from every connection, runs on this one queue: SQLite
    /// work and `sips` are the only things this process does, and doing one
    /// at a time keeps a burst of calls from opening a burst of connections.
    static let work = DispatchQueue(label: "strad-hostd-messages.work")

    init(readFD: Int32, writeFD: Int32, onClose: @escaping () -> Void) {
        self.readFD = readFD
        self.writeFD = writeFD
        self.onClose = onClose
    }

    func send(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        var line = data
        line.append(0x0a)
        line.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            guard let base = buf.baseAddress else { return }
            var offset = 0
            while offset < buf.count {
                let n = write(writeFD, base + offset, buf.count - offset)
                if n <= 0 { return }
                offset += n
            }
        }
    }

    /// Blocks on this thread until the peer goes away. Requests on one
    /// connection are answered in order.
    func runReadLoop(dispatcher: Dispatcher) {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(readFD, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(contentsOf: chunk[0..<n])
            while let nl = buffer.firstIndex(of: 0x0a) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                handle(line: line, dispatcher: dispatcher)
            }
        }
        onClose()
    }

    private func handle(line: Data, dispatcher: Dispatcher) {
        if line.isEmpty { return }
        guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
              let op = obj["op"] as? String
        else {
            var refusal: [String: Any] = ["ok": false, "error": ["code": "bad_request", "message": "each line must be a JSON object with an \"op\""]]
            if let id = ((try? JSONSerialization.jsonObject(with: line)) as? [String: Any])?["id"] { refusal["id"] = id }
            send(refusal)
            return
        }
        let args = Args(raw: obj["args"] as? [String: Any] ?? [:])
        var response: [String: Any] = [:]
        if let id = obj["id"] { response["id"] = id }
        let run = {
            do {
                response["result"] = try dispatcher.handle(op: op, args: args)
                response["ok"] = true
            } catch let e as HelperError {
                response["ok"] = false
                response["error"] = ["code": e.code, "message": e.message]
            } catch {
                response["ok"] = false
                response["error"] = ["code": "internal", "message": "\(error)"]
            }
        }
        // `hello` is a stat of one file and is answered at once, so the
        // daemon's pre-dialog check still gets an answer while a long `sips`
        // conversion holds the work queue.
        if op == "hello" { run() } else { LineChannel.work.sync(execute: run) }
        send(response)
    }
}

final class Transport {
    enum Mode {
        case stdio
        case listen(String)
    }

    private let mode: Mode
    private let dispatcher: Dispatcher

    init(mode: Mode, dispatcher: Dispatcher) {
        self.mode = mode
        self.dispatcher = dispatcher
    }

    func start() {
        signal(SIGPIPE, SIG_IGN)
        switch mode {
        case .stdio:
            // stdin is the daemon: when it closes, this process has no reason to live.
            let channel = LineChannel(readFD: 0, writeFD: 1) { exit(0) }
            Thread { channel.runReadLoop(dispatcher: self.dispatcher) }.start()
        case .listen(let path):
            startListening(path: path)
        }
    }

    /// A Unix socket in the state directory, created mode 0600: only the
    /// owner's own processes can reach it. This is the mode the LaunchAgent
    /// runs in, and the reason it exists is TCC — a process launchd starts is
    /// its own "responsible process", so Full Disk Access lands on this binary
    /// and not on the `node` that would otherwise be its parent.
    private func startListening(path: String) {
        unlink(path)
        let previous = umask(0o177)
        defer { umask(previous) }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { fail("socket(): \(String(cString: strerror(errno)))") }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard path.utf8.count < capacity else { fail("socket path is too long: \(path)") }
        withUnsafeMutablePointer(to: &addr.sun_path) { tuple in
            tuple.withMemoryRebound(to: CChar.self, capacity: capacity) { dst in
                path.withCString { src in _ = strlcpy(dst, src, capacity) }
            }
        }
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, length) }
        }
        guard bound == 0 else { fail("bind(\(path)): \(String(cString: strerror(errno)))") }
        chmod(path, 0o600)
        guard Darwin.listen(fd, 8) == 0 else { fail("listen(): \(String(cString: strerror(errno)))") }
        FileHandle.standardError.write("strad-hostd-messages \(VERSION) listening on \(path)\n".data(using: .utf8)!)

        let dispatcher = self.dispatcher
        Thread {
            while true {
                let client = Darwin.accept(fd, nil, nil)
                if client < 0 {
                    if errno == EINTR || errno == ECONNABORTED { continue }
                    FileHandle.standardError.write("strad-hostd-messages: accept(): \(String(cString: strerror(errno)))\n".data(using: .utf8)!)
                    exit(1)
                }
                let channel = LineChannel(readFD: client, writeFD: client) { close(client) }
                Thread { channel.runReadLoop(dispatcher: dispatcher) }.start()
            }
        }.start()
    }

    private func fail(_ message: String) -> Never {
        FileHandle.standardError.write("strad-hostd-messages: \(message)\n".data(using: .utf8)!)
        exit(1)
    }
}
