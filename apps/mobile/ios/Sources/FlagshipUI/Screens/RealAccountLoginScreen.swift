import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Phase 3 — the real single/multi login screen. Hosts
/// `RealAccountLoginViewModel` and renders the branch the preflight
/// resolved to. Replaces the Phase-1 stopgap that pushed the old
/// `RecoverFromWelcomeContainer` passkey container.
///
///   - `.noRecovery`     → a clean STATE (single vs multi copy), NOT a
///                         404/error card. The only action is Back.
///   - `.singleTakeover` → the 7-day-grace explainer + a takeover CTA.
///   - `.multiTakeover`  → a recovery-TOTP / recovery-code field + the
///                         24h-grace explainer + a takeover CTA.
///
/// On a completed takeover the screen calls `onComplete(username:)`; the
/// host installs nothing further (the VM already installed the UMK +
/// initiated the re-pair) and flips AppState to paired with the resolved
/// username + an empty pod list (pods hydrate from /devices later).
public struct RealAccountLoginScreen: View {
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.colorScheme) private var scheme

    public let resolution: AccountResolution
    /// Called when the takeover completes. Carries the resolved
    /// username so the host can `completeOnboarding(username:, pods: [])`.
    public var onComplete: (_ username: String) -> Void
    public var onBack: () -> Void

    @State private var vm: RealAccountLoginViewModel?
    @State private var importVm: KeyfileImportViewModel?
    @State private var showImport = false

    public init(
        resolution: AccountResolution,
        onComplete: @escaping (_ username: String) -> Void = { _ in },
        onBack: @escaping () -> Void = {}
    ) {
        self.resolution = resolution
        self.onComplete = onComplete
        self.onBack = onBack
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Spacer().frame(height: FS.space.s10)
                if let vm {
                    content(vm: vm, c: c)
                }
                Spacer()
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.bottom, FS.space.s8)
        }
        .navigationTitle("Sign in")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if vm == nil {
                // Inject the LIVE passkey provider (platform ASAuthorization on
                // device, HKDF fallback in the Simulator) so single-device
                // recovery can actually reach the user's iCloud-Keychain
                // passkey — the prior default fell back to the mock provider.
                vm = RealAccountLoginViewModel(
                    resolution: resolution,
                    server: server,
                    webAuthn: PlatformWebAuthnProvider()
                )
            }
            if importVm == nil {
                importVm = KeyfileImportViewModel(server: server)
            }
        }
        .onChange(of: finalizedUsername) { _, username in
            if let username { onComplete(username) }
        }
        .sheet(isPresented: $showImport) {
            if let importVm {
                KeyfileImportSheet(
                    vm: importVm,
                    onComplete: { username in
                        showImport = false
                        onComplete(username)
                    }
                )
            }
        }
    }

    /// "Import backup file" entry — offered below the iCloud option on
    /// the recovery screen. Opens the keyfile-import sheet.
    @ViewBuilder
    private func importBackupOption(c: FSColors) -> some View {
        Button(action: { showImport = true }) {
            FSCard {
                HStack(alignment: .top, spacing: FS.space.s2) {
                    Image(systemName: "doc.badge.arrow.up")
                        .foregroundColor(c.primary)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Import backup file")
                            .font(FS.font.bodySm())
                            .foregroundColor(c.text)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("login-import-backup")
    }

    private var finalizedUsername: String? {
        if case .finalized(let username) = vm?.phase { return username }
        return nil
    }

    @ViewBuilder
    private func content(vm: RealAccountLoginViewModel, c: FSColors) -> some View {
        switch vm.branch {
        case .noRecovery(let multi):
            noRecoveryState(multi: multi, c: c)
        case .singleTakeover:
            singleRecovery(vm: vm, c: c)
        case .multiTakeover:
            takeover(vm: vm, multi: true, c: c)
        }
    }

    // MARK: - Single-device recovery (passphrase + passkey → instant)

    /// Recovery rework Phase A. Single-device accounts restore by entering
    /// their recovery passphrase and verifying their passkey: the gated unwrap
    /// hands back the account's own UMK, so once installed this device already
    /// holds the registered identity and pairs immediately — no "takeover", no
    /// grace. (Rotated accounts, where the registered key has since changed,
    /// are the Phase-B re-pair case.)
    @ViewBuilder
    private func singleRecovery(vm: RealAccountLoginViewModel, c: FSColors) -> some View {
        @Bindable var vm = vm

        if case .working = vm.phase {
            workingView(c: c)
        } else if case .finalized = vm.phase {
            workingView(c: c)
        } else if case .needsSecondFactor(let error) = vm.phase {
            // #52 — the cloud requires the account's enrolled second
            // factor before the Phase-B grace can start. Same field +
            // copy as the multi branch.
            secondFactorEntry(vm: vm, error: error, c: c)
        } else if case .completed(_, let completesAt) = vm.phase {
            // Phase B — the registered key rotated since the recovery
            // envelope was written, so the instant path doesn't apply;
            // this device re-pairs against the live key behind a grace
            // window. (The common Phase-A path finalizes immediately and
            // never reaches here.)
            graceCountdownView(completesAt: completesAt, vm: vm, c: c)
        } else {
            Text("Welcome back")
                .font(FS.font.h2()).foregroundColor(c.text)
            Text("Enter your recovery passphrase and verify your passkey to restore access on this device.")
                .font(FS.font.body())
                .foregroundColor(c.textMuted)

            SecureField("Recovery passphrase", text: $vm.passphraseInput)
                .textContentType(.password)
                .autocorrectionDisabled(true)
                .textInputAutocapitalization(.never)
                .padding(FS.space.s3)
                .background(c.surface)
                .overlay(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border))
                .accessibilityIdentifier("login-recovery-passphrase")

            if case .failed(let msg) = vm.phase {
                Text(msg)
                    .font(FS.font.bodySm())
                    .foregroundColor(c.danger)
                    .accessibilityIdentifier("login-takeover-error")
            }

            FSPrimaryButton(
                "Restore access",
                enabled: vm.passphraseInput.count >= 8,
                block: true,
                large: true
            ) {
                Task { await vm.startTakeover() }
            }
            .accessibilityIdentifier("login-takeover-continue")

            importBackupOption(c: c)

            FSGhostButton("Back", block: true, action: onBack)
        }
    }

    // MARK: - #52 — single-device second factor (cloud-required)

    /// The cloud 401'd the single-device Phase-B initiate because the
    /// account has a second factor enrolled. Reuses the multi branch's
    /// field + copy; submission retries the initiate with the proof.
    @ViewBuilder
    private func secondFactorEntry(vm: RealAccountLoginViewModel, error: String?, c: FSColors) -> some View {
        @Bindable var vm = vm

        Text("One more step")
            .font(FS.font.h2()).foregroundColor(c.text)
        Text("This account has a second factor enrolled. Enter the 6-digit code from your authenticator app, or one of your recovery codes, to continue restoring access.")
            .font(FS.font.body())
            .foregroundColor(c.textMuted)

        FSField(
            value: $vm.secondFactorInput,
            label: "Recovery code or authenticator code",
            placeholder: "123456 or ABCD-EFGH-IJ",
            helper: "6-digit code from your authenticator app, or one of your recovery codes.",
            keyboard: .asciiCapable
        )
        .accessibilityIdentifier("login-second-factor")

        if let error {
            Text(error)
                .font(FS.font.bodySm())
                .foregroundColor(c.danger)
                .accessibilityIdentifier("login-takeover-error")
        }

        FSPrimaryButton(
            "Continue",
            enabled: !vm.secondFactorInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            block: true,
            large: true
        ) {
            Task { await vm.submitSingleDeviceSecondFactor() }
        }
        .accessibilityIdentifier("login-second-factor-continue")

        FSGhostButton("Back", block: true, action: onBack)
    }

    // MARK: - No-recovery STATE (never a 404)

    @ViewBuilder
    private func noRecoveryState(multi: Bool, c: FSColors) -> some View {
        Text("No cloud backup on this account")
            .font(FS.font.h2()).foregroundColor(c.text)
        FSCard {
            HStack(alignment: .top, spacing: FS.space.s2) {
                Image(systemName: "icloud.slash")
                    .foregroundColor(c.textMuted)
                VStack(alignment: .leading, spacing: 4) {
                    Text(multi
                         ? "Use another device, or one of your recovery codes."
                         : "No cloud backup on this account. Use a device that still has access.")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.text)
                    Text(multi
                         ? "This account is multi-device. Sign in on a device that's already paired, or recover with a recovery code from a device that has one."
                         : "Cloud backup is opt-in and this account never enabled it. There's no cloud recovery path — sign in on a device that's still in the account.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                }
            }
        }
        .accessibilityIdentifier("login-no-recovery")
        importBackupOption(c: c)
        FSGhostButton("Back", block: true, action: onBack)
    }

    // MARK: - Takeover (single 7-day / multi 24h)

    @ViewBuilder
    private func takeover(vm: RealAccountLoginViewModel, multi: Bool, c: FSColors) -> some View {
        @Bindable var vm = vm

        if case .working = vm.phase {
            workingView(c: c)
        } else if case .finalized = vm.phase {
            workingView(c: c)
        } else if case .completed(_, let completesAt) = vm.phase {
            graceCountdownView(completesAt: completesAt, vm: vm, c: c)
        } else {
            Text("Welcome back")
                .font(FS.font.h2()).foregroundColor(c.text)
            Text(multi
                 ? "Sign in with your recovery passkey and your recovery code to restore access on this device. For your security it becomes active after a 24-hour hold, and your other devices are notified so they can stop it if it wasn't you."
                 : "Sign in with your recovery passkey to restore access on this device. For your security, access becomes active after a 7-day hold — if another device is signed in, it's notified and can stop it if it wasn't you.")
                .font(FS.font.body())
                .foregroundColor(c.textMuted)

            graceCard(multi: multi, c: c)

            if multi {
                FSField(
                    value: $vm.secondFactorInput,
                    label: "Recovery code or authenticator code",
                    placeholder: "123456 or ABCD-EFGH-IJ",
                    helper: "6-digit code from your authenticator app, or one of your recovery codes.",
                    keyboard: .asciiCapable
                )
                .accessibilityIdentifier("login-second-factor")
            }

            if case .failed(let msg) = vm.phase {
                Text(msg)
                    .font(FS.font.bodySm())
                    .foregroundColor(c.danger)
                    .accessibilityIdentifier("login-takeover-error")
            }

            FSPrimaryButton(
                multi ? "Restore access (24-hour hold)" : "Restore access (7-day hold)",
                enabled: multi ? vm.canStartMultiTakeover : true,
                block: true,
                large: true
            ) {
                Task { await vm.startTakeover() }
            }
            .accessibilityIdentifier("login-takeover-continue")

            importBackupOption(c: c)

            FSGhostButton("Back", block: true, action: onBack)
        }
    }

    private func graceCard(multi: Bool, c: FSColors) -> some View {
        FSCard {
            HStack(alignment: .top, spacing: FS.space.s2) {
                Image(systemName: "clock.badge.exclamationmark")
                    .foregroundColor(c.primary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(multi ? "24-hour security hold" : "7-day security hold")
                        .font(FS.font.bodySm()).foregroundColor(c.text)
                    Text(multi
                         ? "Because your account has more than one device, restoring access here needs your recovery code as well as your passkey. After a 24-hour hold this device becomes the primary one; your other devices are notified and can stop it until then."
                         : "This hold is the safety delay for a single-device account: after 7 days, this device has full access. It's what stops anyone else from quietly restoring your account — and if another device is ever signed in, it's alerted throughout and can stop the change.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                }
            }
        }
        .accessibilityIdentifier(multi ? "login-grace-24h" : "login-grace-7d")
    }

    // MARK: - Phase 4 — grace countdown + "Take over now"

    @ViewBuilder
    private func graceCountdownView(completesAt: Int64, vm: RealAccountLoginViewModel, c: FSColors) -> some View {
        Text("Restoring your access").font(FS.font.h2()).foregroundColor(c.text)
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let nowMs = Int64(ctx.date.timeIntervalSince1970 * 1000)
            let remaining = max(0, completesAt - nowMs)
            let elapsed = remaining == 0
            VStack(alignment: .leading, spacing: FS.space.s4) {
                FSCard {
                    HStack(alignment: .top, spacing: FS.space.s2) {
                        Image(systemName: "clock.badge.exclamationmark")
                            .foregroundColor(c.primary)
                        Text(elapsed
                             ? "The security hold is complete — you can finish restoring access now."
                             : "Access becomes active in \(Self.formatRemaining(remaining)). Any other device on your account is notified and can stop it until then.")
                            .font(FS.font.bodySm()).foregroundColor(c.text)
                    }
                }
                FSPrimaryButton("Finish restoring access", enabled: elapsed, block: true, large: true) {
                    Task { await vm.completeTakeover() }
                }
                .accessibilityIdentifier("login-take-over-now")
            }
        }
        .accessibilityIdentifier("login-grace-countdown")
        FSGhostButton("Back", block: true, action: onBack)
    }

    /// `Nd Nh` / `Nh Nm` / `Nm Ns` / `Ns` — coarse, stable countdown copy.
    static func formatRemaining(_ ms: Int64) -> String {
        let s = ms / 1000
        let d = s / 86400, h = (s % 86400) / 3600, m = (s % 3600) / 60, sec = s % 60
        if d > 0 { return "\(d)d \(h)h" }
        if h > 0 { return "\(h)h \(m)m" }
        if m > 0 { return "\(m)m \(sec)s" }
        return "\(sec)s"
    }

    private func workingView(c: FSColors) -> some View {
        VStack(spacing: FS.space.s4) {
            ProgressView().scaleEffect(1.3)
            Text("Authenticating with your passkey…")
                .font(FS.font.h3()).foregroundColor(c.text)
            Text("Fetching your account key and restoring access on this device.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, FS.space.s8)
        .accessibilityIdentifier("login-takeover-working")
    }
}
