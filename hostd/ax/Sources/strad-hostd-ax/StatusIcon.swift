import AppKit
import Foundation

/// The menu-bar icon: one still image per state, and the frames it cycles
/// through while work is running.
///
/// Every image is drawn into the same fixed canvas, so swapping frames never
/// changes the item's width and nudges the icons beside it. The idle and off
/// icons are TEMPLATES, so the menu bar draws them black or white for its
/// appearance. A grant's icons carry their own colour — orange for background
/// control, red for the mouse and keyboard — because the menu bar ignores a
/// status button's `contentTintColor` and draws a template in its own ink;
/// the colour is resolved when the image is drawn, so it is the light or dark
/// shade the menu bar's appearance calls for.
enum StatusIcon {
    struct Frame {
        /// What the smoke test and `--render-status-icons` call this frame.
        let name: String
        let image: NSImage
    }

    static let idleName = "circle.dashed"
    /// Four frames a second: enough to read as motion, slow enough to ignore.
    static let frameInterval: TimeInterval = 0.25
    static let canvas = NSSize(width: 22, height: 16)

    /// The icon when nothing is running: off, idle, or a grant waiting on its
    /// next call.
    static func still(disabled: Bool, hasGrants: Bool, foreground: Bool) -> Frame {
        if disabled { return frame("power.circle", label: "remote control is off") }
        if !hasGrants { return frame(idleName, label: "nobody has control") }
        return foreground
            ? frame("cursorarrow.motionlines", label: "a caller holds the mouse and keyboard", tint: .systemRed)
            : frame("dot.radiowaves.left.and.right", label: "a caller has background control", tint: .systemOrange)
    }

    /// The animation while a call (or a command a call started) is running.
    ///
    /// Background: the radio waves fill outward from the dot and start again,
    /// through the symbol's variable value. Foreground: the cursor's motion
    /// lines and a click, alternating. Both stay inside the still icon's
    /// silhouette, so it reads as the same icon, busy.
    static func frames(foreground: Bool) -> [Frame] {
        if foreground {
            let label = "a caller is driving the mouse and keyboard"
            return [
                frame("cursorarrow.motionlines", label: label, tint: .systemRed),
                frame("cursorarrow.motionlines", label: label, tint: .systemRed),
                frame("cursorarrow.motionlines.click", label: label, tint: .systemRed),
                frame("cursorarrow.motionlines.click", label: label, tint: .systemRed),
            ]
        }
        let label = "a caller is working in the background"
        return [0.0, 0.34, 0.67, 1.0].map { v in
            frame("dot.radiowaves.left.and.right", variable: v, label: label, tint: .systemOrange)
        }
    }

    private static func frame(_ symbol: String, variable: Double? = nil, label: String, tint: NSColor? = nil) -> Frame {
        let name = variable.map { "\(symbol)@\(String(format: "%.2f", $0))" } ?? symbol
        let description = "strad-hostd: \(label)"
        let config = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
        let base: NSImage?
        if let v = variable {
            base = NSImage(systemSymbolName: symbol, variableValue: v, accessibilityDescription: description)
        } else {
            base = NSImage(systemSymbolName: symbol, accessibilityDescription: description)
        }
        // A symbol this macOS does not have falls back to the idle one, never to nothing.
        guard let symbolImage = (base ?? NSImage(systemSymbolName: idleName, accessibilityDescription: description))?
            .withSymbolConfiguration(config)
        else {
            return Frame(name: name, image: NSImage(size: canvas))
        }
        let image = NSImage(size: canvas, flipped: false) { rect in
            let s = symbolImage.size
            let scale = min(1, rect.width / max(s.width, 1), rect.height / max(s.height, 1))
            let w = s.width * scale, h = s.height * scale
            let target = NSRect(x: (rect.width - w) / 2, y: (rect.height - h) / 2, width: w, height: h)
            guard let tint = tint, let cg = NSGraphicsContext.current?.cgContext else {
                symbolImage.draw(in: target)
                return true
            }
            // Its own layer, so the colour lands on the symbol's pixels only
            // and never on whatever is already under the image.
            cg.beginTransparencyLayer(auxiliaryInfo: nil)
            symbolImage.draw(in: target)
            tint.set()
            target.fill(using: .sourceAtop)
            cg.endTransparencyLayer()
            return true
        }
        image.isTemplate = tint == nil
        image.accessibilityDescription = description
        return Frame(name: name, image: image)
    }

    /// `--render-status-icons <dir>`: write every still and every frame as a
    /// PNG, on a light and on a dark menu-bar-coloured strip, tinted the way
    /// the status item tints it. It draws the same images the status item
    /// shows, offscreen, so it needs no Screen Recording grant; it is how CI
    /// shows what the icon looks like without a menu bar to photograph.
    static func render(to dir: String) throws -> [String] {
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let sets: [(String, [Frame])] = [
            ("off", [still(disabled: true, hasGrants: false, foreground: false)]),
            ("idle", [still(disabled: false, hasGrants: false, foreground: false)]),
            ("background-still", [still(disabled: false, hasGrants: true, foreground: false)]),
            ("foreground-still", [still(disabled: false, hasGrants: true, foreground: true)]),
            ("background-active", frames(foreground: false)),
            ("foreground-active", frames(foreground: true)),
        ]
        var written: [String] = []
        for dark in [false, true] {
            for (setName, set) in sets {
                let path = "\(dir)/\(setName)-\(dark ? "dark" : "light").png"
                // Under the strip's own appearance, so the system tints
                // resolve to their dark-mode shades on the dark strip.
                var data: Data?
                var failure: Error?
                NSAppearance(named: dark ? .darkAqua : .aqua)?.performAsCurrentDrawingAppearance {
                    do { data = try strip(set.map { $0.image }, dark: dark) } catch { failure = error }
                }
                if let failure = failure { throw failure }
                guard let png = data else { throw HelperError(code: "render_failed", message: "no appearance to draw under") }
                try png.write(to: URL(fileURLWithPath: path))
                written.append(path)
            }
        }
        return written
    }

    /// The frames side by side at 4x, on a menu-bar background.
    private static func strip(_ images: [NSImage], dark: Bool) throws -> Data {
        let scale: CGFloat = 4
        let pad: CGFloat = 6
        let cell = NSSize(width: canvas.width + 2 * pad, height: canvas.height + 2 * pad)
        let size = NSSize(width: cell.width * CGFloat(images.count) * scale, height: cell.height * scale)
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height),
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { throw HelperError(code: "render_failed", message: "could not allocate a bitmap") }
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else {
            throw HelperError(code: "render_failed", message: "could not draw into a bitmap")
        }
        NSGraphicsContext.current = ctx
        ctx.cgContext.scaleBy(x: scale, y: scale)
        (dark ? NSColor(white: 0.16, alpha: 1) : NSColor(white: 0.93, alpha: 1)).setFill()
        NSRect(x: 0, y: 0, width: cell.width * CGFloat(images.count), height: cell.height).fill()
        // What the menu bar does with a template: draws it in its own ink.
        // A coloured image is drawn as it is.
        let ink = dark ? NSColor.white : NSColor.black
        for (i, image) in images.enumerated() {
            let rect = NSRect(x: CGFloat(i) * cell.width + pad, y: pad, width: canvas.width, height: canvas.height)
            guard image.isTemplate else {
                image.draw(in: rect)
                continue
            }
            let tinted = NSImage(size: canvas, flipped: false) { r in
                image.draw(in: r)
                ink.set()
                r.fill(using: .sourceAtop)
                return true
            }
            tinted.draw(in: rect)
        }
        guard let png = rep.representation(using: .png, properties: [:]) else {
            throw HelperError(code: "render_failed", message: "could not encode a PNG")
        }
        return png
    }
}
