import SwiftUI
import CryptoKit
import Flagship
import FlagshipAPI

/// **Secure your account** — the skippable backup nudge shown right after
/// a brand-new account is opened (OpenAccount) and before the user lands
/// in the main app. Cloud is pre-selected; the user can pick a backup
/// file instead, or skip behind a clear warning.
///
/// This screen REUSES the two existing backup mechanisms:
///   - cloud → the WebAuthn-PRF cloud recovery (RecoveryViewModel), which
///     wraps the live UMK under a passkey-derived key and ships the
///     envelope to flagshipserver.com,
///   - file  → the existing KeyfileExportScreen / KeyfileExportViewModel
///     (`.flagshipkey` export), presented as a sheet.
///
/// Copy is verbatim + shared cross-surface for consistency.
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
                    Spacer().frame(height: FS.space.s8)

                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        Text("Secure your account")
                            .font(FS.font.h2())
                            .foregroundColor(c.text)
                        Text("Back up your account now so you can get back in if you lose this device. No one — not even us — can recover it for you.")
                            .font(FS.font.body())
                            .foregroundColor(c.textMuted)
                    }

                    VStack(spacing: FS.space.s3) {
                        cloudRow(c: c)
                        fileRow(c: c)
                    }

                    if let cloudError {
                        ErrorCard(message: cloudError)
                    }

                    Spacer().frame(height: FS.space.s4)

                    FSPrimaryButton(
                        cloudWorking ? "Backing up…" : "Continue",
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
                            .frame(height: 44)
                    }
                    .buttonStyle(.plain)
                    .disabled(cloudWorking)
                    .accessibilityIdentifier("secure-account-skip")
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
                // Settings → Recovery (RecoveryContainer).
                recoveryVm = RecoveryViewModel(
                    client: server,
                    webAuthn: PlatformWebAuthnProvider()
                )
            }
        }
        .confirmationDialog(
            "Without a backup, losing this device means losing your account for good. You can set this up anytime in Settings.",
            isPresented: Binding(
                get: { vm.showSkipConfirm },
                set: { if !$0 { vm.cancelSkip() } }
            ),
            titleVisibility: .visible
        ) {
            Button("Skip anyway", role: .destructive) {
                vm.cancelSkip()
                onSkip()
            }
            .accessibilityIdentifier("secure-account-skip-anyway")
            Button("Back", role: .cancel) { vm.cancelSkip() }
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

    private func cloudRow(c: FSColors) -> some View {
        optionRow(
            selected: vm.selected == .cloud,
            enabled: vm.canSelectCloud,
            icon: "icloud.fill",
            title: "Back up to iCloud",
            subtitle: vm.iCloudAvailable
                ? "Syncs securely with your other Apple devices."
                : "iCloud is off — turn it on in Settings, or use a backup file.",
            id: "secure-account-option-cloud",
            c: c
        ) {
            vm.selectCloud()
        }
    }

    private func fileRow(c: FSColors) -> some View {
        optionRow(
            selected: vm.selected == .file,
            enabled: true,
            icon: "doc.badge.arrow.up.fill",
            title: "Save a backup file",
            subtitle: "An encrypted .flagshipkey you keep yourself.",
            id: "secure-account-option-file",
            c: c
        ) {
            vm.selectFile()
        }
    }

    private func optionRow(
        selected: Bool,
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
                    .foregroundColor(enabled ? c.primary : c.textMuted)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(FS.font.h4())
                        .foregroundColor(enabled ? c.text : c.textMuted)
                    Text(subtitle)
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .imageScale(.large)
                    .foregroundColor(selected ? c.primary : c.border)
            }
            .padding(FS.space.s4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(c.surface)
            .overlay(
                RoundedRectangle(cornerRadius: FS.radius.md)
                    .stroke(selected ? c.primary : c.border, lineWidth: selected ? 2 : 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
            .opacity(enabled ? 1 : 0.6)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityIdentifier(id)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    // MARK: - Actions

    private func onContinue() async {
        cloudError = nil
        switch vm.selected {
        case .cloud:
            await setUpCloudBackup()
        case .file:
            showFileExport = true
        case .none:
            break
        }
    }

    /// Drive the WebAuthn-PRF cloud recovery enrollment for the live UMK.
    /// The UMK already lives in this account's Keystore slot — OpenAccount
    /// pointed `setActiveProfile` at it before generating the UMK — so we
    /// read it back and hand it to RecoveryViewModel.setup.
    private func setUpCloudBackup() async {
        guard let recoveryVm else { return }
        cloudWorking = true
        defer { cloudWorking = false }
        do {
            let umk = try await Keystore.currentUMK(reason: "Back up your Flagship account to iCloud")
            await recoveryVm.setup(umkSeed: umk)
            if case .registered = recoveryVm.phase {
                onSecured()
            } else if case .failed(let msg) = recoveryVm.phase {
                cloudError = msg
            }
        } catch {
            cloudError = "Couldn't back up to iCloud: \(error.localizedDescription)"
        }
    }
}
