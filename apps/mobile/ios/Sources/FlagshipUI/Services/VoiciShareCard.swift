import Foundation
import CoreGraphics
import ImageIO
import UIKit
import FlagshipCore

/// The page's share card (docs/voici-and-messages.md §2.10, owner decision 2026-11-17): the 1200 × 630 picture link
/// previews show (og:image), drawn on the publishing device and listed as the signed `share` piece. No words, so there
/// is nothing to translate; the same layout as the webapp and Android.
public enum VoiciShareCard {
    struct Palette {
        let canvas: UIColor, ink: UIColor, muted: UIColor, accent: UIColor, rule: UIColor
    }

    static func palette(_ theme: String) -> Palette {
        func c(_ hex: UInt32) -> UIColor {
            UIColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
        }
        switch theme {
        case "ink": return Palette(canvas: c(0x0a0a09), ink: c(0xece7d6), muted: c(0xa39d8f), accent: c(0x2dd4bf), rule: c(0x26241d))
        case "sea": return Palette(canvas: c(0xf3f6f7), ink: c(0x0e1a1f), muted: c(0x4c5f67), accent: c(0x14b8a6), rule: c(0xe5e3dc))
        default: return Palette(canvas: c(0xf7f6f2), ink: c(0x14140f), muted: c(0x555149), accent: c(0x14b8a6), rule: c(0xe5e3dc))
        }
    }

    /// The card's JPEG for a profile (and its photo's bytes, when it has one): quality 0.9 stepping down by 0.1 to 0.4
    /// until it fits `VoiciPage.shareImageMaxBytes`; written fresh from pixels, so no metadata. Nil if it never fits.
    public static func render(username: String, profile: VoiciProfile, avatar: [UInt8]?) -> [UInt8]? {
        guard let image = draw(username: username, profile: profile, avatar: avatar) else { return nil }
        var q = 0.9
        while q >= 0.4 - 0.001 {
            if let out = VoiciImageEncoder.jpeg(image, quality: q), out.count <= VoiciPage.shareImageMaxBytes { return out }
            q -= 0.1
        }
        return nil
    }

    static func draw(username: String, profile: VoiciProfile, avatar: [UInt8]?) -> CGImage? {
        let w = CGFloat(VoiciPage.shareImageWidth), h = CGFloat(VoiciPage.shareImageHeight)
        let p = palette(profile.theme)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        format.preferredRange = .standard
        let img = UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: format).image { r in
            let ctx = r.cgContext
            p.canvas.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            // The photo, or an accent disc with the name's first character.
            let disc = CGRect(x: 100, y: 170, width: 240, height: 240)
            if let avatar, let src = CGImageSourceCreateWithData(Data(avatar) as CFData, nil), let photo = CGImageSourceCreateImageAtIndex(src, 0, nil) {
                ctx.saveGState()
                ctx.addEllipse(in: disc)
                ctx.clip()
                let pw = CGFloat(photo.width), ph = CGFloat(photo.height)
                let s = max(disc.width / pw, disc.height / ph)
                let rect = CGRect(x: disc.midX - pw * s / 2, y: disc.midY - ph * s / 2, width: pw * s, height: ph * s)
                UIImage(cgImage: photo).draw(in: rect)
                ctx.restoreGState()
            } else {
                p.accent.setFill()
                ctx.fillEllipse(in: disc)
                let initial = profile.displayName.first.map { String($0).uppercased() } ?? ""
                let a: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 112, weight: .bold), .foregroundColor: p.canvas]
                let size = (initial as NSString).size(withAttributes: a)
                (initial as NSString).draw(at: CGPoint(x: disc.midX - size.width / 2, y: disc.midY - size.height / 2), withAttributes: a)
            }
            // Name: bold 72, one line, cut with "…" to 700 px, baseline 290.
            let nameFont = UIFont.systemFont(ofSize: 72, weight: .bold)
            text(fitted(profile.displayName, font: nameFont, width: 700), font: nameFont, color: p.ink, x: 400, baseline: 290)
            let mono = UIFont.monospacedSystemFont(ofSize: 40, weight: .regular)
            text(fitted("voi.ci/\(username)", font: mono, width: 700), font: mono, color: p.muted, x: 400, baseline: 360)
            // Hairline and wordmark.
            p.rule.setFill()
            ctx.fill(CGRect(x: 100, y: 519, width: 1000, height: 2))
            p.accent.setFill()
            ctx.fillEllipse(in: CGRect(x: 101, y: 559, width: 18, height: 18))
            text("voi.ci", font: UIFont.systemFont(ofSize: 40, weight: .bold), color: p.ink, x: 128, baseline: 582)
        }
        return img.cgImage
    }

    private static func text(_ s: String, font: UIFont, color: UIColor, x: CGFloat, baseline: CGFloat) {
        (s as NSString).draw(at: CGPoint(x: x, y: baseline - font.ascender), withAttributes: [.font: font, .foregroundColor: color])
    }

    /// `s` cut with "…" so it is at most `width` wide in `font`.
    static func fitted(_ s: String, font: UIFont, width: CGFloat) -> String {
        let a: [NSAttributedString.Key: Any] = [.font: font]
        if (s as NSString).size(withAttributes: a).width <= width { return s }
        var chars = Array(s)
        while !chars.isEmpty {
            chars.removeLast()
            let t = String(chars) + "…"
            if (t as NSString).size(withAttributes: a).width <= width { return t }
        }
        return "…"
    }

    /// Whether a publish must draw a new card: the page lists none, or the name, photo or theme changed since the page
    /// it replaces (`published`; nil for a first publish).
    public static func needsRedraw(published: VoiciPageState?, listedShare: VoiciPieceRef?, merged: VoiciPageState) -> Bool {
        guard let published, listedShare != nil else { return true }
        return published.profile.displayName != merged.profile.displayName || published.profile.avatar != merged.profile.avatar
            || published.profile.theme != merged.profile.theme
    }
}
