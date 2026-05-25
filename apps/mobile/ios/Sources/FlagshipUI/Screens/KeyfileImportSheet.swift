import SwiftUI
import UniformTypeIdentifiers
import FlagshipAPI
import FlagshipCore

/// "Import backup file" — sheet presented from the recovery screen
/// (RealAccountLoginScreen), below the iCloud option. Brings this device
/// into an account using its `.flagshipkey` backup.
///
/// Flow: pick a file → enter passphrase → unwrap → install UMK →
/// takeover re-pair. On `.finalized` we call `onComplete(username:)`; the
/// host completes onboarding paired (mirroring the credentialed takeover).
public struct KeyfileImportSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    @Bindable var vm: KeyfileImportViewModel
    public var onComplete: (_ username: String) -> Void

    @State private var showPicker = false
    @State private var pickedFileText: String?
    @State private var pickError: String?

    public init(
        vm: KeyfileImportViewModel,
        onComplete: @escaping (_ username: String) -> Void = { _ in }
    ) {
        self.vm = vm
        self.onComplete = onComplete
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Text("Bring this device into your account using its backup key file. You'll need the file and its passphrase.")
                        .font(FS.font.body())
                        .foregroundColor(c.textMuted)

                    content(c: c)
                }
                .padding(FS.space.s6)
            }
            .background(c.bg.ignoresSafeArea())
            .navigationTitle("Import backup file")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .fileImporter(
                isPresented: $showPicker,
                allowedContentTypes: Self.allowedTypes,
                allowsMultipleSelection: false
            ) { result in
                handlePick(result)
            }
            .onChange(of: finalizedUsername) { _, username in
                if let username { onComplete(username) }
            }
        }
    }

    @ViewBuilder
    private func content(c: FSColors) -> some View {
        switch vm.phase {
        case .working:
            workingView(c: c)
        case .finalized:
            workingView(c: c)
        case .completed(_, let completesAt):
            graceCountdownView(completesAt: completesAt, c: c)
        default:
            chooseAndUnlock(c: c)
        }
    }

    private func chooseAndUnlock(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            FSCard {
                HStack(alignment: .top, spacing: FS.space.s2) {
                    Image(systemName: pickedFileText == nil ? "doc.badge.plus" : "doc.badge.checkmark")
                        .foregroundColor(pickedFileText == nil ? c.primary : c.success)
                        .imageScale(.large)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(pickedFileText == nil ? "Choose your backup file" : "Backup file selected")
                            .font(FS.font.bodySm()).foregroundColor(c.text)
                        Text(pickedFileText == nil
                             ? "Pick the .flagshipkey file you saved earlier."
                             : "Now enter the passphrase you set when you created it.")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                }
            }

            FSGhostButton(pickedFileText == nil ? "Choose file" : "Choose a different file", block: true) {
                pickError = nil
                showPicker = true
            }
            .accessibilityIdentifier("keyfile-import-choose")

            if pickedFileText != nil {
                FSField(
                    value: $vm.passphrase,
                    label: "Passphrase",
                    placeholder: "The passphrase for this file",
                    secure: true
                )
                .accessibilityIdentifier("keyfile-import-passphrase")
            }

            if let pickError {
                Text(pickError)
                    .font(FS.font.bodySm())
                    .foregroundColor(c.danger)
                    .accessibilityIdentifier("keyfile-import-pick-error")
            }
            if case .failed(let msg) = vm.phase {
                Text(msg)
                    .font(FS.font.bodySm())
                    .foregroundColor(c.danger)
                    .accessibilityIdentifier("keyfile-import-error")
            }

            FSPrimaryButton(
                "Import",
                enabled: pickedFileText != nil && vm.canImport,
                block: true,
                large: true
            ) {
                guard let text = pickedFileText else { return }
                Task { await vm.importBackup(fileText: text) }
            }
            .accessibilityIdentifier("keyfile-import-continue")
        }
    }

    private func graceCountdownView(completesAt: Int64, c: FSColors) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let nowMs = Int64(ctx.date.timeIntervalSince1970 * 1000)
            let remaining = max(0, completesAt - nowMs)
            let elapsed = remaining == 0
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Bringing this device in")
                    .font(FS.font.h3()).foregroundColor(c.text)
                FSCard {
                    HStack(alignment: .top, spacing: FS.space.s2) {
                        Image(systemName: "clock.badge.exclamationmark")
                            .foregroundColor(c.primary)
                        Text(elapsed
                             ? "The grace period has elapsed — you can finish now."
                             : "This device takes over in \(RealAccountLoginScreen.formatRemaining(remaining)). Your other devices are being alerted and can object until then.")
                            .font(FS.font.bodySm()).foregroundColor(c.text)
                    }
                }
                FSPrimaryButton("Finish now", enabled: elapsed, block: true, large: true) {
                    Task { await vm.completeTakeover() }
                }
                .accessibilityIdentifier("keyfile-import-finish")
            }
        }
        .accessibilityIdentifier("keyfile-import-grace")
    }

    private func workingView(c: FSColors) -> some View {
        VStack(spacing: FS.space.s4) {
            ProgressView().scaleEffect(1.3)
            Text("Unlocking your account key…")
                .font(FS.font.h3()).foregroundColor(c.text)
            Text("Decrypting the backup and bringing this device into your Flagship account.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, FS.space.s8)
        .accessibilityIdentifier("keyfile-import-working")
    }

    private var finalizedUsername: String? {
        if case .finalized(let username) = vm.phase { return username }
        return nil
    }

    private func handlePick(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                guard let text = String(data: data, encoding: .utf8) else {
                    pickError = "This isn't a Flagship key file."
                    return
                }
                pickedFileText = text
                pickError = nil
                vm.reset()
            } catch {
                pickError = "Couldn't read that file. Try choosing it again."
            }
        case .failure:
            pickError = "Couldn't open the file picker. Try again."
        }
    }

    /// Accept the `.flagshipkey` extension (registered below as a custom
    /// UTType) plus generic JSON / plain text so a file saved with a
    /// different extension can still be picked.
    static let allowedTypes: [UTType] = {
        var types: [UTType] = [.json, .text, .plainText, .data]
        if let key = UTType(filenameExtension: "flagshipkey") {
            types.insert(key, at: 0)
        }
        return types
    }()
}
