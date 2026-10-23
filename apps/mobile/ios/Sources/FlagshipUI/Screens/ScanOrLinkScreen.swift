import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Settings → Devices → "Scan a code or enter a link". One place for every
/// Flagship code or link: the camera, or a pasted link or pairing code.
///
/// What comes in is parsed by `DeepLink` (the universal-link parser) and handed
/// to the `DeepLinker`, so it opens exactly the screen a tapped link or the
/// system camera opens: a `/join` code the join flow (which still shows the
/// 6-digit match code the admin compares), an `/access` link the browser
/// sign-in, a share, invite, transfer, Studio or Remote link its own screen,
/// an `/app/…` link the screen it names. Typing a link is no weaker than
/// scanning it: nothing here relies on the camera. Replaces "Process URL".
/// MIRRORS the webapp (`openScanOrLink`) and Android (`ScanOrLinkScreen`).
public struct ScanOrLinkScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(DeepLinker.self) private var linker
    @Environment(\.dismiss) private var dismiss

    @State private var text: String = ""
    @State private var error: String?
    @State private var scanError: String?
    @State private var opening = false

    public init() {}

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Scan a Flagship QR code, or paste its link. To join another account, open Settings → Trusted devices → Add a device on a device of that account.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                QRScannerView(
                    onScan: { raw in Task { @MainActor in open(raw) } },
                    onError: { msg in scanError = msg },
                    validate: { raw in Self.link(from: raw) != nil }
                )
                .frame(height: 280)
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
                .accessibilityIdentifier("scan-or-link-camera")
                if let scanError {
                    Text(scanError).font(FS.font.caption()).foregroundColor(c.danger)
                }
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text("Code or link").font(FS.font.caption()).foregroundColor(c.textMuted)
                        HStack(spacing: FS.space.s2) {
                            TextField("https://\(Endpoints.controlHost)/…", text: $text, axis: .vertical)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled(true)
                                .keyboardType(.URL)
                                .lineLimit(1...4)
                                .font(FS.font.mono())
                                .foregroundColor(c.text)
                                .fsInputBox()
                                .accessibilityIdentifier("scan-or-link-field")
                            PasteButton(payloadType: String.self) { strings in
                                guard let first = strings.first else { return }
                                Task { @MainActor in
                                    text = first
                                    error = nil
                                }
                            }
                            .labelStyle(.iconOnly)
                            .buttonBorderShape(.roundedRectangle)
                            .accessibilityIdentifier("scan-or-link-paste")
                        }
                        if let error {
                            Text(error)
                                .font(FS.font.bodySm())
                                .foregroundColor(c.danger)
                                .accessibilityIdentifier("scan-or-link-error")
                        }
                    }
                }
                FSPrimaryButton(String(localized: "Open"), block: true, large: true) { open(text) }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || opening)
                    .accessibilityIdentifier("scan-or-link-open")
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
            .fsReadingColumn()
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Scan a code or enter a link")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// A Flagship link, or a bare pairing code (`sid=…&pk=…`) read as the
    /// `/join` link it came from. Nil for anything else.
    static func link(from raw: String) -> DeepLink? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let link = DeepLink.parsePastedString(trimmed) { return link }
        if !trimmed.contains("://"), (try? PairingQr.parseJoinUrl(trimmed)) != nil {
            let query = trimmed.hasPrefix("?") ? String(trimmed.dropFirst()) : trimmed
            return DeepLink.parsePastedString("https://\(Endpoints.controlHost)/join?\(query)")
        }
        return nil
    }

    private func open(_ raw: String) {
        guard !opening else { return }
        error = nil
        guard let link = Self.link(from: raw) else {
            error = String(localized: "That isn't a Flagship code or link. Copy the whole link and try again.")
            return
        }
        opening = true
        // Pop first so the next screen isn't pushed under this one; enqueue
        // after the pop (a link pushed in the same transaction as the pop left
        // the stack on a blank page).
        dismiss()
        let linker = self.linker
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(500))
            linker.enqueue(link)
        }
    }
}
