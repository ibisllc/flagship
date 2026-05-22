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
        }
        .onChange(of: completedUsername) { _, username in
            if let username { onComplete(username) }
        }
    }

    private var completedUsername: String? {
        if case .completed(let username, _) = vm?.phase { return username }
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
        FSGhostButton("Back", block: true, action: onBack)
    }

    // MARK: - Takeover (single 7-day / multi 24h)

    @ViewBuilder
    private func takeover(vm: RealAccountLoginViewModel, multi: Bool, c: FSColors) -> some View {
        @Bindable var vm = vm

        if case .working = vm.phase {
            workingView(c: c)
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
