import SwiftUI

/// Placeholder for the "I already have a server" flow. Real impl will
/// open the camera to scan a pairing QR (or accept a numeric pair code)
/// produced by `apps/web/public/webapp/views/pod-pair.js`.
public struct PodPairScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var pairCode: String = ""
    @State private var name: String = ""
    @State private var description: String = ""
    var onSubmit: (_ code: String, _ name: String, _ description: String) -> Void = { _, _, _ in }
    var onCancel: () -> Void = {}

    public init(
        onSubmit: @escaping (_ code: String, _ name: String, _ description: String) -> Void = { _, _, _ in },
        onCancel: @escaping () -> Void = {}
    ) {
        self.onSubmit = onSubmit
        self.onCancel = onCancel
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s12)
                Text("Pair to your server").font(FS.font.h2()).foregroundColor(c.text)
                Text("Open the Flagship webapp on a device that's already signed in. Scan the QR it shows, or paste the 6-character pair code below.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)

                FSCard(padding: FS.space.s8) {
                    VStack(spacing: FS.space.s4) {
                        Image(systemName: "qrcode.viewfinder")
                            .font(.system(size: 56))
                            .foregroundColor(c.primary)
                        Text("Scan QR")
                            .font(FS.font.h3())
                            .foregroundColor(c.text)
                        Text("Camera permission needed (not yet wired)")
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                    }
                    .frame(maxWidth: .infinity)
                }

                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text("OR ENTER A CODE")
                        .font(.system(size: 12, weight: .semibold))
                        .tracking(1)
                        .foregroundColor(c.textMuted)
                    FSField(value: $pairCode, label: "", placeholder: "ABC123")
                }

                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        Text("NAME THIS SERVER")
                            .font(.system(size: 12, weight: .semibold))
                            .tracking(1)
                            .foregroundColor(c.textMuted)
                        FSField(value: $name, label: "Short name", placeholder: "Office, Garage")
                        FSField(value: $description, label: "One-line description", placeholder: "Failover for work")
                    }
                }

                FSPrimaryButton("Connect", enabled: pairCode.count >= 6 && !name.isEmpty, block: true, large: true) {
                    onSubmit(pairCode, name, description)
                }
                FSGhostButton("Cancel", block: true, action: onCancel)
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
    }
}
