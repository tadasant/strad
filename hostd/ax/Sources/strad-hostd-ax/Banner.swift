import AppKit
import Foundation

/// The part of this helper that is for the person at the machine.
///
/// While any grant is in force, a strip sits at the top of the main display,
/// above everything, on every Space, saying who has control and why, with a
/// Kill button and a Disable button. It has three sizes, and the owner's pick
/// is remembered in this helper's preferences: a SLIVER (a count and Kill),
/// COMPACT (each grant's server, session, full purpose and the call it is in
/// the middle of), and DETAILS (adds when it started, when it expires, the
/// commands left running and the last few calls, with a Kill per grant). Kill
/// is on every size. The menu bar carries the same state. A
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
/// A banner button that knows which grant it is for.
final class GrantButton: NSButton {
    var grantId = ""
    var url: URL?
}

final class Banner: NSObject {
    private struct Call {
        let tool: String
        /// Already scrubbed of obvious secrets and capped by the daemon.
        let summary: String
        let startedAt: Date
        let endedAt: Date?
        let ok: Bool
    }

    private struct GrantRow {
        let id: String
        let server: String
        let purpose: String
        let foreground: Bool
        let startedAt: Date?
        let expiresAt: Date?
        let calls: Int
        /// The caller's own claim of the session it acts for. Display only.
        let session: String?
        let sessionURL: URL?
        let inFlight: [Call]
        let background: [String]
        let recent: [Call]
    }

    /// One grant's views, kept across pushes so its buttons stay put.
    private struct RowViews {
        let container: NSStackView
        let line: NSStackView
        let lineWidth: NSLayoutConstraint
        let title: NSTextField
        let session: GrantButton
        let kill: GrantButton
        let purpose: NSTextField
        let now: NSTextField
        let timing: NSTextField
        let recent: NSTextField
    }

    enum Mode: String {
        case sliver, compact, expanded
    }

    private static let modeKey = "bannerMode"

    private var grants: [GrantRow] = []
    private var disabled = false
    private var controlUrl: String?
    private weak var controller: Channel?
    private var mode: Mode = Mode(rawValue: UserDefaults.standard.string(forKey: Banner.modeKey) ?? "") ?? .compact
    private var panel: NSPanel?
    private var root: NSView?
    private var stack: NSStackView?
    private var insetConstraints: [NSLayoutConstraint] = []
    private var sliverRow: NSStackView?
    private var sliverLabel: NSTextField?
    private var sliverKill: NSButton?
    private var headerRow: NSStackView?
    private var headerWidth: NSLayoutConstraint?
    private var titleLabel: NSTextField?
    private var detailsButton: NSButton?
    private var killButton: NSButton?
    private var rowsStack: NSStackView?
    private var rows: [String: RowViews] = [:]
    private var rowOrder: [String] = []
    private var ticker: Timer?
    private var statusItem: NSStatusItem?
    private var monitor: Any?

    var isEmpty: Bool { grants.isEmpty }

    /// What a request needs from the controller's last state to be allowed.
    enum Need {
        /// The controlling connection, whatever its grants.
        case controller
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
        case .controller:
            return
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
                foreground: g["foreground"] as? Bool ?? false,
                startedAt: Banner.date(g["started_at"]),
                expiresAt: Banner.date(g["expires_at"]),
                calls: (g["calls"] as? NSNumber)?.intValue ?? 0,
                session: g["session"] as? String,
                sessionURL: Banner.httpsURL(g["session_url"]),
                inFlight: Banner.calls(g["in_flight"]),
                background: (g["background"] as? [Any])?.compactMap { $0 as? String } ?? [],
                recent: Banner.calls(g["recent"]))
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

    private static func date(_ value: Any?) -> Date? {
        guard let n = value as? NSNumber else { return nil }
        return Date(timeIntervalSince1970: n.doubleValue / 1000)
    }

    private static func calls(_ value: Any?) -> [Call] {
        ((value as? [[String: Any]]) ?? []).map { c in
            let tool = c["tool"] as? String ?? "?"
            return Call(
                tool: tool,
                summary: c["summary"] as? String ?? tool,
                startedAt: date(c["started_at"]) ?? Date(),
                endedAt: date(c["ended_at"]),
                ok: c["ok"] as? Bool ?? true)
        }
    }

    /// Only an https URL is ever opened. The daemon already refuses anything
    /// else; this is the second check, at the place that does the opening.
    private static func httpsURL(_ value: Any?) -> URL? {
        guard let s = value as? String, let url = URL(string: s),
              url.scheme?.lowercased() == "https", url.host != nil else { return nil }
        return url
    }

    // MARK: rendering

    private func render() {
        ensureStatusItem()
        let foreground = grants.contains { $0.foreground }
        if grants.isEmpty {
            panel?.orderOut(nil)
            stopMonitor()
            stopTicker()
        } else {
            showPanel(foreground: foreground)
            if foreground { startMonitor() } else { stopMonitor() }
            startTicker()
        }
        renderStatusItem(foreground: foreground)
    }

    private func showPanel(foreground: Bool) {
        if panel == nil { buildPanel() }
        guard let panel = panel else { return }
        syncRows()
        refreshText()
        root?.layer?.backgroundColor = (foreground ? NSColor.systemRed : NSColor.systemOrange).cgColor
        layoutPanel()
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

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.detachesHiddenViews = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        let top = stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 10)
        let leading = stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12)
        // Below required, so a panel cut to the screen's height clips the
        // bottom of the detail and never the header with the Kill button.
        let bottom = content.bottomAnchor.constraint(equalTo: stack.bottomAnchor, constant: 10)
        bottom.priority = .defaultHigh
        let trailing = content.trailingAnchor.constraint(equalTo: stack.trailingAnchor, constant: 12)
        trailing.priority = .defaultHigh
        NSLayoutConstraint.activate([top, leading, bottom, trailing])
        insetConstraints = [top, leading, bottom, trailing]

        // The sliver: a count, a way back, and Kill.
        let sliverText = label(.boldSystemFont(ofSize: 11), wraps: false)
        sliverText.setContentHuggingPriority(.required, for: .horizontal)
        sliverText.setContentCompressionResistancePriority(.required, for: .horizontal)
        let restore = button("Show", #selector(restoreTapped), small: true)
        restore.toolTip = "Show what has control of this Mac"
        let sliverKill = button("Kill", #selector(killTapped), small: true)
        let sliver = NSStackView(views: [sliverText, restore, sliverKill])
        sliver.orientation = .horizontal
        sliver.spacing = 6
        stack.addArrangedSubview(sliver)

        // The header: what is going on, the size controls, and Kill.
        let title = label(.boldSystemFont(ofSize: 13), wraps: false)
        let details = button("Details", #selector(detailsTapped))
        let minimize = button("Minimize", #selector(minimizeTapped))
        minimize.toolTip = "Shrink this to a sliver; Kill stays on it"
        let kill = button("Kill", #selector(killTapped))
        let off = button("Disable everything", #selector(disableTapped))
        let header = NSStackView(views: [title, details, minimize, kill, off])
        header.orientation = .horizontal
        header.spacing = 8
        let headerWidth = header.widthAnchor.constraint(equalToConstant: 856)
        headerWidth.isActive = true
        stack.addArrangedSubview(header)

        let rowsView = NSStackView()
        rowsView.orientation = .vertical
        rowsView.alignment = .leading
        rowsView.spacing = 10
        rowsView.detachesHiddenViews = true
        stack.addArrangedSubview(rowsView)

        panel.contentView = content
        self.panel = panel
        self.root = content
        self.stack = stack
        self.sliverRow = sliver
        self.sliverLabel = sliverText
        self.sliverKill = sliverKill
        self.headerRow = header
        self.headerWidth = headerWidth
        self.titleLabel = title
        self.detailsButton = details
        self.killButton = kill
        self.rowsStack = rowsView
    }

    /// Rows are rebuilt only when the set of grants changes. Between those,
    /// their text is updated in place, so a Kill button is never swapped out
    /// from under a click while a caller's calls stream in.
    private func syncRows() {
        guard let rowsStack = rowsStack else { return }
        let ids = grants.map { $0.id }
        if ids != rowOrder {
            for id in rowOrder where !ids.contains(id) {
                if let row = rows[id] {
                    rowsStack.removeArrangedSubview(row.container)
                    row.container.removeFromSuperview()
                    rows[id] = nil
                }
            }
            for v in rowsStack.arrangedSubviews { rowsStack.removeArrangedSubview(v) }
            for g in grants {
                let row = rows[g.id] ?? makeRow(id: g.id)
                rows[g.id] = row
                rowsStack.addArrangedSubview(row.container)
            }
            rowOrder = ids
        }
    }

    private func makeRow(id: String) -> RowViews {
        let title = label(.boldSystemFont(ofSize: 12), wraps: false)
        let session = GrantButton(title: "", target: self, action: #selector(openSession(_:)))
        session.isBordered = false
        session.grantId = id
        session.setContentHuggingPriority(.required, for: .horizontal)
        let kill = GrantButton(title: "Kill", target: self, action: #selector(killOne(_:)))
        kill.bezelStyle = .rounded
        kill.controlSize = .small
        kill.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        kill.grantId = id
        kill.setContentHuggingPriority(.required, for: .horizontal)
        kill.setContentCompressionResistancePriority(.required, for: .horizontal)
        let line = NSStackView(views: [title, session, kill])
        line.orientation = .horizontal
        line.spacing = 8

        let purpose = label(.systemFont(ofSize: 12), wraps: true)
        let now = label(.monospacedSystemFont(ofSize: 11, weight: .regular), wraps: true)
        let timing = label(.systemFont(ofSize: 11), wraps: true, alpha: 0.85)
        let recent = label(.monospacedSystemFont(ofSize: 11, weight: .regular), wraps: true, alpha: 0.85)

        let container = NSStackView(views: [line, purpose, now, timing, recent])
        container.orientation = .vertical
        container.alignment = .leading
        container.spacing = 3
        container.detachesHiddenViews = true
        let lineWidth = line.widthAnchor.constraint(equalToConstant: 856)
        lineWidth.isActive = true
        return RowViews(
            container: container, line: line, lineWidth: lineWidth, title: title, session: session,
            kill: kill, purpose: purpose, now: now, timing: timing, recent: recent)
    }

    /// Every string, recomputed: on each push and on the one-second tick that
    /// keeps "running for" honest between pushes.
    private func refreshText() {
        let now = Date()
        let foreground = grants.contains { $0.foreground }
        let expanded = mode == .expanded
        let many = grants.count > 1

        sliverRow?.isHidden = mode != .sliver
        headerRow?.isHidden = mode == .sliver
        rowsStack?.isHidden = mode == .sliver

        let busy = grants.flatMap { $0.inFlight }.first
        var sliverText = "\(foreground ? "●" : "○") \(grants.count) in control"
        if let call = busy { sliverText += " · \(Banner.clip(call.tool, 28))" }
        sliverLabel?.stringValue = sliverText
        sliverKill?.title = many ? "Kill all" : "Kill"

        if let first = grants.first, !many {
            let verb = first.foreground ? "is driving the mouse and keyboard" : "is controlling this Mac in the background"
            titleLabel?.stringValue = "\(first.server) \(verb)"
        } else {
            let driving = foreground ? " · one is driving the mouse and keyboard" : ""
            titleLabel?.stringValue = "\(grants.count) grants have control of this Mac\(driving)"
        }
        detailsButton?.title = expanded ? "Less" : "Details"
        killButton?.title = many ? "Kill all" : "Kill"

        for g in grants {
            guard let row = rows[g.id] else { continue }
            row.title.stringValue = many
                ? "\(g.server) · \(g.foreground ? "mouse and keyboard" : "background")"
                : (g.foreground ? "Mouse and keyboard" : "Background")
            if let session = g.session {
                row.session.isHidden = false
                row.session.url = g.sessionURL
                row.session.isEnabled = g.sessionURL != nil
                let text = g.sessionURL != nil ? "for \(session) ↗" : "for \(session)"
                row.session.attributedTitle = NSAttributedString(string: text, attributes: [
                    .foregroundColor: NSColor.white,
                    .font: NSFont.systemFont(ofSize: 12),
                    .underlineStyle: g.sessionURL != nil ? NSUnderlineStyle.single.rawValue : 0,
                ])
                let target = g.sessionURL.map { ": \($0.absoluteString)" } ?? ""
                row.session.toolTip = "The session the caller says it acts for (its own claim)\(target)"
            } else {
                row.session.isHidden = true
            }
            row.kill.isHidden = !many && !expanded
            row.purpose.stringValue = g.purpose

            var lines: [String] = []
            let shown = expanded ? g.inFlight : Array(g.inFlight.prefix(1))
            for c in shown {
                lines.append("▶ \(c.summary) — running \(Banner.span(now.timeIntervalSince(c.startedAt)))")
            }
            if !expanded && g.inFlight.count > 1 { lines.append("  and \(g.inFlight.count - 1) more call(s) running") }
            for cmd in expanded ? g.background : Array(g.background.prefix(1)) {
                lines.append("⟳ still running: \(cmd)")
            }
            if lines.isEmpty {
                if let last = g.recent.first {
                    lines.append("idle · last: \(last.summary) (\(Banner.span(now.timeIntervalSince(last.endedAt ?? last.startedAt))) ago)")
                } else {
                    lines.append("no calls yet")
                }
            }
            row.now.stringValue = lines.joined(separator: "\n")
            row.now.maximumNumberOfLines = expanded ? 0 : 3

            row.timing.isHidden = !expanded
            row.recent.isHidden = !expanded || g.recent.isEmpty
            if expanded {
                var parts: [String] = []
                if let started = g.startedAt {
                    parts.append("started \(Banner.clock.string(from: started)) (\(Banner.span(now.timeIntervalSince(started))) ago)")
                }
                if let expires = g.expiresAt {
                    parts.append("expires in \(Banner.span(expires.timeIntervalSince(now)))")
                }
                parts.append("\(g.calls) call\(g.calls == 1 ? "" : "s")")
                row.timing.stringValue = parts.joined(separator: " · ")
                row.recent.stringValue = (["Recent:"] + g.recent.map { c in
                    let took = c.endedAt.map { Banner.span($0.timeIntervalSince(c.startedAt)) } ?? "?"
                    let ago = Banner.span(now.timeIntervalSince(c.endedAt ?? c.startedAt))
                    return "\(c.ok ? "✓" : "✗") \(c.summary) — \(took), \(ago) ago"
                }).joined(separator: "\n")
            }
        }
    }

    /// The panel's size follows its content: a sliver, a strip, or the detail
    /// cut to the screen. The primary display, where the menu bar is.
    private func layoutPanel() {
        guard let panel = panel, let stack = stack, let screen = NSScreen.screens.first else { return }
        let visible = screen.visibleFrame
        let sliver = mode == .sliver
        let inset: CGFloat = sliver ? 4 : 10
        let side: CGFloat = sliver ? 8 : 12
        insetConstraints[0].constant = inset
        insetConstraints[1].constant = side
        insetConstraints[2].constant = inset
        insetConstraints[3].constant = side
        root?.layer?.cornerRadius = sliver ? 8 : 10

        let width = min(880, visible.width - 24)
        let inner = width - 2 * side
        headerWidth?.constant = inner
        for row in rows.values {
            row.lineWidth.constant = inner
            for l in [row.purpose, row.now, row.timing, row.recent] { l.preferredMaxLayoutWidth = inner }
        }
        stack.layoutSubtreeIfNeeded()
        let fit = stack.fittingSize
        let w = sliver ? fit.width + 2 * side : width
        let h = min(fit.height + 2 * inset, visible.height - 12)
        panel.setFrame(NSRect(x: visible.midX - w / 2, y: visible.maxY - h - 6, width: w, height: h), display: true)
    }

    private func startTicker() {
        if ticker != nil { return }
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self, !self.grants.isEmpty else { return }
            self.refreshText()
            self.layoutPanel()
        }
        RunLoop.main.add(t, forMode: .common)
        ticker = t
    }

    private func stopTicker() {
        ticker?.invalidate()
        ticker = nil
    }

    private func setMode(_ next: Mode) {
        mode = next
        UserDefaults.standard.set(next.rawValue, forKey: Banner.modeKey)
        render()
    }

    private func label(_ font: NSFont, wraps: Bool, alpha: CGFloat = 1) -> NSTextField {
        let t = wraps ? NSTextField(wrappingLabelWithString: "") : NSTextField(labelWithString: "")
        t.font = font
        t.textColor = NSColor.white.withAlphaComponent(alpha)
        t.isSelectable = false
        if wraps {
            t.cell?.truncatesLastVisibleLine = true
        } else {
            t.lineBreakMode = .byTruncatingTail
            t.setContentHuggingPriority(.defaultLow, for: .horizontal)
            t.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }
        return t
    }

    private func button(_ title: String, _ action: Selector, small: Bool = false) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.bezelStyle = .rounded
        if small {
            b.controlSize = .small
            b.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        }
        b.setContentHuggingPriority(.required, for: .horizontal)
        b.setContentCompressionResistancePriority(.required, for: .horizontal)
        return b
    }

    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f
    }()

    static func span(_ seconds: TimeInterval) -> String {
        let t = max(0, Int(seconds.rounded()))
        if t < 60 { return "\(t)s" }
        if t < 3600 { return "\(t / 60)m \(t % 60)s" }
        return "\(t / 3600)h \((t % 3600) / 60)m"
    }

    static func clip(_ s: String, _ max: Int) -> String {
        s.count > max ? String(s.prefix(max - 1)) + "…" : s
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
            let purpose = Banner.clip(g.purpose, 60)
            let who = g.session.map { " (for \($0))" } ?? ""
            let row = NSMenuItem(title: "Kill \(g.server)\(who) — \(purpose)", action: #selector(killGrant(_:)), keyEquivalent: "")
            row.target = self
            row.representedObject = g.id
            menu.addItem(row)
            if let call = g.inFlight.first {
                let now = NSMenuItem(title: "    now: \(Banner.clip(call.summary, 80))", action: nil, keyEquivalent: "")
                now.isEnabled = false
                menu.addItem(now)
            }
        }
        if !grants.isEmpty {
            menu.addItem(.separator())
            for (m, name) in [(Mode.sliver, "Banner: sliver"), (Mode.compact, "Banner: compact"), (Mode.expanded, "Banner: details")] {
                let pick = NSMenuItem(title: name, action: #selector(pickMode(_:)), keyEquivalent: "")
                pick.target = self
                pick.representedObject = m.rawValue
                pick.state = mode == m ? .on : .off
                menu.addItem(pick)
            }
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

    @objc private func killOne(_ sender: GrantButton) {
        emit(["event": "kill", "grant_id": sender.grantId])
    }

    @objc private func openSession(_ sender: GrantButton) {
        if let url = sender.url, url.scheme?.lowercased() == "https" { NSWorkspace.shared.open(url) }
    }

    @objc private func detailsTapped() {
        setMode(mode == .expanded ? .compact : .expanded)
    }

    @objc private func minimizeTapped() {
        setMode(.sliver)
    }

    @objc private func restoreTapped() {
        setMode(.compact)
    }

    @objc private func pickMode(_ sender: NSMenuItem) {
        if let raw = sender.representedObject as? String, let m = Mode(rawValue: raw) { setMode(m) }
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
