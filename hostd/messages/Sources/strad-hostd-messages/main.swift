import Foundation

// strad-hostd-messages: the native macOS helper behind strad-hostd's
// read-only `messages` server. See hostd/README.md and the design page under
// docs/ for what it is and why it is a separate, signed binary.

func usage() -> Never {
    let text = """
    strad-hostd-messages \(VERSION) — strad-hostd's read-only Messages helper.

      strad-hostd-messages --stdio             serve JSON lines on stdin/stdout (local-run mode)
      strad-hostd-messages --listen <path>     serve JSON lines on a Unix socket (LaunchAgent mode)
      strad-hostd-messages --status            print whether chat.db is readable, as JSON, and exit
      strad-hostd-messages --db <path>         read this database instead of ~/Library/Messages/chat.db

    """
    FileHandle.standardError.write(text.data(using: .utf8)!)
    exit(2)
}

let arguments = Array(CommandLine.arguments.dropFirst())
var mode: Transport.Mode?
var status = false
var dbPath = ("~/Library/Messages/chat.db" as NSString).expandingTildeInPath
var index = 0
while index < arguments.count {
    switch arguments[index] {
    case "--stdio":
        mode = .stdio
    case "--listen":
        index += 1
        guard index < arguments.count else { usage() }
        mode = .listen(arguments[index])
    case "--db":
        index += 1
        guard index < arguments.count else { usage() }
        dbPath = (arguments[index] as NSString).expandingTildeInPath
    case "--status":
        status = true
    case "--version":
        print(VERSION)
        exit(0)
    default:
        usage()
    }
    index += 1
}

let dispatcher = Dispatcher(db: ChatDB(path: dbPath))
if status {
    let data = try! JSONSerialization.data(withJSONObject: dispatcher.hello(), options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    exit(0)
}
guard let chosen = mode else { usage() }
Transport(mode: chosen, dispatcher: dispatcher).start()
dispatchMain()
