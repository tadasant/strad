import AppKit
import Foundation

/// The part of this helper that is for the person at the machine.
///
/// While any grant is in force, a strip sits at the top of the main display,
/// above everything, on every Space, saying who has control and why, with a
/// Kill button and a Disable button. The menu bar carries the same state. A
/// foreground grant (the one that moves the mouse) is red; background control
/// is orange. A grant that takes the mouse also ends on the first key or click
/// from the real keyboard: the person is back, and the machine is theirs.
///
/// The daemon owns the truth and pushes it here with `set_state`; buttons go
/// back to the daemon as events, and the daemon ends the grant. Nothing here
/// decides anything.
///
/// ONE controller at a time. The first connection to send `set_state` holds
/// the helper until it drops; a second connection's `set_state` is refused as
/// `busy`, and every op that acts on the machine is refused unless it comes
/// from the controller AND the controller's last state carried a grant that
/// covers it. That is what stops the helper being driven around the daemon's
/// grant table by another process of the same user — a shell-slug command,
/// say — while the daemon is up. It is not a privilege boundary: a process
/// running as the owner can stop the daemon, edit its config or replace this
/// binary, and the docs say so. It closes the cheap path, not the machine.
final class Banner: NSObject {
    private struct GrantRow {
        let id: String
        let server: String
        let purpose: String
        let foreground: Bool
    }

    private var grants: [GrantRow] = []
    private var disabled = false
    private var controlUrl: String?
    private weak var controller: Channel?
    private var panel: NSPanel?
    private var label: NSTextField?
    private var killButton: NSButton?
    private var background: NSView?
    private var statusItem: NSStatusItem?
    private var monitor: Any?

    var isEmpty: Bool { grants.isEmpty }

    /// What a request needs from the controller's last state to be allowed.
    enum Need {
        /// Any live grant on a computer-use server.
        case anyGrant
        /// A live grant that holds the mouse and keyboard.
        case foregroundGrant
    }

    /// Refuse an op that the daemon's own grant table would not allow.
    func authorize(_ channel: Channel, _ need: Need) throws {
        guard let c = controller, c === channel else {
            throw HelperError(code: "not_controller", message: "this connection has not sent set_state, or another connection holds the helper; only the daemon that reports grants may act")
        }
        switch need {
        case .anyGrant:
            guard !grants.isEmpty else {
                throw HelperError(code: "no_grant", message: "no grant is in force on this machine, so nothing may be read or driven")
            }
        case .foregroundGrant:
            guard grants.contains(where: { $0.foreground }) else {
                throw HelperError(code: "no_grant", message: "no foreground grant is in force, so the mouse, keyboard and screen may not be touched")
            }
        }
    }

    // MARK: state from the daemon

    func setState(_ args: Args, channel: Channel) throws {
        if let c = controller, c !== channel {
            throw HelperError(code: "busy", message: "another connection already controls this helper; it is released when that connection closes")
        }
        controller = channel
        disabled = args.bool("disabled", default: false)
        controlUrl = args.string("control_url")
        grants = ((args.raw["grants"] as? [[String: Any]]) ?? []).compactMap { g in
            guard let id = g["id"] as? String else { return nil }
            return GrantRow(
                id: id,
                server: g["server"] as? String ?? "?",
                purpose: g["purpose"] as? String ?? "",
                foreground: g["foreground"] as? Bool ?? false)
        }
        render()
    }

    /// The daemon went away: nothing it said still holds.
    func channelClosed(_ channel: Channel) {
        guard controller === channel else { return }
        controller = nil
        grants = []
        render()
    }

    private func emit(_ event: [String: Any]) {
        controller?.send(event)
    }

    // MARK: rendering

    private func render() {
        ensureStatusItem()
        let foreground = grants.contains { $0.foreground }
        if grants.isEmpty {
            panel?.orderOut(nil)
            stopMonitor()
        } else {
            showPanel(foreground: foreground)
            if foreground { startMonitor() } else { stopMonitor() }
        }
        renderStatusItem(foreground: foreground)
    }

    private func showPanel(foreground: Bool) {
        if panel == nil { buildPanel() }
        guard let panel = panel, let first = grants.first else { return }
        let more = grants.count > 1 ? " · and \(grants.count - 1) more" : ""
        let verb = foreground ? "is driving the mouse and keyboard" : "is controlling this Mac in the background"
        label?.stringValue = "\(first.server) \(verb): \(first.purpose)\(more)"
        killButton?.title = grants.count > 1 ? "Kill all" : "Kill"
        background?.layer?.backgroundColor = (foreground ? NSColor.systemRed : NSColor.systemOrange).cgColor
        // The primary display, where the menu bar is — not the key window's.
        if let screen = NSScreen.screens.first {
            let visible = screen.visibleFrame
            let width = min(880, visible.width - 24)
            panel.setFrame(NSRect(x: visible.midX - width / 2, y: visible.maxY - 46 - 6, width: width, height: 46), display: true)
        }
        panel.orderFrontRegardless()
    }

    private func buildPanel() {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 880, height: 46),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovable = false

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 880, height: 46))
        content.wantsLayer = true
        content.layer?.cornerRadius = 10
        content.autoresizingMask = [.width, .height]

        let text = NSTextField(labelWithString: "")
        text.textColor = .white
        text.font = .boldSystemFont(ofSize: 13)
        text.lineBreakMode = .byTruncatingTail
        text.frame = NSRect(x: 16, y: 13, width: 880 - 16 - 250, height: 20)
        text.autoresizingMask = [.width]
        content.addSubview(text)

        let kill = NSButton(title: "Kill", target: self, action: #selector(killTapped))
        kill.bezelStyle = .rounded
        kill.frame = NSRect(x: 880 - 240, y: 9, width: 80, height: 28)
        kill.autoresizingMask = [.minXMargin]
        content.addSubview(kill)

        let off = NSButton(title: "Disable everything", target: self, action: #selector(disableTapped))
        off.bezelStyle = .rounded
        off.frame = NSRect(x: 880 - 152, y: 9, width: 140, height: 28)
        off.autoresizingMask = [.minXMargin]
        content.addSubview(off)

        panel.contentView = content
        self.panel = panel
        self.label = text
        self.killButton = kill
        self.background = content
    }

    private func ensureStatusItem() {
        if statusItem != nil { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "circle.dashed", accessibilityDescription: "strad-hostd")
        item.button?.imagePosition = .imageLeading
        statusItem = item
    }

    private func renderStatusItem(foreground: Bool) {
        guard let item = statusItem else { return }
        let symbol: String
        let title: String
        if disabled {
            symbol = "power.circle"
            title = ""
        } else if grants.isEmpty {
            symbol = "circle.dashed"
            title = ""
        } else {
            symbol = foreground ? "cursorarrow.motionlines" : "dot.radiowaves.left.and.right"
            title = " \(grants.count)"
        }
        item.button?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "strad-hostd")
        item.button?.title = title
        item.button?.contentTintColor = grants.isEmpty ? nil : (foreground ? .systemRed : .systemOrange)

        let menu = NSMenu()
        let head = NSMenuItem(title: disabled ? "strad-hostd: remote control is OFF" : "strad-hostd: remote control is on", action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
        menu.addItem(.separator())
        if grants.isEmpty {
            let none = NSMenuItem(title: "Nobody has control of this Mac", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        }
        for g in grants {
            let purpose = g.purpose.count > 60 ? String(g.purpose.prefix(60)) + "…" : g.purpose
            let row = NSMenuItem(title: "Kill \(g.server) — \(purpose)", action: #selector(killGrant(_:)), keyEquivalent: "")
            row.target = self
            row.representedObject = g.id
            menu.addItem(row)
        }
        menu.addItem(.separator())
        let off = NSMenuItem(title: "Disable everything", action: #selector(disableTapped), keyEquivalent: "")
        off.target = self
        off.isEnabled = !disabled
        menu.addItem(off)
        if controlUrl != nil {
            let open = NSMenuItem(title: "Open the status page", action: #selector(openStatus), keyEquivalent: "")
            open.target = self
            menu.addItem(open)
        }
        item.menu = menu
    }

    // MARK: the owner's input during a foreground grant

    private func startMonitor() {
        if monitor != nil { return }
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
            guard let self = self else { return }
            if let cg = event.cgEvent, cg.getIntegerValueField(.eventSourceUserData) == eventTag { return }
            self.ownerIntervened()
        }
    }

    private func stopMonitor() {
        if let m = monitor { NSEvent.removeMonitor(m) }
        monitor = nil
    }

    private func ownerIntervened() {
        for g in grants where g.foreground {
            emit(["event": "owner_input", "grant_id": g.id])
        }
    }

    // MARK: buttons

    @objc private func killTapped() {
        for g in grants { emit(["event": "kill", "grant_id": g.id]) }
    }

    @objc private func killGrant(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String { emit(["event": "kill", "grant_id": id]) }
    }

    @objc private func disableTapped() {
        emit(["event": "disable"])
    }

    @objc private func openStatus() {
        if let s = controlUrl, let url = URL(string: s) { NSWorkspace.shared.open(url) }
    }
}
