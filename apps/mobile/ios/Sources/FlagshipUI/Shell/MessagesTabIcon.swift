import SwiftUI
import UIKit

/// The Messages destination stands out in the tab bar and the iPad sidebar: its glyph sits on a teal disc, a little
/// larger and bolder than the other icons, selected or not. The disc is decoration: the item keeps its "Messages" label
/// (and its unread badge). Teal fill with dark ink, never white (design-system contrast rule for `primaryFill`).
enum MessagesTabIcon {
    static let glyph = "bubble.left.fill"

    /// A tab bar item image. A UITabBar tints template images, so this one is drawn and marked original.
    static func image(fill: UIColor, ink: UIColor, side: CGFloat = 30) -> UIImage {
        let size = CGSize(width: side, height: side)
        let img = UIGraphicsImageRenderer(size: size).image { _ in
            fill.setFill()
            UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).fill()
            let cfg = UIImage.SymbolConfiguration(pointSize: side * 0.47, weight: .bold)
            guard let sym = UIImage(systemName: glyph, withConfiguration: cfg)?.withTintColor(ink, renderingMode: .alwaysOriginal) else { return }
            let s = sym.size
            sym.draw(in: CGRect(x: (side - s.width) / 2, y: (side - s.height) / 2 + side * 0.02, width: s.width, height: s.height))
        }
        return img.withRenderingMode(.alwaysOriginal)
    }
}

/// The same disc for SwiftUI rows (the iPad sidebar).
struct MessagesDisc: View {
    let c: FSColors
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = 26

    var body: some View {
        ZStack {
            Circle().fill(c.primaryFill)
            Image(systemName: MessagesTabIcon.glyph)
                .font(.system(size: side * 0.47, weight: .bold))
                .foregroundStyle(c.onPrimary)
        }
        .frame(width: side, height: side)
        .accessibilityHidden(true)
    }
}
