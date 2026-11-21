// swift-tools-version:5.9
import Foundation
import PackageDescription

// strad-hostd-ax: the native half of strad-hostd. It is what holds the
// Accessibility and Screen Recording grants, draws the "a caller is driving
// this machine" banner and menu-bar state, and speaks JSON lines to the daemon.
// One executable, no dependencies, so `swift build -c release` on a Mac with
// the Command Line Tools is the whole build.
//
// Info.plist is linked into the binary's __TEXT,__info_plist section, which
// gives the bare executable a bundle identifier (com.strad.hostd-ax) without
// making it an .app: the menu bar remembers a status item by its owner's
// identifier, and a binary without one has nothing stable to be remembered
// by. The path is absolute because the linker does not run from this
// directory, and SwiftPM does not track the file: after editing it, run
// `swift package clean` before building.
let infoPlist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

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
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist]),
            ]
        )
    ]
)
