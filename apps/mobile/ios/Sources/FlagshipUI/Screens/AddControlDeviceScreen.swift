import SwiftUI

/// Surfaces a one-time pair code (and a QR rendering of it) so a fresh
/// phone or laptop can be onboarded against this account. The new
/// device scans/types the code during its own onboarding "I already
/// have a server" path.
///
/// Real impl will generate the code via the daemon's
/// `add-paired-session` PhoneOrder + expire it after a short TTL.
/// Mock just shows a placeholder code.
public struct AddControlDeviceScreen: View {
    @Environment(\.colorScheme) private var scheme
    let pairCode: String

    public init(pairCode: String = generateMockCode()) {
        self.pairCode = pairCode
    }

    public static func generateMockCode() -> String {
        let alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        return String((0..<6).map { _ in alphabet.randomElement()! })
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Text("Add a control device").font(FS.font.h2()).foregroundColor(c.text)
                Text("On your other phone or laptop, install Flagship and tap \"I already have a server\". Scan the QR below, or paste the 6-character code.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)

                FSCard(padding: FS.space.s8) {
                    VStack(spacing: FS.space.s4) {
                        QRPlaceholder(text: pairCode)
                            .frame(width: 220, height: 220)
                        Text(pairCode)
                            .font(.system(size: 28, weight: .semibold, design: .monospaced))
                            .foregroundColor(c.text)
                            .tracking(4)
                        Text("Expires in 5 minutes")
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                    }
                    .frame(maxWidth: .infinity)
                }

                FSCard {
                    HStack(alignment: .top, spacing: FS.space.s2) {
                        Image(systemName: "info.circle.fill").foregroundColor(c.primary)
                        Text("Only people who can read this screen can pair. The code becomes invalid after one use or 5 minutes, whichever comes first.")
                            .font(FS.font.bodySm()).foregroundColor(c.text)
                    }
                }

                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Add device")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// SwiftUI-rendered checkerboard placeholder for a real CIQRCodeGenerator
/// barcode. Kept inline so we don't take a CoreImage dependency here.
private struct QRPlaceholder: View {
    @Environment(\.colorScheme) private var scheme
    let text: String
    var body: some View {
        let c = FSColors.scheme(scheme)
        let rows = 21
        let cols = 21
        Canvas { context, size in
            let cell = min(size.width, size.height) / CGFloat(cols)
            var rng = SeededRNG(seed: UInt64(abs(text.hashValue)))
            for r in 0..<rows {
                for col in 0..<cols {
                    // Corner finder patterns
                    let inCorner = (r < 7 && col < 7)
                        || (r < 7 && col >= cols - 7)
                        || (r >= rows - 7 && col < 7)
                    let isOn: Bool
                    if inCorner {
                        let lr = r < 7 ? r : r - (rows - 7)
                        let lc = col < 7 ? col : col - (cols - 7)
                        isOn = (lr == 0 || lr == 6 || lc == 0 || lc == 6)
                            || (lr >= 2 && lr <= 4 && lc >= 2 && lc <= 4)
                    } else {
                        isOn = rng.next() < 0.45
                    }
                    if isOn {
                        let rect = CGRect(
                            x: CGFloat(col) * cell, y: CGFloat(r) * cell,
                            width: cell, height: cell
                        )
                        context.fill(Path(rect), with: .color(c.text))
                    }
                }
            }
        }
        .background(c.surface)
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
    }
}

/// Trivial LCG so the placeholder pattern stays stable for a given code.
private struct SeededRNG {
    var state: UInt64
    init(seed: UInt64) { state = seed == 0 ? 1 : seed }
    mutating func next() -> Double {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return Double(state >> 11) / Double(1 << 53)
    }
}
