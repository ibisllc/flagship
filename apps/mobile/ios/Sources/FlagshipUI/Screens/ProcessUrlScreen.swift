import SwiftUI
import FlagshipCore

/// Settings → "Process URL" (docs/service-access-gating.md, "Web-experience
/// gating"). A paste field that takes a `flagship://access?…` deeplink — or the
/// raw "Get link to paste in the app" string a box's knock page offers — and
/// routes it into the same KnockAuthorize flow as a tapped deeplink/QR.
///
/// It hands the parsed link to the `DeepLinker`; RootShell's router presents the
/// authorize cover (the same path the deeplink/QR takes), so this screen pops
/// itself and the cover appears on top. Any recognized Flagship deeplink is
/// accepted (not only `access`), so a pasted invite link works here too.
public struct ProcessUrlScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(DeepLinker.self) private var linker
    @Environment(\.dismiss) private var dismiss

    @State private var pasted: String = ""
    @State private var error: String?

    public init() {}

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Pasting a link from a Flagship sign-in page? Drop it here and we'll open it. Most of the time you'll just tap the link or scan the QR — this is the fallback when you can't.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text("Link").font(FS.font.caption()).foregroundColor(c.textMuted)
                        TextField("flagship://access?…", text: $pasted, axis: .vertical)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled(true)
                            .keyboardType(.URL)
                            .lineLimit(1...4)
                            .font(FS.font.mono())
                            .foregroundColor(c.text)
                            .padding(FS.space.s3)
                            .background(c.surfaceSunken)
                            .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
                            .accessibilityIdentifier("process-url-field")
                        if let error {
                            Text(error)
                                .font(FS.font.bodySm())
                                .foregroundColor(c.danger)
                                .accessibilityIdentifier("process-url-error")
                        }
                    }
                }
                FSPrimaryButton("Open link", block: true, large: true) { process() }
                    .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("process-url-open")
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Process URL")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func process() {
        error = nil
        guard let link = DeepLink.parsePastedString(pasted) else {
            error = "We couldn't read that link. Copy the full link from the sign-in page and try again."
            return
        }
        // Hand off to the shared router (RootShell presents the authorize cover).
        // Pop first so the cover isn't presented under this pushed screen.
        dismiss()
        linker.enqueue(link)
    }
}
