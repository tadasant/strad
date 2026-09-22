import AppKit
import CoreGraphics
import Foundation

/// The screen, as pixels. Coordinates everywhere in this helper are POINTS in
/// the global display space CGEvent uses (origin top-left of the main display),
/// so a screenshot is returned scaled to one pixel per point unless the caller
/// asks for a narrower image, and `scale` says how to map back.
///
/// `CGDisplayCreateImage` is the capture: it needs the Screen Recording grant,
/// and on macOS 15 it is also what makes the system re-ask for that grant on
/// its own schedule (the design page's limitations section covers it).
final class Capture {
    private func displayIDs() -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        CGGetActiveDisplayList(16, &ids, &count)
        return Array(ids.prefix(Int(count)))
    }

    func displays() -> [String: Any] {
        let main = CGMainDisplayID()
        let list = displayIDs().enumerated().map { i, id -> [String: Any] in
            let b = CGDisplayBounds(id)
            return [
                "index": i,
                "id": Int(id),
                "main": id == main,
                "x": b.origin.x, "y": b.origin.y,
                "width": b.width, "height": b.height,
                "pixel_width": CGDisplayPixelsWide(id), "pixel_height": CGDisplayPixelsHigh(id),
            ]
        }
        var result: [String: Any] = ["displays": list, "cursor": Input.cursor()]
        if let front = NSWorkspace.shared.frontmostApplication {
            result["frontmost_app"] = ["pid": Int(front.processIdentifier), "name": front.localizedName ?? "", "bundle_id": front.bundleIdentifier ?? ""]
        }
        return result
    }

    func screenshot(_ args: Args) throws -> [String: Any] {
        try Permissions.requireScreenRecording()
        let ids = displayIDs()
        let index = args.int("display", default: 0)
        guard index >= 0, index < ids.count else {
            throw HelperError(code: "no_such_display", message: "there are \(ids.count) display(s); index \(index) is out of range")
        }
        let display = ids[index]
        let bounds = CGDisplayBounds(display)

        // A region is in global points; the capture rect is relative to the display.
        var origin = bounds.origin
        var pointSize = bounds.size
        var image: CGImage?
        if let x = args.double("x"), let y = args.double("y"), let w = args.double("width"), let h = args.double("height") {
            guard w >= 1, h >= 1 else { throw HelperError(code: "bad_args", message: "width and height must be at least 1") }
            let local = CGRect(x: x - bounds.origin.x, y: y - bounds.origin.y, width: w, height: h)
            let clipped = local.intersection(CGRect(origin: .zero, size: bounds.size))
            guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1 else {
                throw HelperError(code: "bad_args", message: "that region is off display \(index)")
            }
            origin = CGPoint(x: bounds.origin.x + clipped.origin.x, y: bounds.origin.y + clipped.origin.y)
            pointSize = clipped.size
            image = CGDisplayCreateImage(display, rect: clipped)
        } else {
            image = CGDisplayCreateImage(display)
        }
        guard let captured = image else {
            throw HelperError(code: "capture_failed", message: "the display could not be captured (is the screen locked?)")
        }

        // `scale` is output pixels per point. It never exceeds the display's own
        // backing factor (there are no more pixels than that) and never exceeds
        // what max_width allows, so a small region with a large max_width comes
        // back at full Retina resolution and a whole display comes back smaller.
        let maxWidth = Double(max(160, min(args.int("max_width", default: 1280), 4096)))
        let backing = Double(captured.width) / pointSize.width
        let scale = min(backing, maxWidth / pointSize.width)
        let outW = max(1, Int((pointSize.width * scale).rounded()))
        let outH = max(1, Int((pointSize.height * scale).rounded()))
        guard let ctx = CGContext(
            data: nil, width: outW, height: outH, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { throw HelperError(code: "capture_failed", message: "could not allocate the output image") }
        ctx.interpolationQuality = .high
        ctx.draw(captured, in: CGRect(x: 0, y: 0, width: outW, height: outH))
        guard let scaled = ctx.makeImage() else {
            throw HelperError(code: "capture_failed", message: "could not scale the capture")
        }
        let rep = NSBitmapImageRep(cgImage: scaled)
        let format = (args.string("format") ?? "jpeg").lowercased()
        let data: Data?
        let mime: String
        if format == "png" {
            data = rep.representation(using: .png, properties: [:])
            mime = "image/png"
        } else {
            data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8])
            mime = "image/jpeg"
        }
        guard let bytes = data else { throw HelperError(code: "capture_failed", message: "could not encode the image") }
        return [
            "image_base64": bytes.base64EncodedString(),
            "mime_type": mime,
            "width": outW, "height": outH,
            "scale": scale,
            "origin": ["x": origin.x, "y": origin.y],
            "display": index,
            "display_size": ["width": bounds.width, "height": bounds.height],
            "cursor": Input.cursor(),
        ]
    }
}
