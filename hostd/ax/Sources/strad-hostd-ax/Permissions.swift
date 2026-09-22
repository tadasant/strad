import ApplicationServices
import CoreGraphics
import Foundation

/// The two TCC grants this binary exists to hold. They are keyed on the code
/// signature, which is why the build signs with a stable identity: an ad-hoc
/// signature is a cdhash, and a cdhash changes on every build.
enum Permissions {
    static func accessibility() -> Bool {
        AXIsProcessTrusted()
    }

    static func screenRecording() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    static func hello() -> [String: Any] {
        [
            "version": VERSION,
            "pid": Int(getpid()),
            "executable": Bundle.main.executablePath ?? CommandLine.arguments[0],
            "trusted": [
                "accessibility": accessibility(),
                "screen_recording": screenRecording(),
            ],
        ]
    }

    /// Ask macOS to show its prompts. Both are asynchronous: the answer arrives
    /// in System Settings, not here, so the result is only "was it already
    /// granted".
    static func request() -> [String: Any] {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        let options = [key: true] as CFDictionary
        let ax = AXIsProcessTrustedWithOptions(options)
        let screen = CGRequestScreenCaptureAccess()
        return ["accessibility": ax, "screen_recording": screen]
    }

    static func requireAccessibility() throws {
        guard accessibility() else {
            throw HelperError(
                code: "accessibility_denied",
                message: "this helper is not trusted for Accessibility; add strad-hostd-ax under System Settings › Privacy & Security › Accessibility")
        }
    }

    static func requireScreenRecording() throws {
        guard screenRecording() else {
            throw HelperError(
                code: "screen_recording_denied",
                message: "this helper is not allowed to record the screen; add strad-hostd-ax under System Settings › Privacy & Security › Screen & System Audio Recording")
        }
    }
}
