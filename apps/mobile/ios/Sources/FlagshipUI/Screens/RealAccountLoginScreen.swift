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
                vm = RealAccountLoginViewModel(resolution: resolution, server: server)
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
                        Text("Bring this device into your account using its backup key file. You'll need the file and its passphrase.")
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
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
            takeover(vm: vm, multi: false, c: c)
        case .multiTakeover:
            takeover(vm: vm, multi: true, c: c)
        }
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
            Text("Take over this account")
                .font(FS.font.h2()).foregroundColor(c.text)
            Text(multi
                 ? "Authenticate with your passkey and your recovery code to bring this device into your account. This device takes over after 24 hours."
                 : "Authenticate with your passkey to bring this device into your account. This device will take over after 7 days; your old device is being alerted.")
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
                multi ? "Take over (24-hour grace)" : "Take over (7-day grace)",
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
                    Text(multi ? "24-hour takeover" : "7-day takeover")
                        .font(FS.font.bodySm()).foregroundColor(c.text)
                    Text(multi
                         ? "Your account is multi-device, so taking over needs your second factor on top of your passkey. After a 24-hour grace your other devices are displaced and this device becomes the admin."
                         : "This is a single-device account with no other device to keep. After a 7-day grace your old device is displaced and this device becomes the admin. Your old device is alerted in the meantime.")
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
        Text("Takeover started").font(FS.font.h2()).foregroundColor(c.text)
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
                             ? "The grace period has elapsed — you can take over now."
                             : "This device takes over in \(Self.formatRemaining(remaining)). Your other devices are being alerted and can object until then.")
                            .font(FS.font.bodySm()).foregroundColor(c.text)
                    }
                }
                FSPrimaryButton("Take over now", enabled: elapsed, block: true, large: true) {
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
            Text("Fetching your account key and bringing this device into your Flagship account.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, FS.space.s8)
        .accessibilityIdentifier("login-takeover-working")
    }
}
