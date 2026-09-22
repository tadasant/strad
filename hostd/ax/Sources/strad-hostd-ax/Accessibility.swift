import AppKit
import ApplicationServices
import Foundation

/// Same element, same id, across reads: AXUIElement is CF-hashable, so a
/// dictionary keyed on it hands `e12` back for the button `e12` named last time.
private struct ElementKey: Hashable {
    let element: AXUIElement
    static func == (a: ElementKey, b: ElementKey) -> Bool { CFEqual(a.element, b.element) }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
}

/// Roles a caller can act on, for `interactive_only` trees.
private let interactiveRoles: Set<String> = [
    "AXButton", "AXPopUpButton", "AXMenuButton", "AXCheckBox", "AXRadioButton", "AXTextField",
    "AXTextArea", "AXComboBox", "AXSlider", "AXIncrementor", "AXLink", "AXMenuItem", "AXMenuBarItem",
    "AXTabGroup", "AXDisclosureTriangle", "AXColorWell", "AXSearchField", "AXSecureTextField",
    "AXCell", "AXRow", "AXOutlineRow", "AXToolbar", "AXSwitch", "AXToggle",
]

/// Roles whose text is what a person reads off the window.
private let textRoles: Set<String> = [
    "AXStaticText", "AXTextField", "AXTextArea", "AXHeading", "AXLink", "AXButton", "AXMenuItem",
    "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXCell", "AXSearchField", "AXTab",
    "AXValueIndicator", "AXWindow", "AXSheet", "AXDialog",
]

private let friendlyActions: [String: String] = [
    "press": "AXPress", "show_menu": "AXShowMenu", "pick": "AXPick", "confirm": "AXConfirm",
    "cancel": "AXCancel", "raise": "AXRaise", "increment": "AXIncrement", "decrement": "AXDecrement",
    "show_alternate_ui": "AXShowAlternateUI", "show_default_ui": "AXShowDefaultUI",
    "scroll_to_visible": "AXScrollToVisible",
]

final class Accessibility {
    private var ids: [ElementKey: String] = [:]
    private var elements: [String: AXUIElement] = [:]
    private var seq = 0

    // MARK: apps

    func listApps() -> [String: Any] {
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let apps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map { app -> [String: Any] in
                [
                    "pid": Int(app.processIdentifier),
                    "name": app.localizedName ?? "",
                    "bundle_id": app.bundleIdentifier ?? "",
                    "frontmost": app.processIdentifier == front,
                    "hidden": app.isHidden,
                ]
            }
        return ["apps": apps]
    }

    private func resolveApp(_ spec: String) throws -> NSRunningApplication {
        let all = NSWorkspace.shared.runningApplications
        if let pid = Int32(spec), let app = all.first(where: { $0.processIdentifier == pid }) {
            return app
        }
        let regular = all.filter { $0.activationPolicy == .regular }
        let wanted = spec.lowercased()
        if let app = regular.first(where: { ($0.bundleIdentifier ?? "").lowercased() == wanted }) { return app }
        if let app = regular.first(where: { ($0.localizedName ?? "").lowercased() == wanted }) { return app }
        let partial = regular.filter {
            ($0.localizedName ?? "").lowercased().contains(wanted)
                || ($0.bundleIdentifier ?? "").lowercased().contains(wanted)
        }
        if partial.count == 1 { return partial[0] }
        if partial.count > 1 {
            let names = partial.map { $0.localizedName ?? "?" }.joined(separator: ", ")
            throw HelperError(code: "ambiguous_app", message: "\"\(spec)\" matches several apps (\(names)); use the bundle id or pid from list_apps")
        }
        throw HelperError(code: "no_such_app", message: "no running app matches \"\(spec)\"; list_apps shows the ones there are")
    }

    private func appElement(_ app: NSRunningApplication) -> AXUIElement {
        let element = AXUIElementCreateApplication(app.processIdentifier)
        // A hung app must not hang the helper, and with it every other caller.
        AXUIElementSetMessagingTimeout(element, 3.0)
        // Electron exposes a tree only once asked to; the attribute is ignored by
        // everything else.
        AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        return element
    }

    // MARK: ids

    private func idFor(_ element: AXUIElement) -> String {
        let key = ElementKey(element: element)
        if let id = ids[key] { return id }
        if elements.count > 20000 {
            ids.removeAll()
            elements.removeAll()
        }
        seq += 1
        let id = "e\(seq)"
        ids[key] = id
        elements[id] = element
        return id
    }

    private func element(_ id: String) throws -> AXUIElement {
        guard let element = elements[id] else {
            throw HelperError(code: "unknown_element", message: "no element \"\(id)\": ids come from read_ui_tree or find_elements on this helper, and do not survive its restart")
        }
        return element
    }

    // MARK: attributes

    private func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        guard err == .success, let v = value else { return nil }
        return v
    }

    private func string(_ element: AXUIElement, _ name: String) -> String? {
        guard let v = attribute(element, name) else { return nil }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        if let u = v as? URL { return u.absoluteString }
        if let a = v as? NSAttributedString { return a.string }
        return nil
    }

    private func bool(_ element: AXUIElement, _ name: String) -> Bool? {
        guard let v = attribute(element, name) else { return nil }
        if let n = v as? NSNumber { return n.boolValue }
        return nil
    }

    private func children(_ element: AXUIElement) -> [AXUIElement] {
        (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }

    private func frame(_ element: AXUIElement) -> [String: Any]? {
        guard let p = attribute(element, kAXPositionAttribute),
              let s = attribute(element, kAXSizeAttribute),
              CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID()
        else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(p as! AXValue, .cgPoint, &point)
        AXValueGetValue(s as! AXValue, .cgSize, &size)
        return ["x": point.x, "y": point.y, "w": size.width, "h": size.height]
    }

    private func actions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else {
            return []
        }
        return list
    }

    private func clipped(_ s: String, _ max: Int = 200) -> String {
        s.count <= max ? s : String(s.prefix(max)) + "…"
    }

    /// One node, no children: what every listing here is made of.
    private func describe(_ element: AXUIElement) -> [String: Any] {
        var node: [String: Any] = ["id": idFor(element)]
        let role = string(element, kAXRoleAttribute) ?? "?"
        node["role"] = role
        if let s = string(element, kAXSubroleAttribute) { node["subrole"] = s }
        if let t = string(element, kAXTitleAttribute), !t.isEmpty { node["title"] = clipped(t) }
        if role != "AXSecureTextField", let v = string(element, kAXValueAttribute), !v.isEmpty { node["value"] = clipped(v) }
        if let d = string(element, kAXDescriptionAttribute), !d.isEmpty { node["description"] = clipped(d) }
        if let p = string(element, "AXPlaceholderValue"), !p.isEmpty { node["placeholder"] = clipped(p) }
        if let i = string(element, kAXIdentifierAttribute), !i.isEmpty { node["identifier"] = clipped(i) }
        if bool(element, kAXEnabledAttribute) == false { node["enabled"] = false }
        if bool(element, kAXFocusedAttribute) == true { node["focused"] = true }
        if bool(element, kAXSelectedAttribute) == true { node["selected"] = true }
        if let f = frame(element) { node["frame"] = f }
        let acts = actions(element)
        if !acts.isEmpty { node["actions"] = acts }
        return node
    }

    private func isInteractive(_ node: [String: Any]) -> Bool {
        if let role = node["role"] as? String, interactiveRoles.contains(role) { return true }
        if let acts = node["actions"] as? [String], acts.contains(where: { $0 != "AXScrollToVisible" && $0 != "AXShowMenu" }) {
            return true
        }
        return false
    }

    // MARK: roots

    private func windows(_ app: AXUIElement) -> [AXUIElement] {
        (attribute(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    }

    private func windowList(_ app: AXUIElement) -> [[String: Any]] {
        windows(app).enumerated().map { i, w in
            var entry: [String: Any] = ["index": i, "id": idFor(w), "title": string(w, kAXTitleAttribute) ?? ""]
            if bool(w, kAXMainAttribute) == true { entry["main"] = true }
            if bool(w, kAXMinimizedAttribute) == true { entry["minimized"] = true }
            return entry
        }
    }

    /// What `app`, `window` and `element` in a request point at.
    private func root(_ args: Args) throws -> (root: AXUIElement, app: NSRunningApplication?, appElement: AXUIElement?) {
        if let id = args.string("element") {
            let el = try element(id)
            return (el, nil, nil)
        }
        let app = try resolveApp(args.requireString("app"))
        let appEl = appElement(app)
        let scope = args.string("scope") ?? "window"
        if scope == "app" { return (appEl, app, appEl) }
        if scope == "menu_bar" {
            guard let bar = attribute(appEl, kAXMenuBarAttribute) else {
                throw HelperError(code: "no_menu_bar", message: "\(app.localizedName ?? "the app") exposes no menu bar")
            }
            return (bar as! AXUIElement, app, appEl)
        }
        let wins = windows(appEl)
        if let spec = args.raw["window"] {
            if let n = spec as? NSNumber {
                guard n.intValue >= 0, n.intValue < wins.count else {
                    throw HelperError(code: "no_such_window", message: "\(app.localizedName ?? "the app") has \(wins.count) window(s); index \(n.intValue) is out of range")
                }
                return (wins[n.intValue], app, appEl)
            }
            if let title = spec as? String {
                let wanted = title.lowercased()
                if let w = wins.first(where: { (string($0, kAXTitleAttribute) ?? "").lowercased().contains(wanted) }) {
                    return (w, app, appEl)
                }
                throw HelperError(code: "no_such_window", message: "no window of \(app.localizedName ?? "the app") has \"\(title)\" in its title")
            }
        }
        if let focused = attribute(appEl, kAXFocusedWindowAttribute) { return (focused as! AXUIElement, app, appEl) }
        if let main = attribute(appEl, kAXMainWindowAttribute) { return (main as! AXUIElement, app, appEl) }
        if let first = wins.first { return (first, app, appEl) }
        // No window at all: the app element still carries the menu bar.
        return (appEl, app, appEl)
    }

    private func header(_ app: NSRunningApplication?, _ appEl: AXUIElement?) -> [String: Any] {
        guard let app = app, let appEl = appEl else { return [:] }
        return [
            "app": ["pid": Int(app.processIdentifier), "name": app.localizedName ?? "", "bundle_id": app.bundleIdentifier ?? ""],
            "windows": windowList(appEl),
        ]
    }

    // MARK: ops

    func tree(_ args: Args) throws -> [String: Any] {
        try Permissions.requireAccessibility()
        let (root, app, appEl) = try self.root(args)
        let maxDepth = max(0, min(args.int("max_depth", default: 8), 40))
        var budget = max(1, min(args.int("max_nodes", default: 400), 5000))
        let interactiveOnly = args.bool("interactive_only", default: false)
        var truncated = false
        func walk(_ element: AXUIElement, depth: Int) -> [String: Any]? {
            if budget <= 0 {
                truncated = true
                return nil
            }
            budget -= 1
            var node = describe(element)
            if depth < maxDepth {
                var kids: [[String: Any]] = []
                for child in children(element) {
                    if budget <= 0 {
                        truncated = true
                        break
                    }
                    if let c = walk(child, depth: depth + 1) { kids.append(c) }
                }
                if !kids.isEmpty { node["children"] = kids }
            } else if !children(element).isEmpty {
                node["children_omitted"] = true
            }
            if interactiveOnly, !isInteractive(node), (node["children"] as? [[String: Any]])?.isEmpty ?? true, depth > 0 {
                return nil
            }
            return node
        }
        var result = header(app, appEl)
        result["tree"] = walk(root, depth: 0) ?? [:]
        result["truncated"] = truncated
        return result
    }

    func find(_ args: Args) throws -> [String: Any] {
        try Permissions.requireAccessibility()
        let (root, app, appEl) = try self.root(args)
        let role = args.string("role").map { r -> String in
            let lower = r.lowercased()
            return lower.hasPrefix("ax") ? "AX" + r.dropFirst(2) : "AX" + r.prefix(1).uppercased() + r.dropFirst()
        }
        let text = args.string("text")?.lowercased()
        let maxResults = max(1, min(args.int("max_results", default: 25), 200))
        var visited = 0
        var matches: [[String: Any]] = []
        func matchesText(_ node: [String: Any]) -> Bool {
            guard let text = text else { return true }
            for key in ["title", "value", "description", "placeholder", "identifier"] {
                if let s = node[key] as? String, s.lowercased().contains(text) { return true }
            }
            return false
        }
        func walk(_ element: AXUIElement, depth: Int) {
            if matches.count >= maxResults || visited >= 6000 || depth > 40 { return }
            visited += 1
            let node = describe(element)
            let roleOk = role == nil || (node["role"] as? String)?.lowercased() == role!.lowercased()
            if roleOk, matchesText(node) { matches.append(node) }
            for child in children(element) { walk(child, depth: depth + 1) }
        }
        walk(root, depth: 0)
        var result = header(app, appEl)
        result["elements"] = matches
        result["visited"] = visited
        return result
    }

    func get(_ args: Args) throws -> [String: Any] {
        try Permissions.requireAccessibility()
        let el = try element(args.requireString("element"))
        var node = describe(el)
        var names: CFArray?
        if AXUIElementCopyAttributeNames(el, &names) == .success, let list = names as? [String] {
            var extra: [String: Any] = [:]
            for name in list where node[name] == nil {
                if name == kAXChildrenAttribute || name == kAXParentAttribute || name == kAXWindowAttribute
                    || name == kAXTopLevelUIElementAttribute || name == kAXValueAttribute && node["role"] as? String == "AXSecureTextField"
                {
                    continue
                }
                if let s = string(el, name) { extra[name] = clipped(s, 500) }
            }
            node["attributes"] = extra
            node["attribute_names"] = list
        }
        node["child_count"] = children(el).count
        if let parent = attribute(el, kAXParentAttribute) { node["parent"] = idFor(parent as! AXUIElement) }
        return node
    }

    func perform(_ args: Args) throws -> [String: Any] {
        try Permissions.requireAccessibility()
        let el = try element(args.requireString("element"))
        let requested = try args.requireString("action")
        if requested == "focus" {
            let err = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            guard err == .success else { throw axError(err, "focus") }
            return ["performed": "focus"]
        }
        let action = friendlyActions[requested] ?? (requested.hasPrefix("AX") ? requested : nil)
        guard let action = action else {
            throw HelperError(code: "bad_action", message: "unknown action \"\(requested)\"; use one of \(friendlyActions.keys.sorted().joined(separator: ", ")), focus, or a raw AX… name from the element's actions")
        }
        let available = actions(el)
        guard available.contains(action) else {
            throw HelperError(code: "action_unavailable", message: "that element does not offer \(action); it offers \(available.isEmpty ? "no actions" : available.joined(separator: ", "))")
        }
        let err = AXUIElementPerformAction(el, action as CFString)
        guard err == .success else { throw axError(err, action) }
        return ["performed": action, "element": describe(el)]
    }

    func setValue(_ args: Args) throws -> [String: Any] {
        try Permissions.requireAccessibility()
        let el = try element(args.requireString("element"))
        guard let raw = args.raw["value"] else {
            throw HelperError(code: "bad_args", message: "value is required")
        }
        let value: CFTypeRef
        if let s = raw as? String {
            value = s as CFString
        } else if let n = raw as? NSNumber {
            value = n
        } else {
            throw HelperError(code: "bad_args", message: "value must be a string, number or boolean")
        }
        if bool(el, "AXSettable") == false {
            throw HelperError(code: "not_settable", message: "that element's value cannot be set")
        }
        let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value)
        guard err == .success else { throw axError(err, "set value") }
        return ["set": true, "element": describe(el)]
    }

    func readText(_ args: Args) throws -> [String: Any] {
        try Permissions.requireAccessibility()
        let (root, app, appEl) = try self.root(args)
        let maxChars = max(200, min(args.int("max_chars", default: 20000), 400000))
        var lines: [String] = []
        var total = 0
        var visited = 0
        var truncated = false
        func walk(_ element: AXUIElement, depth: Int) {
            if truncated || visited >= 6000 || depth > 40 { return }
            visited += 1
            let role = string(element, kAXRoleAttribute) ?? ""
            if textRoles.contains(role) {
                var parts: [String] = []
                if let t = string(element, kAXTitleAttribute), !t.isEmpty { parts.append(t) }
                if role != "AXSecureTextField", let v = string(element, kAXValueAttribute), !v.isEmpty, !parts.contains(v) { parts.append(v) }
                if parts.isEmpty, let d = string(element, kAXDescriptionAttribute), !d.isEmpty { parts.append(d) }
                let line = parts.joined(separator: ": ")
                if !line.isEmpty, lines.last != line {
                    total += line.count + 1
                    if total > maxChars {
                        truncated = true
                        return
                    }
                    lines.append(line)
                }
            }
            for child in children(element) { walk(child, depth: depth + 1) }
        }
        walk(root, depth: 0)
        var result = header(app, appEl)
        result["text"] = lines.joined(separator: "\n")
        result["truncated"] = truncated
        return result
    }

    private func axError(_ err: AXError, _ what: String) -> HelperError {
        let reason: String
        switch err {
        case .actionUnsupported: reason = "the element does not support that action"
        case .attributeUnsupported: reason = "the element does not support that attribute"
        case .cannotComplete: reason = "the app did not answer (it may be busy, or not accessible)"
        case .invalidUIElement: reason = "the element no longer exists; read the tree again"
        case .notImplemented: reason = "the app does not implement this"
        case .apiDisabled: reason = "Accessibility is not enabled for this helper"
        default: reason = "AXError \(err.rawValue)"
        }
        return HelperError(code: "ax_error", message: "\(what) failed: \(reason)")
    }
}
