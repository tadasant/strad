import Foundation

let VERSION = "0.1.0"

/// A refusal the daemon can act on: `code` is stable and machine-readable,
/// `message` is for the caller's error text.
struct HelperError: Error {
    let code: String
    let message: String
}

/// Typed access to a request's `args`, with the same error shape everywhere.
struct Args {
    let raw: [String: Any]

    func string(_ key: String) -> String? {
        raw[key] as? String
    }

    func requireString(_ key: String) throws -> String {
        guard let s = raw[key] as? String, !s.isEmpty else {
            throw HelperError(code: "bad_args", message: "\(key) is required and must be a non-empty string")
        }
        return s
    }

    func double(_ key: String) -> Double? {
        if let n = raw[key] as? NSNumber { return n.doubleValue }
        return nil
    }

    func requireDouble(_ key: String) throws -> Double {
        guard let d = double(key) else {
            throw HelperError(code: "bad_args", message: "\(key) is required and must be a number")
        }
        return d
    }

    func int(_ key: String, default value: Int) -> Int {
        if let n = raw[key] as? NSNumber { return n.intValue }
        return value
    }

    func bool(_ key: String, default value: Bool) -> Bool {
        if let b = raw[key] as? Bool { return b }
        return value
    }

    func strings(_ key: String) -> [String] {
        (raw[key] as? [Any])?.compactMap { $0 as? String } ?? []
    }
}

/// Every op the daemon may send, routed on the MAIN thread: the banner and the
/// menu bar are AppKit, and the Accessibility calls are cheap enough to share
/// the thread with them.
final class Dispatcher {
    let ax = Accessibility()
    let input = Input()
    let capture = Capture()
    let banner = Banner()

    func handle(op: String, args raw: [String: Any], channel: Channel) throws -> Any {
        let args = Args(raw: raw)
        switch op {
        case "hello":
            return Permissions.hello()
        case "request_permissions":
            return Permissions.request()

        case "list_apps":
            return ax.listApps()
        case "ax_tree":
            return try ax.tree(args)
        case "ax_find":
            return try ax.find(args)
        case "ax_get":
            return try ax.get(args)
        case "ax_perform":
            return try ax.perform(args)
        case "ax_set_value":
            return try ax.setValue(args)
        case "ax_read_text":
            return try ax.readText(args)

        case "displays":
            return capture.displays()
        case "screen_capture":
            return try capture.screenshot(args)

        case "mouse_move":
            try Permissions.requireAccessibility()
            try input.move(x: args.requireDouble("x"), y: args.requireDouble("y"))
            return ["moved": true]
        case "click":
            try Permissions.requireAccessibility()
            try input.click(
                x: args.requireDouble("x"), y: args.requireDouble("y"),
                button: args.string("button") ?? "left", count: args.int("count", default: 1),
                modifiers: args.strings("modifiers"))
            return ["clicked": true]
        case "drag":
            try Permissions.requireAccessibility()
            try input.drag(
                fromX: args.requireDouble("from_x"), fromY: args.requireDouble("from_y"),
                toX: args.requireDouble("to_x"), toY: args.requireDouble("to_y"),
                modifiers: args.strings("modifiers"))
            return ["dragged": true]
        case "scroll":
            try Permissions.requireAccessibility()
            try input.scroll(
                x: args.requireDouble("x"), y: args.requireDouble("y"),
                dx: args.double("dx") ?? 0, dy: args.double("dy") ?? 0)
            return ["scrolled": true]
        case "type_text":
            try Permissions.requireAccessibility()
            try input.typeText(args.requireString("text"))
            return ["typed": true]
        case "press_keys":
            try Permissions.requireAccessibility()
            try input.pressKey(name: args.requireString("key"), modifiers: args.strings("modifiers"))
            return ["pressed": true]
        case "input_release":
            input.releaseAll()
            return ["released": true]

        case "set_state":
            banner.setState(args, channel: channel)
            return ["shown": !banner.isEmpty]

        default:
            throw HelperError(code: "unknown_op", message: "unknown op \"\(op)\"")
        }
    }
}
