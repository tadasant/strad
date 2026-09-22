import Foundation

/// One connection: newline-delimited JSON in, newline-delimited JSON out.
///
/// A request is `{"id":1,"op":"ax_tree","args":{...}}` and its answer is
/// `{"id":1,"ok":true,"result":...}` or `{"id":1,"ok":false,"error":{"code","message"}}`.
/// The helper also SENDS lines with no `id`: `{"event":"kill","grant_id":"g_…"}`
/// when the person at the machine presses a button on the banner.
protocol Channel: AnyObject {
    func send(_ obj: [String: Any])
}

final class LineChannel: Channel {
    private let readFD: Int32
    private let writeFD: Int32
    private let writeLock = NSLock()
    private let onClose: (LineChannel) -> Void

    init(readFD: Int32, writeFD: Int32, onClose: @escaping (LineChannel) -> Void) {
        self.readFD = readFD
        self.writeFD = writeFD
        self.onClose = onClose
    }

    func send(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        var line = data
        line.append(0x0a)
        writeLock.lock()
        defer { writeLock.unlock() }
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

    /// Blocks on this thread until the peer goes away.
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
        onClose(self)
    }

    private func handle(line: Data, dispatcher: Dispatcher) {
        if line.isEmpty { return }
        guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
              let op = obj["op"] as? String
        else {
            send(["ok": false, "error": ["code": "bad_request", "message": "each line must be a JSON object with an \"op\""]])
            return
        }
        let args = obj["args"] as? [String: Any] ?? [:]
        var response: [String: Any] = [:]
        if let id = obj["id"] { response["id"] = id }
        let run = {
            do {
                response["ok"] = true
                response["result"] = try dispatcher.handle(op: op, args: args, channel: self)
            } catch let e as HelperError {
                response["ok"] = false
                response["error"] = ["code": e.code, "message": e.message]
            } catch {
                response["ok"] = false
                response["error"] = ["code": "internal", "message": "\(error)"]
            }
        }
        // The permission check is main-thread state; the work runs where the
        // op belongs (see Dispatcher). Both are synchronous from this reader
        // thread, so one connection's requests stay in order.
        var refused: HelperError?
        DispatchQueue.main.sync {
            do { try dispatcher.authorize(op: op, channel: self) } catch let e as HelperError { refused = e } catch {}
        }
        if let e = refused {
            response["ok"] = false
            response["error"] = ["code": e.code, "message": e.message]
        } else if Dispatcher.offMain(op) {
            LineChannel.work.sync(execute: run)
        } else {
            DispatchQueue.main.sync(execute: run)
        }
        send(response)
    }

    /// One queue for the slow, non-AppKit ops, so two connections cannot
    /// interleave Accessibility calls and the main thread stays free.
    static let work = DispatchQueue(label: "strad-hostd-ax.work")
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
            let channel = LineChannel(readFD: 0, writeFD: 1) { _ in exit(0) }
            let thread = Thread { channel.runReadLoop(dispatcher: self.dispatcher) }
            thread.start()
        case .listen(let path):
            startListening(path: path)
        }
    }

    /// A Unix socket in the state directory, mode 0600: only the owner's own
    /// processes can reach it, which is the same boundary the daemon's
    /// control page draws. This is the mode the LaunchAgent runs in, and the
    /// reason it exists is TCC: a process launchd starts is its own
    /// "responsible process", so the grants land on this binary and not on
    /// the `node` that would otherwise be its parent.
    private func startListening(path: String) {
        unlink(path)
        // The socket is created 0600 rather than chmod'ed to it afterwards.
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
        FileHandle.standardError.write("strad-hostd-ax \(VERSION) listening on \(path)\n".data(using: .utf8)!)

        let dispatcher = self.dispatcher
        let acceptor = Thread {
            while true {
                let client = Darwin.accept(fd, nil, nil)
                if client < 0 {
                    if errno == EINTR || errno == ECONNABORTED { continue }
                    // A listening socket that cannot accept is a helper that
                    // cannot serve; exit and let launchd start a fresh one.
                    FileHandle.standardError.write("strad-hostd-ax: accept(): \(String(cString: strerror(errno)))\n".data(using: .utf8)!)
                    exit(1)
                }
                let channel = LineChannel(readFD: client, writeFD: client) { ch in
                    close(client)
                    DispatchQueue.main.async { dispatcher.banner.channelClosed(ch) }
                }
                let reader = Thread { channel.runReadLoop(dispatcher: dispatcher) }
                reader.start()
            }
        }
        acceptor.start()
    }

    private func fail(_ message: String) -> Never {
        FileHandle.standardError.write("strad-hostd-ax: \(message)\n".data(using: .utf8)!)
        exit(1)
    }
}
