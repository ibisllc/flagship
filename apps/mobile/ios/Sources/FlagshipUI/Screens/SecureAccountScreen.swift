import SwiftUI
import CryptoKit
import Flagship
import FlagshipCore
import FlagshipAPI

/// **Secure your account** — the skippable backup nudge shown right after
/// a brand-new account is opened (OpenAccount) and before the user lands
/// in the main app. Cloud and a backup file are two independent ticks,
/// both off at first; Continue runs every ticked one (cloud first, then the
/// file). Skip warns from the Skip button itself.
///
/// This screen REUSES the two existing backup mechanisms:
///   - cloud → the WebAuthn-PRF cloud recovery (RecoveryViewModel),
///     which wraps the live UMK under a passkey-derived key and a recovery
///     passphrase and ships the envelope to flagshipserver.com; the
///     passphrase fields show only while cloud is ticked, inside its row,
///   - file  → the existing KeyfileExportScreen / KeyfileExportViewModel
///     (`.flagshipkey` export, with its own passphrase), presented as a sheet.
public struct SecureAccountScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.flagshipServerClient) private var server

    let username: String
    /// Called after a successful backup (cloud enrolled OR file exported).
    var onSecured: () -> Void
    /// Called when the user confirms "Skip anyway".
    var onSkip: () -> Void

    @State private var vm: SecureAccountViewModel
    @State private var recoveryVm: RecoveryViewModel?
    @State private var showFileExport = false
    @State private var cloudError: String?
    @State private var cloudWorking = false
    @State private var cloudPassphrase = ""
    @State private var cloudPassphrase2 = ""
    /// Cloud backup finished on an earlier Continue (the file is still to do).
    @State private var cloudDone = false

    public init(
        username: String,
        viewModel: SecureAccountViewModel? = nil,
        onSecured: @escaping () -> Void = {},
        onSkip: @escaping () -> Void = {}
    ) {
        self.username = username
        self.onSecured = onSecured
        self.onSkip = onSkip
        _vm = State(initialValue: viewModel ?? SecureAccountViewModel())
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s6) {
                    Text("Back up your account now so you can get back in if you lose this device. We cannot recover it for you.")
                        .font(FS.font.body())
                        .foregroundColor(c.textMuted)
                        .padding(.top, FS.space.s4)

                    VStack(spacing: FS.space.s3) {
                        cloudRow(c: c)
                        fileRow(c: c)
                    }

                    if let cloudError {
                        ErrorCard(message: cloudError)
                    }

                    FSPrimaryButton(
                        cloudWorking ? String(localized: "Backing up…") : String(localized: "Continue"),
                        enabled: vm.canContinue && !cloudWorking,
                        block: true,
                        large: true
                    ) {
                        Task { await onContinue() }
                    }
                    .accessibilityIdentifier("secure-account-continue")

                    Button(action: { vm.requestSkip() }) {
                        Text("Skip for now")
                            .font(FS.font.body())
                            .foregroundColor(c.textMuted)
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .disabled(cloudWorking)
                    .accessibilityIdentifier("secure-account-skip")
                    // The warning pops up from Skip itself: a popover anchored
                    // to the button on iPad and iPhone alike.
                    .popover(
                        isPresented: Binding(
                            get: { vm.showSkipConfirm },
                            set: { if !$0 { vm.cancelSkip() } }
                        ),
                        arrowEdge: .bottom
                    ) {
                        skipWarning(c: c)
                            .presentationCompactAdaptation(.popover)
                    }
                }
                .padding(.horizontal, FS.space.s6)
                .padding(.bottom, FS.space.s8)
            }
        }
        .navigationTitle("Secure your account")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .task {
            if recoveryVm == nil {
                // Platform-backed provider on device; the simulator path
                // falls back to a stable HKDF derivation. Same wiring as
                // Settings → Cloud recovery (RecoveryContainer).
                recoveryVm = RecoveryViewModel(
                    client: server,
                    webAuthn: RecoveryWebAuthn.provider(username: username),
                    username: { [username] in username }
                )
            }
        }
        .sheet(isPresented: $showFileExport) {
            NavigationStack {
                KeyfileExportScreen(vm: KeyfileExportViewModel(username: username))
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Done") {
                                // The export sheet handles its own
                                // success surface; dismissing it after a
                                // backup proceeds into the app.
                                showFileExport = false
                                onSecured()
                            }
                        }
                    }
            }
        }
    }

    // MARK: - Rows

    /// The skip warning, shown in a popover anchored to Skip.
    private func skipWarning(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("Without a backup, losing this device means losing your account for good. You can set this up anytime in Settings.")
                .font(FS.font.bodySm())
                .foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: FS.space.s3) {
                Button("Back") { vm.cancelSkip() }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("secure-account-skip-back")
                Spacer(minLength: 0)
                Button("Skip anyway", role: .destructive) {
                    vm.cancelSkip()
                    onSkip()
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .accessibilityIdentifier("secure-account-skip-anyway")
            }
        }
        .padding(FS.space.s4)
        .frame(idealWidth: 320, maxWidth: 360)
    }

    /// Recovery-passphrase entry for cloud backup (Task #4). Mirrors
    /// recovery.js enroll: two fields, 8+ chars, must match. The passphrase
    /// is Argon2id-hardened on enroll and is REQUIRED — plus the passkey —
    /// to recover on a new device. It belongs to cloud backup only (the
    /// file export asks for its own), so it shows inside the cloud row
    /// while cloud is ticked.
    private func cloudPassphraseFields(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text("Recovery passphrase")
                .font(FS.font.h4())
                .foregroundColor(c.text)
            Text("Treat this like a password — write it down somewhere safe. You'll need it, plus your passkey, to get back in on a new device. We can't reset it.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            SecureField("Passphrase (8+ characters)", text: $cloudPassphrase)
                .textContentType(.newPassword)
                .autocorrectionDisabled(true)
                .textInputAutocapitalization(.never)
                .fsInputBox()
                .accessibilityIdentifier("secure-account-passphrase")
            SecureField("Re-enter passphrase", text: $cloudPassphrase2)
                .textContentType(.newPassword)
                .autocorrectionDisabled(true)
                .textInputAutocapitalization(.never)
                .fsInputBox()
                .accessibilityIdentifier("secure-account-passphrase-2")
            Text(RecoveryPasskeyCopy.passphraseHint)
                .font(FS.font.caption())
                .foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("secure-account-passphrase-hint")
        }
        .padding([.horizontal, .bottom], FS.space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func cloudRow(c: FSColors) -> some View {
        let checked = vm.cloudSelected || cloudDone
        return optionCard(checked: checked, c: c) {
            optionRow(
                checked: checked,
                enabled: vm.canSelectCloud && !cloudDone && !cloudWorking,
                icon: "icloud.fill",
                title: String(localized: "Back up to iCloud"),
                subtitle: vm.iCloudAvailable
                    ? String(localized: "Syncs securely with your other Apple devices.")
                    : "iCloud is off — turn it on in Settings, or use a backup file.",
                id: "secure-account-option-cloud",
                c: c
            ) {
                vm.toggleCloud()
            }
            if vm.cloudSelected && !cloudDone {
                cloudPassphraseFields(c: c)
            }
        }
    }

    private func fileRow(c: FSColors) -> some View {
        optionCard(checked: vm.fileSelected, c: c) {
            optionRow(
                checked: vm.fileSelected,
                enabled: !cloudWorking,
                icon: "doc.badge.arrow.up.fill",
                title: String(localized: "Save a backup file"),
                subtitle: String(localized: "An encrypted .flagshipkey you keep yourself."),
                id: "secure-account-option-file",
                c: c
            ) {
                vm.toggleFile()
            }
        }
    }

    private func optionCard<Content: View>(
        checked: Bool,
        c: FSColors,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(c.surface)
            .overlay(
                RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous)
                    .stroke(checked ? c.accent : c.border, lineWidth: checked ? 2 : 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
    }

    /// One tickable backup option: a checkbox, since the two are
    /// independent (either, both, or neither).
    private func optionRow(
        checked: Bool,
        enabled: Bool,
        icon: String,
        title: String,
        subtitle: String,
        id: String,
        c: FSColors,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: FS.space.s3) {
                Image(systemName: icon)
                    .imageScale(.large)
                    .foregroundColor(enabled || checked ? c.accent : c.textMuted)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(FS.font.h4())
                        .foregroundColor(enabled || checked ? c.text : c.textMuted)
                    Text(subtitle)
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: checked ? "checkmark.square.fill" : "square")
                    .imageScale(.large)
                    .foregroundColor(checked ? c.accent : c.border)
            }
            .padding(FS.space.s4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .opacity(enabled || checked ? 1 : 0.6)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityIdentifier(id)
        .accessibilityAddTraits(checked ? [.isSelected] : [])
    }

    // MARK: - Actions

    /// Runs every ticked backup: cloud first (it stays on this screen for
    /// its passphrase and passkey), then the file export sheet, whose Done
    /// enters the app. Cloud alone enters the app as soon as it is set up.
    private func onContinue() async {
        cloudError = nil
        if vm.cloudSelected && !cloudDone {
            await setUpCloudBackup()
            guard cloudDone else { return }
        }
        if vm.fileSelected {
            showFileExport = true
        } else if cloudDone {
            onSecured()
        }
    }

    /// Drive the WebAuthn-PRF cloud recovery enrollment for the live UMK.
    /// The UMK already lives in this account's Keystore slot — OpenAccount
    /// pointed `setActiveProfile` at it before generating the UMK — so we
    /// read it back and hand it to RecoveryViewModel.setup.
    private func setUpCloudBackup() async {
        guard let recoveryVm else { return }
        // Validate the recovery passphrase up front (mirrors recovery.js
        // enroll). The Argon2id derivation + envelope upload happen inside
        // RecoveryViewModel.setup.
        guard cloudPassphrase.count >= 8 else {
            cloudError = RecoveryPasskeyCopy.passphraseTooShort
            return
        }
        guard cloudPassphrase == cloudPassphrase2 else {
            cloudError = String(localized: "Passphrases do not match.")
            return
        }
        cloudError = nil
        cloudWorking = true
        defer { cloudWorking = false }
        do {
            let umk = try await Keystore.currentUMK(reason: String(localized: "Back up your Flagship account to iCloud"))
            await recoveryVm.setup(umkSeed: umk, passphrase: cloudPassphrase)
            if case .registered = recoveryVm.phase {
                cloudPassphrase = ""
                cloudPassphrase2 = ""
                cloudDone = true
            } else if case .failed(let msg) = recoveryVm.phase {
                cloudError = msg
            }
        } catch {
            cloudError = String(localized: "Couldn't back up to iCloud: \(UserErrorText.of(error))")
        }
    }
}
