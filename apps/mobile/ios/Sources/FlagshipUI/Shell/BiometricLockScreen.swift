import SwiftUI
import Flagship
import LocalAuthentication
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
///   - User cancels, or the system ends the prompt → no message; the
///     Unlock button stays.
///   - No device screen lock → explains it next to the Sign out escape.
///   - Anything else → one plain sentence (`message(for:)`).
struct BiometricLockScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var scenePhase
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
                Text("Unlock to continue.")
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
                    status == .authenticating ? "Authenticating…" : "Unlock",
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
        .accessibilityAddTraits(.isModal)
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
                : "You have no cloud recovery set up. Erasing this device's key with no backup means there's no way to sign back in — your account access is lost for good.")
        }
        // Auto-prompt once the app is in front — pattern most password-manager
        // apps follow — EXCEPT when the user reached this screen by tapping
        // "Lock" in Settings. A deliberate lock that instantly auto-unlocks
        // itself is pointless, so in that case we wait for an explicit tap.
        // The screen mounts while the app is still launching or already in
        // the background (the relock on `.background`), where LocalAuthentication
        // refuses to prompt; waiting for `.active` is what keeps that refusal
        // from showing up as an error before anyone was asked anything.
        .task(id: scenePhase) {
            await autoUnlockIfReady()
        }
    }

    private func autoUnlockIfReady() async {
        guard scenePhase == .active, !attemptedAuto, !app.awaitingManualUnlock,
              status != .authenticating else { return }
        attemptedAuto = true
        await tryUnlock()
    }

    /// What the lock screen says after an attempt; nil says nothing.
    static func message(for error: Error) -> String? {
        let gate = BiometricGate.GateError.from(error)
        switch gate {
        case .userCancelled, .interrupted:
            return nil
        case .notAvailable:
            return "No device screen lock is set up. Set one, disable the lock from Settings on another paired device, or sign out and start fresh."
        default:
            return gate.errorDescription
        }
    }

    private func tryUnlock() async {
        status = .authenticating
        do {
            let context = try await BiometricGate().evaluateReturningContext(reason: "Unlock Flagship")
            // The same unlock opens the account keys for this session, so a
            // status read token mints without a second prompt
            // (docs/account-read-token.md). Demo accounts hold no keys.
            if !app.isDemoAccount { Keystore.cacheSessionUMK(authenticatedBy: context) }
            app.markUnlocked()
            status = .idle
        } catch {
            // A prompt the system ended because the app left the foreground
            // gets one more automatic try the next time it comes back.
            if BiometricGate.GateError.from(error) == .interrupted, scenePhase != .active {
                attemptedAuto = false
            }
            status = Self.message(for: error).map(Status.failed) ?? .idle
        }
    }
}
