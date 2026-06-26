import SwiftUI
import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins

/// Renders a string as a QR code. Used on the locked cover so the phone
/// can scan the burner's pairing payload (`flagship://burner?c=…&k=…`).
struct QRCodeView: View {
    let payload: String
    var size: CGFloat = 200

    private static let context = CIContext()

    var body: some View {
        if let image = Self.makeImage(from: payload, side: size) {
            Image(nsImage: image)
                .interpolation(.none)
                .resizable()
                .frame(width: size, height: size)
                .background(Color.white)
                .cornerRadius(FB.Radius.md)
        } else {
            RoundedRectangle(cornerRadius: FB.Radius.md)
                .fill(FB.Colors.surfaceSunken)
                .frame(width: size, height: size)
                .overlay(Text("QR unavailable").font(FB.Font.caption()).foregroundStyle(FB.Colors.textMuted))
        }
    }

    private static func makeImage(from string: String, side: CGFloat) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scale = side / output.extent.width
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: side, height: side))
    }
}

/// A simple status card (icon + title + subtitle) matching the app's
/// surface/border styling. Used for session-recipe status and notices.
struct StatusCard: View {
    let icon: String
    let tint: Color
    let title: String
    let subtitle: String

    var body: some View {
        HStack(alignment: .top, spacing: FB.Spacing.s3) {
            Image(systemName: icon)
                .imageScale(.large)
                .foregroundStyle(tint)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: FB.Spacing.s1) {
                Text(title)
                    .font(FB.Font.rowTitle())
                    .foregroundStyle(FB.Colors.ink)
                Text(subtitle)
                    .font(FB.Font.caption())
                    .foregroundStyle(FB.Colors.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(FB.Spacing.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: FB.Radius.md).fill(FB.Colors.surface))
        .overlay(RoundedRectangle(cornerRadius: FB.Radius.md).strokeBorder(FB.Colors.border, lineWidth: 1))
    }
}
