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
                .padding(.bottom, FS.space.s10)
            }
        }
        .accessibilityIdentifier("biometric-lock-screen")
        // Auto-prompt on first appearance — pattern most password-manager
        // apps follow. Subsequent failures require an explicit tap so we
        // don't infinite-loop on "User cancelled" if the user genuinely
        // wants to back out and force-quit.
        .task {
            if !attemptedAuto {
                attemptedAuto = true
                await tryUnlock()
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
