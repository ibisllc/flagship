import SwiftUI
import UniformTypeIdentifiers
import FlagshipCore

/// "Back up your account key" — exports the UMK into a passphrase-
/// encrypted `.flagshipkey` file. Reached from Settings → Recovery.
///
/// The "Create backup file" CTA enables only when a 12+-character
/// passphrase is set + confirmed and the control acknowledgment is checked.
/// On success the file is offered via the
/// share sheet as `<username>.flagshipkey`; we never write it ourselves.
public struct KeyfileExportScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: KeyfileExportViewModel

    @State private var shareURL: URL?
    @State private var showSaved = false

    public init(vm: KeyfileExportViewModel) {
        self.vm = vm
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                dangerCard(c: c)
                passphraseCard(c: c)
                acknowledgmentCard(c: c)

                if case .failed(let msg) = vm.phase {
                    ErrorCard(message: msg)
                }

                FSPrimaryButton(
                    "Create backup file",
                    enabled: vm.canCreate && !isWorking,
                    block: true,
                    large: true
                ) {
                    Task { await vm.createBackup() }
                }
                .accessibilityIdentifier("keyfile-export-create")

                if showSaved {
                    savedCard(c: c)
                }
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Account backup")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: readyText) { _, text in
            guard let text else { return }
            shareURL = Self.writeTempKeyfile(text: text, filename: vm.suggestedFilename)
        }
        .sheet(item: $shareURL) { url in
            ShareSheet(items: [url]) {
                // After the share sheet dismisses, surface the
                // "saved" confirmation + clean up the temp file.
                showSaved = true
                vm.reset()
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    private var isWorking: Bool {
        if case .working = vm.phase { return true }
        return false
    }

    private var readyText: String? {
        if case .ready(let text) = vm.phase { return text }
        return nil
    }

    private func dangerCard(c: FSColors) -> some View {
        FSCard {
            HStack(alignment: .top, spacing: FS.space.s2) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(c.danger)
                Text("Anyone with both this file and its passphrase can take over your account and lock you out.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.text)
            }
        }
        .accessibilityIdentifier("keyfile-export-danger")
    }

    private func passphraseCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                FSField(
                    value: $vm.passphrase,
                    label: "Passphrase",
                    helper: "12 characters minimum",
                    error: vm.passphrase.isEmpty || vm.passphraseStrong
                        ? nil
                        : "12 characters minimum",
                    secure: true
                )
                .accessibilityIdentifier("keyfile-export-passphrase")
                FSField(
                    value: $vm.confirmPassphrase,
                    label: "Confirm Passphrase",
                    error: vm.confirmPassphrase.isEmpty || vm.passphrasesMatch
                        ? nil
                        : "Passphrases don't match.",
                    secure: true
                )
                .accessibilityIdentifier("keyfile-export-confirm")
            }
        }
    }

    private func acknowledgmentCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                checkbox(
                    isOn: $vm.ackControl,
                    text: "I understand anyone with this file and passphrase controls my entire account.",
                    id: "keyfile-export-ack-control",
                    c: c
                )
            }
        }
    }

    private func savedCard(c: FSColors) -> some View {
        FSCard {
            HStack(alignment: .top, spacing: FS.space.s2) {
                Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                Text("Backup saved. Keep it somewhere safe and offline.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.text)
            }
        }
        .accessibilityIdentifier("keyfile-export-saved")
    }

    private func checkbox(isOn: Binding<Bool>, text: String, id: String, c: FSColors) -> some View {
        Button(action: { isOn.wrappedValue.toggle() }) {
            HStack(alignment: .top, spacing: FS.space.s2) {
                Image(systemName: isOn.wrappedValue ? "checkmark.square.fill" : "square")
                    .foregroundColor(isOn.wrappedValue ? c.primary : c.textMuted)
                    .imageScale(.large)
                Text(text)
                    .font(FS.font.bodySm())
                    .foregroundColor(c.text)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
        .accessibilityAddTraits(isOn.wrappedValue ? [.isSelected] : [])
    }

    /// Write the keyfile text to a temp file named
    /// `<username>.flagshipkey` so the share sheet hands the user a real
    /// file with the right name + extension (rather than raw text).
    static func writeTempKeyfile(text: String, filename: String) -> URL? {
        let dir = FileManager.default.temporaryDirectory
        let url = dir.appendingPathComponent(filename)
        try? FileManager.default.removeItem(at: url)
        do {
            try text.data(using: .utf8)?.write(to: url, options: [.atomic, .completeFileProtection])
            return url
        } catch {
            return nil
        }
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

/// UIActivityViewController bridge for SwiftUI — the share sheet used to
/// hand the user the `.flagshipkey` file (AirDrop, Files, etc.).
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    var onDismiss: () -> Void = {}

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
        vc.completionWithItemsHandler = { _, _, _, _ in onDismiss() }
        return vc
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
