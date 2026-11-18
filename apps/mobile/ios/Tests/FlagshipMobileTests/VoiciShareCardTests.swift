import XCTest
import ImageIO
import CoreGraphics
import UIKit
@testable import FlagshipCore
@testable import FlagshipUI

/// The share card (docs/voici-and-messages.md §2.10): a 1200 × 630 JPEG under the cap with no metadata, drawn with or
/// without a photo in every theme, and drawn again only when the name, photo or theme changes. Mirrors Android's
/// VoiciShareCardTest and the webapp's webappVoiciShareCard.test.ts.
final class VoiciShareCardTests: XCTestCase {
    private func profile(_ name: String = "Aya Koné", avatar: String? = nil, theme: String = "classic") -> VoiciProfile {
        VoiciProfile(displayName: name, bio: "", avatar: avatar, theme: theme, links: [])
    }

    private func size(_ b: [UInt8]) -> (Int, Int)? {
        guard let src = CGImageSourceCreateWithData(Data(b) as CFData, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        return (img.width, img.height)
    }

    private func photo() -> [UInt8] {
        let ctx = CGContext(data: nil, width: 512, height: 512, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        for i in 0..<16 {
            ctx.setFillColor(CGColor(srgbRed: CGFloat(i) / 16, green: 0.4, blue: 1 - CGFloat(i) / 16, alpha: 1))
            ctx.fill(CGRect(x: i * 32, y: 0, width: 32, height: 512))
        }
        return VoiciImageEncoder.jpeg(ctx.makeImage()!, quality: 0.9)!
    }

    func test_aCardIs1200x630JpegUnderTheCapWithNoMetadata() throws {
        for theme in VoiciPageTheme.ids {
            for avatar in [nil, photo()] {
                let b = try XCTUnwrap(VoiciShareCard.render(username: "aya", profile: profile(theme: theme), avatar: avatar))
                XCTAssertTrue(VoiciPage.isVoiciJpeg(b), theme)
                XCTAssertFalse(VoiciPage.voiciJpegHasMetadata(b), theme)
                XCTAssertLessThanOrEqual(b.count, VoiciPage.shareImageMaxBytes)
                let s = try XCTUnwrap(size(b))
                XCTAssertEqual(s.0, 1200)
                XCTAssertEqual(s.1, 630)
            }
        }
    }

    func test_aLongNameIsCutWithAnEllipsis() {
        let font = UIFont.systemFont(ofSize: 72, weight: .bold)
        let cut = VoiciShareCard.fitted(String(repeating: "Wide name ", count: 20), font: font, width: 700)
        XCTAssertTrue(cut.hasSuffix("…"))
        XCTAssertEqual(VoiciShareCard.fitted("Aya", font: font, width: 700), "Aya")
    }

    func test_redrawOnlyWhenNameAvatarOrThemeChangesOrNoCardIsListed() {
        let ref = VoiciPieceRef(role: "share", sha256: String(repeating: "ab", count: 32), size: 10)
        let state = { (p: VoiciProfile) in VoiciPageState(profile: p, acceptsMessages: 1, chunks: [], issuedAt: 1) }
        let pub = state(profile())
        XCTAssertTrue(VoiciShareCard.needsRedraw(published: nil, listedShare: nil, merged: pub), "A first publish draws one.")
        XCTAssertTrue(VoiciShareCard.needsRedraw(published: pub, listedShare: nil, merged: pub), "A page without a card gets one.")
        XCTAssertFalse(VoiciShareCard.needsRedraw(published: pub, listedShare: ref, merged: pub))
        var bio = profile(); bio.bio = "New bio"
        XCTAssertFalse(VoiciShareCard.needsRedraw(published: pub, listedShare: ref, merged: state(bio)), "The bio is not on the card.")
        XCTAssertTrue(VoiciShareCard.needsRedraw(published: pub, listedShare: ref, merged: state(profile("Other"))))
        XCTAssertTrue(VoiciShareCard.needsRedraw(published: pub, listedShare: ref, merged: state(profile(avatar: String(repeating: "cd", count: 32)))))
        XCTAssertTrue(VoiciShareCard.needsRedraw(published: pub, listedShare: ref, merged: state(profile(theme: "ink"))))
    }
}
