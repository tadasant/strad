import AppKit
import Foundation

// strad-hostd-ax: the native macOS helper behind strad-hostd's computer-use
// servers and its on-screen banner. See hostd/README.md and the design page
// under docs/ for what it is and why it is a separate, signed binary.

func usage() -> Never {
    let text = """
    strad-hostd-ax \(VERSION) — strad-hostd's native macOS helper.

      strad-hostd-ax --stdio             serve JSON lines on stdin/stdout (local-run mode)
      strad-hostd-ax --listen <path>     serve JSON lines on a Unix socket (LaunchAgent mode)
      strad-hostd-ax --status            print the permission state as JSON and exit
      strad-hostd-ax --request-access    ask macOS to prompt for Accessibility and Screen Recording, then exit
      strad-hostd-ax --render-status-icons <dir>
                                         write the menu-bar icon's stills and animation frames as PNGs, then exit

    """
    FileHandle.standardError.write(text.data(using: .utf8)!)
    exit(2)
}

let arguments = Array(CommandLine.arguments.dropFirst())
var mode: Transport.Mode?
var index = 0
while index < arguments.count {
    switch arguments[index] {
    case "--stdio":
        mode = .stdio
    case "--listen":
        index += 1
        guard index < arguments.count else { usage() }
        mode = .listen(arguments[index])
    case "--status":
        let data = try! JSONSerialization.data(withJSONObject: Permissions.hello(), options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        exit(0)
    case "--request-access":
        let data = try! JSONSerialization.data(withJSONObject: Permissions.request(), options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        exit(0)
    case "--render-status-icons":
        index += 1
        guard index < arguments.count else { usage() }
        do {
            for path in try StatusIcon.render(to: arguments[index]) { print(path) }
            exit(0)
        } catch let e as HelperError {
            FileHandle.standardError.write("\(e.code): \(e.message)\n".data(using: .utf8)!)
            exit(1)
        } catch {
            FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
            exit(1)
        }
    case "--version":
        print(VERSION)
        exit(0)
    default:
        usage()
    }
    index += 1
}
guard let chosen = mode else { usage() }

// An accessory app: no Dock tile, no menu of its own, but a real run loop for
// the banner, the status item and the input monitor.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let dispatcher = Dispatcher()
let transport = Transport(mode: chosen, dispatcher: dispatcher)
transport.start()
app.run()
