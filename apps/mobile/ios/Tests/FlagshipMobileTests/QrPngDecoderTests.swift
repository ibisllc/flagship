import XCTest
import UIKit
@testable import FlagshipUI

final class QrPngDecoderTests: XCTestCase {
    private func pngBase64(width: Int, height: Int) -> String {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { ctx in
            UIColor.black.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: width / 2, height: height / 2))
        }
        return image.pngData()!.base64EncodedString()
    }

    func test_largePng_isDownsampledToTheCap() throws {
        let image = try XCTUnwrap(QrPngDecoder.image(fromBase64: pngBase64(width: 3000, height: 3000)))
        let px = max(image.size.width * image.scale, image.size.height * image.scale)
        XCTAssertLessThanOrEqual(px, CGFloat(QrPngDecoder.maxPixelSize))
    }

    func test_smallPng_isNotUpscaled() throws {
        let image = try XCTUnwrap(QrPngDecoder.image(fromBase64: pngBase64(width: 200, height: 200)))
        XCTAssertEqual(image.size.width * image.scale, 200)
    }

    func test_sameSecret_decodesOnce() {
        let b64 = pngBase64(width: 300, height: 300)
        let first = QrPngDecoder.image(fromBase64: b64)
        let second = QrPngDecoder.image(fromBase64: b64)
        XCTAssertNotNil(first)
        XCTAssertTrue(first === second, "the second render must reuse the cached decode")
    }

    func test_garbage_returnsNil() {
        XCTAssertNil(QrPngDecoder.image(fromBase64: "not base64 ✗"))
        XCTAssertNil(QrPngDecoder.image(fromBase64: Data("not a png".utf8).base64EncodedString()))
    }
}
