import SwiftUI

/// Two-card chooser used everywhere we need the "add a server" decision:
///   - Onboarding (when the user has zero servers)
///   - In-app: Home pane → Add server, Settings → Add server
///
/// Both branches lead to existing flows (`CreateServerStubScreen` /
/// `PodPairScreen`). The screen is presentation-only — the parent owns
/// the navigation push.
public struct AddServerChooserScreen: View {
    @Environment(\.colorScheme) private var scheme
    public enum Mode { case onboarding, inApp }

    let mode: Mode
    var onProvision: () -> Void
    var onPair: () -> Void

    public init(
        mode: Mode = .inApp,
        onProvision: @escaping () -> Void = {},
        onPair: @escaping () -> Void = {}
    ) {
        self.mode = mode
        self.onProvision = onProvision
        self.onPair = onPair
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: mode == .onboarding ? FS.space.s12 : FS.space.s4)
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text(title).font(FS.font.h2()).foregroundColor(c.text)
                    Text(subtitle).font(FS.font.body()).foregroundColor(c.textMuted)
                }

                Button(action: onProvision) {
                    chooserCard(
                        icon: "server.rack",
                        accent: c.primary,
                        title: "Provision a new box",
                        body: "Mint a build code, download a personalized Alpine ISO, flash it to commodity hardware. Cert + tunnel come up automatically.",
                        c: c
                    )
                }
                .buttonStyle(.plain)

                Button(action: onPair) {
                    chooserCard(
                        icon: "qrcode.viewfinder",
                        accent: c.success,
                        title: "Pair an existing box",
                        body: "Already have a Flagship server running somewhere? Scan its pairing QR or paste the 6-character code.",
                        c: c
                    )
                }
                .buttonStyle(.plain)

                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(mode == .onboarding ? "" : "Add a server")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var title: String {
        mode == .onboarding ? "Get your first server." : "Add a server."
    }
    private var subtitle: String {
        mode == .onboarding
            ? "Pick a path — both end with your stuff running on hardware you control."
            : "Add another box to your fleet. Each one is independent."
    }

    private func chooserCard(icon: String, accent: Color, title: String, body: String, c: FSColors) -> some View {
        FSCard(padding: FS.space.s6) {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                ZStack {
                    RoundedRectangle(cornerRadius: FS.radius.sm)
                        .fill(accent.opacity(0.12))
                    Image(systemName: icon)
                        .foregroundColor(accent)
                        .font(.system(size: 22, weight: .semibold))
                }
                .frame(width: 44, height: 44)
                Text(title).font(FS.font.h3()).foregroundColor(c.text)
                Text(body).font(FS.font.body()).foregroundColor(c.textMuted)
                HStack {
                    Spacer()
                    Image(systemName: "arrow.right")
                        .foregroundColor(accent)
                }
            }
        }
    }
}
