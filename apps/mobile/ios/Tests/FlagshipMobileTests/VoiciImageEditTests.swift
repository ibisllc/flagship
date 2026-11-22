import XCTest
import ImageIO
import UniformTypeIdentifiers
@testable import FlagshipUI
import FlagshipCore

/// The photo editor's rules (VoiciImageEdit) against packages/protocol/test-vectors/voici-image-edit
/// (tools/voici-image-edit-vectors.mjs), and the encoder that applies them (VoiciImageEncoder).
final class VoiciImageEditTests: XCTestCase {
    func vectors() throws -> [[String: Any]] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<10 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/voici-image-edit/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                let o = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
                return try XCTUnwrap(o["cases"] as? [[String: Any]])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("voici-image-edit vectors not found")
    }

    func test_vectors() throws {
        for c in try vectors() {
            let name = c["name"] as! String
            var e = VoiciImageEdit(width: (c["width"] as! NSNumber).doubleValue, height: (c["height"] as! NSNumber).doubleValue)
            for op in c["ops"] as! [[Any]] {
                switch op[0] as! String {
                case "rotate": e.rotate()
                case "flip": e.flip()
                case "zoom": e.setZoom((op[1] as! NSNumber).doubleValue)
                default: e.pan(dx: (op[1] as! NSNumber).doubleValue, dy: (op[2] as! NSNumber).doubleValue, viewSide: (op[3] as! NSNumber).doubleValue)
                }
            }
            let x = c["expect"] as! [String: Any]
            func near(_ a: Double, _ b: Any, _ what: String) { XCTAssertEqual(a, (b as! NSNumber).doubleValue, accuracy: 1e-6, "\(name): \(what)") }
            XCTAssertEqual(e.turns, x["turns"] as? Int, name)
            XCTAssertEqual(e.flipped, x["flipped"] as? Bool, name)
            near(e.zoom, x["zoom"]!, "zoom")
            near(e.displayWidth, x["displayWidth"]!, "displayWidth")
            near(e.displayHeight, x["displayHeight"]!, "displayHeight")
            let crop = x["crop"] as! [String: Any]
            near(e.crop.x, crop["x"]!, "crop.x")
            near(e.crop.y, crop["y"]!, "crop.y")
            near(e.crop.side, crop["side"]!, "crop.side")
            for (label, t) in [("orient", e.orientTransform), ("output512", e.outputTransform(side: 512))] {
                let m = x[label] as! [Any]
                for (i, v) in [t.a, t.b, t.c, t.d, t.tx, t.ty].enumerated() { near(Double(v), m[i], "\(label)[\(i)]") }
            }
        }
    }

    /// A 200 × 100 picture: left half red, right half blue, with a green top-left corner.
    func quadrants() -> CGImage {
        let ctx = CGContext(data: nil, width: 200, height: 100, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
        ctx.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 1, alpha: 1)); ctx.fill(CGRect(x: 100, y: 0, width: 100, height: 100))
        // CG's origin is bottom-left: y 70...100 is the top of the picture.
        ctx.setFillColor(CGColor(srgbRed: 0, green: 1, blue: 0, alpha: 1)); ctx.fill(CGRect(x: 0, y: 70, width: 30, height: 30))
        return ctx.makeImage()!
    }

    /// The colour at (x, y), top-left origin, as "r", "g", "b" or "?".
    func color(_ img: CGImage, _ x: Int, _ y: Int) -> String {
        let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: img.width * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
        let p = ctx.data!.assumingMemoryBound(to: UInt8.self)
        let i = (y * img.width + x) * 4
        let (r, g, b) = (p[i], p[i + 1], p[i + 2])
        if r > 200, g < 60, b < 60 { return "r" }
        if g > 200, r < 60, b < 60 { return "g" }
        if b > 200, r < 60, g < 60 { return "b" }
        return "?"
    }

    func test_renderAppliesCropTurnAndFlip() throws {
        let src = quadrants()
        var e = VoiciImageEdit(width: 200, height: 100)
        // Untouched: the centred 100 × 100 square straddles red | blue.
        var out = try XCTUnwrap(VoiciImageEncoder.render(src, edit: e, side: 64))
        XCTAssertEqual(color(out, 8, 32), "r")
        XCTAssertEqual(color(out, 56, 32), "b")
        // Pan fully left: the green corner is at the top left.
        e.pan(dx: 1000, dy: 0, viewSide: 64)
        out = try XCTUnwrap(VoiciImageEncoder.render(src, edit: e, side: 64))
        XCTAssertEqual(color(out, 4, 4), "g")
        XCTAssertEqual(color(out, 4, 60), "r")
        // Flip: the green corner moves to the top right.
        e.flip()
        out = try XCTUnwrap(VoiciImageEncoder.render(src, edit: e, side: 64))
        XCTAssertEqual(color(out, 60, 4), "g")
        // Untouched, turned once clockwise: the picture is 100 × 200, red on top, green at the top right.
        var t = VoiciImageEdit(width: 200, height: 100)
        t.rotate()
        t.pan(dx: 0, dy: 1000, viewSide: 64)
        out = try XCTUnwrap(VoiciImageEncoder.render(src, edit: t, side: 64))
        XCTAssertEqual(color(out, 60, 4), "g")
        XCTAssertEqual(color(out, 4, 60), "r")
    }

    func photoLike(_ w: Int, _ h: Int, type: UTType, orientation: Int) -> Data {
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.displayP3)!,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        var seed: UInt64 = 42
        func next() -> Double { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Double(seed >> 11) / Double(1 << 53) }
        for _ in 0..<1500 {
            ctx.setFillColor(CGColor(red: next(), green: next(), blue: next(), alpha: 1))
            ctx.fill(CGRect(x: next() * Double(w), y: next() * Double(h), width: 4 + next() * 150, height: 4 + next() * 150))
        }
        let out = NSMutableData()
        let d = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(d, ctx.makeImage()!, [kCGImagePropertyOrientation: orientation, kCGImageDestinationLossyCompressionQuality: 0.9,
                                                         kCGImagePropertyExifDictionary: [kCGImagePropertyExifUserComment: "secret"],
                                                         kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 48.85]] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(d))
        return out as Data
    }

    func test_decodeAppliesOrientationAndEncodeStaysWithinTheCapWithNoMetadata() throws {
        for type in [UTType.heic, .jpeg, .png] {
            let data = photoLike(1600, 1200, type: type, orientation: 6)
            let image = try VoiciImageEncoder.decode(data, maxSide: VoiciImageEncoder.editorMaxSide).get()
            // ImageIO keeps the orientation tag in HEIC and JPEG (it writes none into PNG).
            let upright = type != .png
            XCTAssertEqual(image.width, upright ? 1200 : 1600, "\(type)")
            XCTAssertEqual(image.height, upright ? 1600 : 1200, "\(type)")
            var e = VoiciImageEdit(width: Double(image.width), height: Double(image.height))
            e.setZoom(1.5)
            e.rotate()
            e.flip()
            let jpeg = try VoiciImageEncoder.encodeAvatar(image, edit: e).get()
            XCTAssertTrue(VoiciPage.isVoiciJpeg(jpeg))
            XCTAssertFalse(VoiciPage.voiciJpegHasMetadata(jpeg))
            XCTAssertLessThanOrEqual(jpeg.count, VoiciPage.avatarMaxBytes)
            XCTAssertNil(String(decoding: jpeg, as: UTF8.self).range(of: "secret"))
            let src = try XCTUnwrap(CGImageSourceCreateWithData(Data(jpeg) as CFData, nil))
            let props = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any])
            XCTAssertEqual(props[kCGImagePropertyPixelWidth] as? Int, 512)
            XCTAssertEqual(props[kCGImagePropertyPixelHeight] as? Int, 512)
            XCTAssertNil(props[kCGImagePropertyGPSDictionary])
            // The old one-step path still works for a centred crop.
            XCTAssertNotNil(VoiciImageEncoder.encode(data, shape: .avatar))
        }
    }

    func test_eachFailureHasItsOwnCode() {
        XCTAssertEqual(VoiciImageEncoder.decode(Data([1, 2, 3, 4]), maxSide: 100).failure, .unreadable)
        XCTAssertEqual(VoiciImageEncoder.decode(Data(), maxSide: 100).failure, .unreadable)
        // Pure noise can't fit a 1 KiB cap at any quality.
        let noise = CGContext(data: nil, width: 512, height: 512, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        let p = noise.data!.assumingMemoryBound(to: UInt8.self)
        for i in 0..<(noise.bytesPerRow * 512) { p[i] = UInt8.random(in: 0...255) }
        XCTAssertEqual(VoiciImageEncoder.smallest(noise.makeImage()!, cap: 1024).failure, .tooDetailed)
        XCTAssertNotEqual(PageDraft.sentence(.tooDetailed), PageDraft.sentence(.unreadable))
        XCTAssertNotEqual(PageDraft.sentence(.encodeFailed), PageDraft.sentence(.unreadable))
    }

    func test_aPictureTooDetailedAtFullSizeFitsSmaller() throws {
        let noise = CGContext(data: nil, width: 512, height: 512, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        let p = noise.data!.assumingMemoryBound(to: UInt8.self)
        for i in 0..<(noise.bytesPerRow * 512) { p[i] = UInt8.random(in: 0...255) }
        let image = noise.makeImage()!
        let full = try XCTUnwrap(VoiciImageEncoder.jpeg(image, quality: 0.6))
        let jpeg = try VoiciImageEncoder.smallest(image, cap: full.count / 3).get()
        XCTAssertLessThanOrEqual(jpeg.count, full.count / 3)
        let src = try XCTUnwrap(CGImageSourceCreateWithData(Data(jpeg) as CFData, nil))
        let props = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any])
        let width = try XCTUnwrap(props[kCGImagePropertyPixelWidth] as? Int)
        XCTAssertLessThan(width, 512)
        XCTAssertGreaterThanOrEqual(width, 256)
    }

    func test_stripSkipsFillBytesBeforeAMarker() {
        // SOI, a fill byte, APP1 (4 bytes of payload), DQT stub, SOS…
        let jpeg: [UInt8] = [0xff, 0xd8, 0xff, 0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66, 0xff, 0xdb, 0x00, 0x03, 0x00, 0xff, 0xda, 0x00, 0x02, 0x11, 0xff, 0xd9]
        let out = VoiciImageEncoder.stripAppSegments(jpeg)
        XCTAssertFalse(VoiciPage.voiciJpegHasMetadata(out))
        XCTAssertEqual(out, [0xff, 0xd8, 0xff, 0xdb, 0x00, 0x03, 0x00, 0xff, 0xda, 0x00, 0x02, 0x11, 0xff, 0xd9])
    }
}

private extension Result {
    var failure: Failure? { if case .failure(let f) = self { return f } else { return nil } }
}
