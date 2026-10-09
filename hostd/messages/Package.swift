// swift-tools-version:5.9
import PackageDescription

// strad-hostd-messages: the native half of strad-hostd's `messages` server. It
// is the ONE process on the machine that holds Full Disk Access for
// strad-hostd, it opens ~/Library/Messages/chat.db read-only, and it speaks
// JSON lines to the daemon. A separate binary from strad-hostd-ax on purpose:
// that helper can post mouse and keyboard input, and the grant that reads
// every message should not sit beside it.
//
// `SafeUnarchive` is a few lines of Objective-C, because `NSUnarchiver`
// reports a malformed archive by raising an NSException, which Swift cannot
// catch: without the @try around it, one odd message body would take the
// whole helper down.
let package = Package(
    name: "strad-hostd-messages",
    platforms: [.macOS(.v13)],
    targets: [
        .target(
            name: "SafeUnarchive",
            path: "Sources/SafeUnarchive",
            linkerSettings: [.linkedFramework("Foundation")]
        ),
        .executableTarget(
            name: "strad-hostd-messages",
            dependencies: ["SafeUnarchive"],
            path: "Sources/strad-hostd-messages",
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
    ]
)
