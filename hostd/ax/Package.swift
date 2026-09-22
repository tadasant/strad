// swift-tools-version:5.9
import PackageDescription

// strad-hostd-ax: the native half of strad-hostd. It is what holds the
// Accessibility and Screen Recording grants, draws the "a caller is driving
// this machine" banner and menu-bar state, and speaks JSON lines to the daemon.
// One executable, no dependencies, so `swift build -c release` on a Mac with
// the Command Line Tools is the whole build.
let package = Package(
    name: "strad-hostd-ax",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "strad-hostd-ax",
            path: "Sources/strad-hostd-ax",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
            ]
        )
    ]
)
