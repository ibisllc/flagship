import SwiftUI

/// Small leader / main-server marker — a stylized flag: a rectangular flag on
/// a pole with a triangular swallowtail notch cut into its right edge. Replaces
/// the former `crown.fill` glyph, which read as gaudy and clashed with the
/// teal selection state in the pod switcher.
///
/// This is a functional row marker, NOT the (retired) brand pennant — it is
/// drawn here as plain geometry so it renders inside our own custom dropdown
/// rows (a system `Menu`/`contextMenu` only renders SF Symbols for icons).
public struct LeaderFlag: View {
    private let size: CGFloat
    private let tint: Color

    public init(size: CGFloat = 12, tint: Color) {
        self.size = size
        self.tint = tint
    }

    public var body: some View {
        Canvas { ctx, canvasSize in
            // Coordinates are authored in a 24×24 box and scaled to fit, so the
            // shape matches the webapp SVG + Android Canvas byte-for-byte.
            let s = canvasSize.width / 24.0
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * s, y: y * s) }

            var flag = Path()
            flag.move(to: p(6.8, 4))
            flag.addLine(to: p(19, 4))
            flag.addLine(to: p(15, 8.5))   // swallowtail notch tip
            flag.addLine(to: p(19, 13))
            flag.addLine(to: p(6.8, 13))
            flag.closeSubpath()
            ctx.fill(flag, with: .color(tint))

            var pole = Path()
            pole.move(to: p(6, 3))
            pole.addLine(to: p(6, 21))
            ctx.stroke(
                pole,
                with: .color(tint),
                style: StrokeStyle(lineWidth: 1.8 * s, lineCap: .round)
            )
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
