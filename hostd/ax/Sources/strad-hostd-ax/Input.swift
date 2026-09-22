import AppKit
import CoreGraphics
import Foundation

/// Stamped on every event this helper posts, so the owner-input monitor can
/// tell the machine's own keyboard from ours.
let eventTag: Int64 = 0x5354_5241_4400

/// US ANSI virtual key codes. A named key that is not here is refused rather
/// than guessed.
private let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
    "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
    "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
    ".": 47, "`": 50,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 51, "escape": 53,
    "esc": 53, "forward_delete": 117, "home": 115, "end": 119, "pageup": 116, "page_up": 116,
    "pagedown": 121, "page_down": 121, "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
    "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64,
    "f18": 79, "f19": 80, "f20": 90, "help": 114, "capslock": 57,
]

private let modifierCodes: [String: (CGKeyCode, CGEventFlags)] = [
    "cmd": (55, .maskCommand), "command": (55, .maskCommand), "meta": (55, .maskCommand), "super": (55, .maskCommand),
    "shift": (56, .maskShift),
    "alt": (58, .maskAlternate), "option": (58, .maskAlternate), "opt": (58, .maskAlternate),
    "ctrl": (59, .maskControl), "control": (59, .maskControl),
    "fn": (63, .maskSecondaryFn), "function": (63, .maskSecondaryFn),
]

/// Synthetic mouse and keyboard through Quartz events, posted at the HID tap
/// so they reach whatever is focused exactly as hardware would. There is one
/// cursor and one keyboard: everything here takes them from the person at the
/// machine.
final class Input {
    private let source = CGEventSource(stateID: .combinedSessionState)

    private func post(_ event: CGEvent) {
        event.setIntegerValueField(.eventSourceUserData, value: eventTag)
        event.post(tap: .cghidEventTap)
    }

    private func pause(_ ms: UInt32) {
        usleep(ms * 1000)
    }

    private func modifiers(_ names: [String]) throws -> [(CGKeyCode, CGEventFlags)] {
        try names.map { name in
            guard let m = modifierCodes[name.lowercased()] else {
                throw HelperError(code: "bad_modifier", message: "unknown modifier \"\(name)\"; use cmd, shift, alt, ctrl or fn")
            }
            return m
        }
    }

    private func flags(_ mods: [(CGKeyCode, CGEventFlags)]) -> CGEventFlags {
        mods.reduce(CGEventFlags()) { $0.union($1.1) }
    }

    // MARK: mouse

    func move(x: Double, y: Double) {
        let point = CGPoint(x: x, y: y)
        if let e = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
            post(e)
        }
    }

    func click(x: Double, y: Double, button: String, count: Int, modifiers names: [String]) throws {
        let point = CGPoint(x: x, y: y)
        let (down, up, which): (CGEventType, CGEventType, CGMouseButton)
        switch button.lowercased() {
        case "left": (down, up, which) = (.leftMouseDown, .leftMouseUp, .left)
        case "right": (down, up, which) = (.rightMouseDown, .rightMouseUp, .right)
        case "middle": (down, up, which) = (.otherMouseDown, .otherMouseUp, .center)
        default: throw HelperError(code: "bad_args", message: "button must be left, right or middle")
        }
        let mods = try modifiers(names)
        let f = flags(mods)
        move(x: x, y: y)
        pause(40)
        for i in 1...max(1, min(count, 3)) {
            guard let d = CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: point, mouseButton: which),
                  let u = CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: point, mouseButton: which)
            else { throw HelperError(code: "event_failed", message: "could not create a mouse event") }
            d.flags = f
            u.flags = f
            d.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            u.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            post(d)
            pause(25)
            post(u)
            pause(70)
        }
    }

    func drag(fromX: Double, fromY: Double, toX: Double, toY: Double, modifiers names: [String]) throws {
        let f = flags(try modifiers(names))
        let from = CGPoint(x: fromX, y: fromY)
        let to = CGPoint(x: toX, y: toY)
        move(x: fromX, y: fromY)
        pause(60)
        guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)
        else { throw HelperError(code: "event_failed", message: "could not create a mouse event") }
        down.flags = f
        post(down)
        pause(80)
        let steps = 12
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
            if let e = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left) {
                e.flags = f
                post(e)
            }
            pause(20)
        }
        if let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left) {
            up.flags = f
            post(up)
        }
    }

    /// Positive `dy` scrolls the content up, i.e. moves the page down, like a
    /// wheel rolled toward the person.
    func scroll(x: Double, y: Double, dx: Double, dy: Double) throws {
        move(x: x, y: y)
        pause(30)
        var remainingY = Int32(max(-10000, min(10000, -dy)))
        var remainingX = Int32(max(-10000, min(10000, -dx)))
        while remainingY != 0 || remainingX != 0 {
            let stepY = max(-60, min(60, remainingY))
            let stepX = max(-60, min(60, remainingX))
            guard let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: stepY, wheel2: stepX, wheel3: 0)
            else { throw HelperError(code: "event_failed", message: "could not create a scroll event") }
            post(e)
            remainingY -= stepY
            remainingX -= stepX
            pause(12)
        }
    }

    // MARK: keyboard

    private func tap(code: CGKeyCode, flags f: CGEventFlags) throws {
        guard let d = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let u = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        else { throw HelperError(code: "event_failed", message: "could not create a keyboard event") }
        d.flags = f
        u.flags = f
        post(d)
        pause(8)
        post(u)
        pause(8)
    }

    /// One character per event, carrying the character as a Unicode string, so
    /// layout does not matter and every app receives what was asked for.
    func typeText(_ text: String) throws {
        for ch in text {
            if ch == "\n" || ch == "\r" {
                try tap(code: 36, flags: [])
                continue
            }
            if ch == "\t" {
                try tap(code: 48, flags: [])
                continue
            }
            var units = Array(String(ch).utf16)
            guard let d = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let u = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
            else { throw HelperError(code: "event_failed", message: "could not create a keyboard event") }
            d.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            u.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            post(d)
            pause(4)
            post(u)
            pause(4)
        }
    }

    func pressKey(name: String, modifiers names: [String]) throws {
        let key = name.lowercased()
        guard let code = keyCodes[key] else {
            throw HelperError(code: "bad_key", message: "unknown key \"\(name)\"; use a letter, digit, punctuation mark or one of the named keys (return, tab, space, escape, backspace, delete, forward_delete, up, down, left, right, home, end, page_up, page_down, f1…f20)")
        }
        let mods = try modifiers(names)
        var held = CGEventFlags()
        for (modCode, flag) in mods {
            held.insert(flag)
            if let d = CGEvent(keyboardEventSource: source, virtualKey: modCode, keyDown: true) {
                d.flags = held
                post(d)
                pause(8)
            }
        }
        try tap(code: code, flags: held)
        for (modCode, flag) in mods.reversed() {
            held.remove(flag)
            if let u = CGEvent(keyboardEventSource: source, virtualKey: modCode, keyDown: false) {
                u.flags = held
                post(u)
                pause(8)
            }
        }
    }

    /// Let go of everything a grant may have left down: modifier keys and the
    /// left button. Called when a grant ends for any reason.
    func releaseAll() {
        for code: CGKeyCode in [55, 56, 58, 59, 63] {
            if let u = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) {
                u.flags = []
                post(u)
            }
        }
        if let here = CGEvent(source: nil)?.location,
           let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: here, mouseButton: .left)
        {
            post(up)
        }
    }

    static func cursor() -> [String: Any] {
        let p = CGEvent(source: nil)?.location ?? .zero
        return ["x": p.x, "y": p.y]
    }
}
