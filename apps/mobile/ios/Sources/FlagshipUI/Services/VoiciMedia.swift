import Foundation
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics
import UIKit
import os
import FlagshipAPI
import FlagshipCore

/// Why a picture could not become a voi.ci image; each has its own sentence (`PageDraft.sentence`).
public enum VoiciImageFailure: String, Error, Sendable {
    /// ImageIO could not open or decode the bytes.
    case unreadable
    /// Drawing or writing the JPEG failed, or the written file still carried metadata.
    case encodeFailed
    /// Still over the cap at the lowest quality.
    case tooDetailed
}

/// Images for a voi.ci page, re-encoded on the device from pixels (docs/voici-and-messages.md §2.3, §2.5): the source's
/// orientation applied, a square (avatar) or fitted (card) bitmap drawn in sRGB, written fresh with ImageIO, so no
/// EXIF, XMP, ICC or GPS survives. Quality steps down to 0.6, then the picture shrinks a fifth at a time, then the
/// image is refused. Each step logs a code (never pixels) under `com.flagshipserver.app` / `voici-image`.
public enum VoiciImageEncoder {
    public enum Shape: Sendable { case avatar, card }

    static let log = Logger(subsystem: "com.flagshipserver.app", category: "voici-image")
    /// The longest side the photo editor works on.
    public static let editorMaxSide = 2048

    public static func encode(_ data: Data, shape: Shape) -> [UInt8]? { try? encodeResult(data, shape: shape).get() }

    public static func encodeResult(_ data: Data, shape: Shape) -> Result<[UInt8], VoiciImageFailure> {
        switch shape {
        case .avatar:
            return decode(data, maxSide: 1024).flatMap { encodeAvatar($0, edit: VoiciImageEdit(width: Double($0.width), height: Double($0.height))) }
        case .card:
            return decode(data, maxSide: 800).flatMap { image in
                guard let bitmap = draw(image, shape: .card) else {
                    log.error("card draw failed")
                    return .failure(.encodeFailed)
                }
                return smallest(bitmap, cap: VoiciPage.cardImageMaxBytes, minSide: 160)
            }
        }
    }

    /// The picked bytes as an upright 8-bit sRGB picture whose longest side is at most `maxSide` (the source's
    /// orientation applied). HDR, wide-gamut, 16-bit and gain-map sources all come out the same way.
    public static func decode(_ data: Data, maxSide: Int) -> Result<CGImage, VoiciImageFailure> {
        guard !data.isEmpty, let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(src) > 0 else {
            log.error("decode: no image source (bytes=\(data.count, privacy: .public))")
            return .failure(.unreadable)
        }
        let type = (CGImageSourceGetType(src) as String?) ?? "?"
        let thumb: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                      kCGImageSourceThumbnailMaxPixelSize: maxSide, kCGImageSourceShouldCacheImmediately: true]
        var image = CGImageSourceCreateThumbnailAtIndex(src, 0, thumb as CFDictionary)
        if image == nil {
            log.error("decode: thumbnail failed (type=\(type, privacy: .public)), trying a full decode")
            image = fullDecode(src, maxSide: maxSide)
        }
        guard let image else {
            log.error("decode: no picture (type=\(type, privacy: .public))")
            return .failure(.unreadable)
        }
        guard let upright = normalized(image, maxSide: maxSide) else {
            log.error("decode: redraw failed (type=\(type, privacy: .public) bpc=\(image.bitsPerComponent, privacy: .public) bpp=\(image.bitsPerPixel, privacy: .public))")
            return .failure(.unreadable)
        }
        log.info("decode: ok (type=\(type, privacy: .public) \(upright.width, privacy: .public)x\(upright.height, privacy: .public))")
        return .success(upright)
    }

    /// The camera's picture (any orientation) as the editor's upright sRGB picture.
    public static func decode(_ image: UIImage, maxSide: Int) -> Result<CGImage, VoiciImageFailure> {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return .failure(.unreadable) }
        let k = min(1, CGFloat(maxSide) / max(size.width, size.height))
        let target = CGSize(width: max(1, (size.width * k).rounded()), height: max(1, (size.height * k).rounded()))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        format.preferredRange = .standard
        let out = UIGraphicsImageRenderer(size: target, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
        guard let cg = out.cgImage, let upright = normalized(cg, maxSide: maxSide) else {
            log.error("decode: camera picture redraw failed")
            return .failure(.unreadable)
        }
        return .success(upright)
    }

    /// The avatar: the editor's crop of `image` (turns, flip, square) drawn at 512 × 512 and written within the cap.
    public static func encodeAvatar(_ image: CGImage, edit: VoiciImageEdit) -> Result<[UInt8], VoiciImageFailure> {
        guard let bitmap = render(image, edit: edit, side: 512) else {
            log.error("avatar draw failed")
            return .failure(.encodeFailed)
        }
        return smallest(bitmap, cap: VoiciPage.avatarMaxBytes)
    }

    /// The first JPEG within `cap`: quality 0.82 stepping down to 0.6, then the picture a fifth smaller each round
    /// (never under `minSide`). A device whose encoder fails at one size gets a freshly drawn copy at the next, so
    /// `.encodeFailed` means no size worked at all.
    static func smallest(_ bitmap: CGImage, cap: Int, minSide: Int = 256) -> Result<[UInt8], VoiciImageFailure> {
        var current = bitmap
        var smallest = Int.max
        var wrote = false
        while true {
            var q = 0.82
            while q >= 0.6 - 0.001 {
                guard let out = jpeg(current, quality: q) else {
                    log.error("jpeg failed at \(current.width, privacy: .public)x\(current.height, privacy: .public) q=\(q, privacy: .public)")
                    break
                }
                wrote = true
                if out.count <= cap {
                    if current.width != bitmap.width { log.info("fit after downscale to \(current.width, privacy: .public)x\(current.height, privacy: .public)") }
                    return .success(out)
                }
                smallest = min(smallest, out.count)
                q -= 0.05
            }
            let next = Int(Double(max(current.width, current.height)) * 0.8)
            guard next >= minSide, let smaller = normalized(current, maxSide: next) else { break }
            current = smaller
        }
        guard wrote else { return .failure(.encodeFailed) }
        log.error("too detailed: \(smallest, privacy: .public) bytes at the smallest size and quality, cap \(cap, privacy: .public)")
        return .failure(.tooDetailed)
    }

    static func fullDecode(_ src: CGImageSource, maxSide: Int) -> CGImage? {
        guard let full = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { return nil }
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
        let raw = (props?[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
        let orientation: UIImage.Orientation = switch CGImagePropertyOrientation(rawValue: raw) ?? .up {
        case .upMirrored: .upMirrored
        case .down: .down
        case .downMirrored: .downMirrored
        case .leftMirrored: .leftMirrored
        case .right: .right
        case .rightMirrored: .rightMirrored
        case .left: .left
        default: .up
        }
        return try? decode(UIImage(cgImage: full, scale: 1, orientation: orientation), maxSide: maxSide).get()
    }

    /// `image` redrawn into an 8-bit sRGB bitmap no larger than `maxSide`.
    static func normalized(_ image: CGImage, maxSide: Int) -> CGImage? {
        let w = Double(image.width), h = Double(image.height)
        guard w > 0, h > 0, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let k = min(1, Double(maxSide) / max(w, h))
        let tw = max(1, Int((w * k).rounded())), th = max(1, Int((h * k).rounded()))
        guard let ctx = CGContext(data: nil, width: tw, height: th, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: tw, height: th))
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: tw, height: th))
        return ctx.makeImage()
    }

    /// `image` (upright, top-left origin) mapped through the edit onto a white `side` × `side` sRGB square.
    public static func render(_ image: CGImage, edit: VoiciImageEdit, side: Int) -> CGImage? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        let s = CGFloat(side)
        ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: s, height: s))
        ctx.interpolationQuality = .high
        // Work top-left with y down, as the edit's maps do, then draw the picture upright in that space.
        ctx.translateBy(x: 0, y: s)
        ctx.scaleBy(x: 1, y: -1)
        ctx.concatenate(edit.outputTransform(side: Double(side)))
        let h = CGFloat(image.height)
        ctx.translateBy(x: 0, y: h)
        ctx.scaleBy(x: 1, y: -1)
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(image.width), height: h))
        return ctx.makeImage()
    }

    /// Avatar: center square crop at 512 × 512. Card: fit within 400 × 210.
    static func draw(_ image: CGImage, shape: Shape) -> CGImage? {
        let w = CGFloat(image.width), h = CGFloat(image.height)
        guard w > 0, h > 0, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let size: CGSize
        let rect: CGRect
        switch shape {
        case .avatar:
            size = CGSize(width: 512, height: 512)
            let scale = 512 / min(w, h)
            rect = CGRect(x: (512 - w * scale) / 2, y: (512 - h * scale) / 2, width: w * scale, height: h * scale)
        case .card:
            let scale = min(1, min(400 / w, 210 / h))
            size = CGSize(width: max(1, (w * scale).rounded()), height: max(1, (h * scale).rounded()))
            rect = CGRect(origin: .zero, size: size)
        }
        guard let ctx = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(origin: .zero, size: size))
        ctx.interpolationQuality = .high
        ctx.draw(image, in: rect)
        return ctx.makeImage()
    }

    static func jpeg(_ image: CGImage, quality: Double) -> [UInt8]? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else {
            log.error("jpeg: no destination")
            return nil
        }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality,
                                                 kCGImagePropertyOrientation: 1] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else {
            log.error("jpeg: finalize failed")
            return nil
        }
        // ImageIO (iOS 26, macOS 26) adds an EXIF APP1 (colour space, size) and an empty Photoshop APP13 even for a
        // bare bitmap: drop every APPn but JFIF (APP0) and Adobe (APP14), then refuse anything that still carries one.
        let bytes = stripAppSegments([UInt8](out as Data))
        if VoiciPage.voiciJpegHasMetadata(bytes) {
            log.error("jpeg: metadata left after strip (markers \(markers([UInt8](out as Data)), privacy: .public))")
            return nil
        }
        return bytes
    }

    /// The JPEG without its APP1-APP13 and APP15 segments (everything before the scan is walked; the rest is copied).
    static func stripAppSegments(_ b: [UInt8]) -> [UInt8] {
        guard VoiciPage.isVoiciJpeg(b) else { return b }
        var out: [UInt8] = [0xff, 0xd8]
        var i = 2
        while i + 4 <= b.count, b[i] == 0xff {
            let m = b[i + 1]
            if m == 0xff {
                i += 1
                continue
            }
            if m == 0xda || m == 0xd9 { break }
            let end = i + 2 + (Int(b[i + 2]) << 8 | Int(b[i + 3]))
            guard end <= b.count else { return b }
            if !((0xe1...0xef).contains(m) && m != 0xee) { out += b[i..<end] }
            i = end
        }
        out += b[i...]
        return out
    }

    /// The marker list before the scan, for the log (e.g. "e0 e1 ed c0 c4 db da").
    static func markers(_ b: [UInt8]) -> String {
        var names: [String] = []
        var i = 2
        while i + 4 <= b.count, b[i] == 0xff, names.count < 40 {
            let m = b[i + 1]
            if m == 0xff { i += 1; continue }
            names.append(String(format: "%02x", m))
            if m == 0xda || m == 0xd9 { break }
            i += 2 + (Int(b[i + 2]) << 8 | Int(b[i + 3]))
        }
        return names.joined(separator: " ")
    }
}

/// A link card, fetched once by the owner's device when a post is written (§2.5): GET, 5 s, 512 KiB, no cookies, no
/// JavaScript; the Open Graph title, site, description and image, the image re-encoded into a piece.
public enum VoiciLinkCards {
    public struct Card: Sendable {
        public var card: VoiciCard
        public var image: [UInt8]?
    }

    static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieAcceptPolicy = .never
        c.httpShouldSetCookies = false
        c.urlCache = nil
        c.timeoutIntervalForRequest = 5
        c.timeoutIntervalForResource = 5
        return URLSession(configuration: c)
    }()

    public static func fetch(_ url: String) async -> Card? {
        // A box's app gets no card: its pinned session is not this one, and the owner's own server needs no preview.
        guard VoiciText.checkVoiciLinkUrl(url) == nil, let u = URL(string: url), !isBox(u), let html = await get(u, cap: 512 * 1024),
              let text = String(data: html, encoding: .utf8) ?? String(data: html, encoding: .isoLatin1) else { return nil }
        let og = openGraph(text)
        let title = clean(og["og:title"] ?? og["title"], max: 120)
        guard !title.isEmpty, VoiciText.checkVoiciText(.cardTitle, title) == nil else { return nil }
        let site = clean(og["og:site_name"], max: 60)
        let description = clean(og["og:description"] ?? og["description"], max: 200)
        var card = VoiciCard(title: title, site: VoiciText.checkVoiciText(.cardSite, site) == nil ? site : "",
                             description: VoiciText.checkVoiciText(.cardDescription, description) == nil ? description : "", image: nil)
        var image: [UInt8]?
        if let raw = og["og:image"], let iu = URL(string: raw, relativeTo: u)?.absoluteURL, iu.scheme == "https",
           let data = await get(iu, cap: 4 * 1024 * 1024), let jpeg = VoiciImageEncoder.encode(data, shape: .card) {
            image = jpeg
            card.image = CanonicalJson.sha256Hex(jpeg)
        }
        return Card(card: card, image: image)
    }

    static func isBox(_ url: URL) -> Bool {
        let h = (url.host() ?? "").lowercased()
        return h == Endpoints.dataApex || h.hasSuffix(".\(Endpoints.dataApex)")
    }

    static func get(_ url: URL, cap: Int) async -> Data? {
        guard !isBox(url) else { return nil }
        var r = URLRequest(url: url, timeoutInterval: 5)
        r.httpShouldHandleCookies = false
        r.setValue("text/html,image/*;q=0.8", forHTTPHeaderField: "accept")
        guard let (bytes, res) = try? await session.gatedBytes(for: r), let http = res as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              http.url?.scheme == "https", !(http.url.map(isBox) ?? true) else { return nil }
        var out = Data()
        do {
            for try await b in bytes {
                out.append(b)
                if out.count > cap { return nil }
            }
        } catch { return nil }
        return out
    }

    /// `<meta property|name=… content=…>` and `<title>` from the head; entities decoded.
    static func openGraph(_ html: String) -> [String: String] {
        var out: [String: String] = [:]
        let head = String(html.prefix(200_000))
        let meta = try? NSRegularExpression(pattern: #"<meta\s+[^>]*>"#, options: [.caseInsensitive])
        let attr = try? NSRegularExpression(pattern: #"(property|name|content)\s*=\s*("([^"]*)"|'([^']*)')"#, options: [.caseInsensitive])
        let ns = head as NSString
        for m in meta?.matches(in: head, range: NSRange(location: 0, length: ns.length)) ?? [] {
            let tag = ns.substring(with: m.range) as NSString
            var key: String?, content: String?
            for a in attr?.matches(in: tag as String, range: NSRange(location: 0, length: tag.length)) ?? [] {
                let name = tag.substring(with: a.range(at: 1)).lowercased()
                let r = a.range(at: 3).location != NSNotFound ? a.range(at: 3) : a.range(at: 4)
                let value = tag.substring(with: r)
                if name == "content" { content = value } else { key = value.lowercased() }
            }
            if let key, let content, out[key] == nil { out[key] = decode(content) }
        }
        if let t = try? NSRegularExpression(pattern: #"<title[^>]*>([^<]*)</title>"#, options: [.caseInsensitive]),
           let m = t.firstMatch(in: head, range: NSRange(location: 0, length: ns.length)) {
            out["title"] = decode(ns.substring(with: m.range(at: 1)))
        }
        return out
    }

    static func decode(_ s: String) -> String {
        var t = s
        for (k, v) in ["&amp;": "&", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " "] {
            t = t.replacingOccurrences(of: k, with: v)
        }
        return t
    }

    /// One line, NFC, the refused characters dropped, cut to `max` code points.
    static func clean(_ s: String?, max: Int) -> String {
        guard let s else { return "" }
        let banned: Set<UInt32> = Set(0x202A...0x202E).union(0x2066...0x2069).union([0xFEFF, 0x200B, 0x200C, 0x200D, 0x2060])
        let scalars = s.precomposedStringWithCanonicalMapping.unicodeScalars.map { $0.properties.generalCategory == .control ? " " : Character($0) }
            .filter { !$0.unicodeScalars.contains { banned.contains($0.value) } }
        let one = String(scalars).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return String(one.unicodeScalars.prefix(max).map(Character.init))
    }
}
