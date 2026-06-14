import SwiftUI
import Flagship
import FlagshipCore

/// B12 — full-screen overlay shown when `AppState.requireBiometricAtLaunch`
/// is on and the runtime `isUnlocked` latch is false. Renders a centered
/// brand mark + Face ID button; tapping fires `BiometricGate.evaluate`
/// and on success flips the latch via `AppState.markUnlocked`.
///
/// The view itself doesn't read or write the user preference — that's
/// owned by Settings. This is purely the lock surface.
///
/// Failure modes:
///   - User cancels → stays on lock screen with a "Try again" button.
///   - Biometric not available on device → falls back to a "Sign out
///     of Flagship to continue" affordance (no useful auth path forward
///     from a phone with broken biometrics + Face ID-required setting).
struct BiometricLockScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    @State private var status: Status = .idle
    @State private var attemptedAuto = false
    @State private var showStartOver = false

    enum Status: Equatable {
        case idle
        case authenticating
        case failed(String)
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        ZStack {
            c.bg.ignoresSafeArea()
            VStack(spacing: FS.space.s6) {
                Spacer()
                Image(systemName: "lock.fill")
                    .font(.system(size: 64, weight: .medium))
                    .foregroundColor(c.primary)
                Text("Flagship is locked")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(c.text)
                Text("Unlock with Face ID to continue.")
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                Spacer()
                if case let .failed(msg) = status {
                    Text(msg)
                        .font(FS.font.caption())
                        .foregroundColor(c.danger)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, FS.space.s6)
                }
                FSPrimaryButton(
                    status == .authenticating ? "Authenticating…" : "Unlock with Face ID",
                    enabled: status != .authenticating,
                    block: true,
                    large: true,
                ) {
                    Task { await tryUnlock() }
                }
                .padding(.horizontal, FS.space.s6)
                // Always-present escape so a stale Keychain identity (which
                // survives an app delete+reinstall) or broken/absent biometrics
                // can never trap the user on this screen with no way forward.
                // This is a genuine Tier-2 SIGN OUT — it erases this device's
                // local key material from the Keychain (every profile, since
                // the locked user can't pick one) and drops to Welcome. Like
                // the Settings sign-out it's snoop-hardening, not eviction:
                // the same key comes back via passkey recovery (instant
                // re-pair, no rotation). Confirm copy adapts on cloud recovery.
                Button("Sign out") { showStartOver = true }
                    .font(FS.font.bodySm())
                    .foregroundColor(c.textMuted)
                    .padding(.bottom, FS.space.s10)
                    .accessibilityIdentifier("lock-sign-out-btn")
            }
        }
        .accessibilityIdentifier("biometric-lock-screen")
        .confirmationDialog(
            app.hasCloudRecovery ? "Sign out of this device?" : "Sign out without recovery?",
            isPresented: $showStartOver,
            titleVisibility: .visible
        ) {
            Button(
                app.hasCloudRecovery ? "Sign out" : "Sign out anyway",
                role: .destructive
            ) {
                // Tier-2 sign out from the lock screen: erase ALL Keychain
                // profiles (the locked user can't choose one) — the wrapped
                // UMK / IRK that survive an app reinstall — then drop to
                // Welcome. No server-side revoke; the same key returns via
                // passkey recovery.
                Keystore.wipeAllProfiles()
                app.signOut()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(app.hasCloudRecovery
                ? "This erases this device's account key from the Keychain and returns you to the start. Sign back in with your recovery passkey to restore it — your account and servers stay put."
                : "⚠️ You have NO cloud recovery enrolled. Erasing this device's key with no backup means there's no way to sign back in — your account access is lost for good.")
        }
        // Auto-prompt on first appearance — pattern most password-manager
        // apps follow — EXCEPT when the user reached this screen by tapping
        // "Lock" in Settings. A deliberate lock that instantly auto-unlocks
        // itself is pointless, so in that case we wait for an explicit tap.
        // Launch + return-from-background still auto-prompt. Subsequent failures
        // also require an explicit tap so we don't infinite-loop on "User
        // cancelled" if the user genuinely wants to back out and force-quit.
        .task {
            if !attemptedAuto {
                attemptedAuto = true
                if !app.awaitingManualUnlock {
                    await tryUnlock()
                }
            }
        }
    }

    private func tryUnlock() async {
        status = .authenticating
        do {
            try await BiometricGate().evaluate(reason: "Unlock Flagship")
            app.markUnlocked()
            status = .idle
        } catch BiometricGate.GateError.notAvailable {
            status = .failed("Face ID isn't set up on this device. Disable the lock from Settings on another paired device, or sign out and start fresh.")
        } catch BiometricGate.GateError.userCancelled {
            status = .failed("Cancelled. Tap above to try again.")
        } catch {
            status = .failed("Couldn't authenticate: \(error.localizedDescription)")
        }
    }
}
