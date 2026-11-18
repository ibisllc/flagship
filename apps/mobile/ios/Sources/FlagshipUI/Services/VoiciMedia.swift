import Foundation
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics
import FlagshipAPI
import FlagshipCore

/// Images for a voi.ci page, re-encoded on the device from pixels (docs/voici-and-messages.md §2.3, §2.5): the source's
/// orientation applied, a square (avatar) or fitted (card) bitmap drawn in sRGB, written fresh with ImageIO, so no
/// EXIF, XMP, ICC or GPS survives. Quality steps down to 0.6, then the image is refused.
public enum VoiciImageEncoder {
    public enum Shape: Sendable { case avatar, card }

    public static func encode(_ data: Data, shape: Shape) -> [UInt8]? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let maxSide = shape == .avatar ? 1024 : 800
        let thumb: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                      kCGImageSourceThumbnailMaxPixelSize: maxSide, kCGImageSourceShouldCacheImmediately: true]
        guard let image = CGImageSourceCreateThumbnailAtIndex(src, 0, thumb as CFDictionary) else { return nil }
        guard let bitmap = draw(image, shape: shape) else { return nil }
        let cap = shape == .avatar ? VoiciPage.avatarMaxBytes : VoiciPage.cardImageMaxBytes
        var q = 0.82
        while q >= 0.6 - 0.001 {
            if let out = jpeg(bitmap, quality: q), out.count <= cap { return out }
            q -= 0.05
        }
        return nil
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
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality,
                                                 kCGImagePropertyOrientation: 1] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        // ImageIO (iOS 26, macOS 26) adds an EXIF APP1 (colour space, size) and an empty Photoshop APP13 even for a
        // bare bitmap: drop every APPn but JFIF (APP0) and Adobe (APP14), then refuse anything that still carries one.
        let bytes = stripAppSegments([UInt8](out as Data))
        return VoiciPage.voiciJpegHasMetadata(bytes) ? nil : bytes
    }

    /// The JPEG without its APP1-APP13 and APP15 segments (everything before the scan is walked; the rest is copied).
    static func stripAppSegments(_ b: [UInt8]) -> [UInt8] {
        guard VoiciPage.isVoiciJpeg(b) else { return b }
        var out: [UInt8] = [0xff, 0xd8]
        var i = 2
        while i + 4 <= b.count, b[i] == 0xff {
            let m = b[i + 1]
            if m == 0xda || m == 0xd9 { break }
            let end = i + 2 + (Int(b[i + 2]) << 8 | Int(b[i + 3]))
            guard end <= b.count else { return b }
            if !((0xe1...0xef).contains(m) && m != 0xee) { out += b[i..<end] }
            i = end
        }
        out += b[i...]
        return out
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
