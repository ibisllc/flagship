import SwiftUI
import FlagshipCore

/// Reusable "share a link" block for service-access gating (docs §v2
/// "Convenience — QR in the share"): the monospaced link text (the RELIABLE
/// fallback — email clients strip data-URI QR images), an inline QR for rich
/// channels / cross-device scanning, Copy, and the native Share sheet. Used by
/// the create surface (invite link) and the friend's manual-approve reply.
struct InviteShareCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(ToastCenter.self) private var toasts

    let title: String
    let subtitle: String?
    let link: String
    /// Accessibility-id prefix so callers get distinct ids (e.g. "service-access").
    let idPrefix: String

    init(title: String, subtitle: String? = nil, link: String, idPrefix: String) {
        self.title = title
        self.subtitle = subtitle
        self.link = link
        self.idPrefix = idPrefix
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text(title)
                .font(FS.font.caption())
                .foregroundColor(c.text)
            if let subtitle {
                Text(subtitle)
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            }
            // Inline QR (rich channels + cross-device). Centered, modest size.
            HStack {
                Spacer()
                PairingQRView(text: link, size: 180)
                    .accessibilityIdentifier("\(idPrefix)-qr")
                Spacer()
            }
            .padding(.vertical, FS.space.s1)
            Text(link)
                .font(FS.font.mono())
                .foregroundColor(c.text)
                .textSelection(.enabled)
                .padding(.vertical, FS.space.s2)
                .padding(.horizontal, FS.space.s3)
                .background(c.surfaceSunken)
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
                .accessibilityIdentifier("\(idPrefix)-url")
            HStack(spacing: FS.space.s3) {
                if let url = URL(string: link) {
                    ShareLink(item: url) {
                        Label("Share…", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("\(idPrefix)-share-sheet")
                }
                Button {
                    UIPasteboard.general.string = link
                    toasts.success("Link copied.")
                } label: {
                    Label("Copy link", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("\(idPrefix)-copy-btn")
            }
        }
    }
}
