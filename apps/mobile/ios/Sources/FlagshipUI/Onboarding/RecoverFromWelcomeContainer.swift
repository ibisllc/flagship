import SwiftUI
import CryptoKit
import FlagshipCore
import FlagshipAPI

/// Hosts the "I already have an account" branch from Welcome.
///
/// Lifecycle:
///   1. form — collect username + recovery passphrase (Task #4).
///   2. .recovering — Argon2id-derive → gated fetch → verify prfSalt →
///      PRF unwrap (RecoveryViewModel.recover(username:passphrase:)).
///   3. .succeeded(seed) — shows PostRecoveryChoiceScreen so the
///      user picks Keep-both / Replace-lost / Wipe.
///   4. .failed(reason) — shows ErrorCard + retry, with a clear
///      hint for the "wrong passphrase / no passkey" cases.
///
/// On choice, the container hands AppState back to OnboardingFlow
/// via the onComplete callback. The actual rotation work for
/// .replaceLostDevice lives in B7; for now we accept the choice and
/// mark the user paired so the rest of the flow doesn't deadlock —
/// a follow-up commit wires the real /re-pair POST.
public struct RecoverFromWelcomeContainer: View {
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.colorScheme) private var scheme

    /// Called after a successful recovery + choice. Caller (Onboarding-
    /// Flow) is responsible for installing the recovered UMK and
    /// flipping AppState.isPaired.
    public var onComplete: (RecoveryChoice, SymmetricKey) -> Void
    public var onBack: () -> Void

    @State private var vm: RecoveryViewModel?
    @State private var recoveredSeed: SymmetricKey?
    @State private var errorMessage: String?
    @State private var username = ""
    @State private var passphrase = ""
    @State private var working = false

    public init(
        onComplete: @escaping (RecoveryChoice, SymmetricKey) -> Void = { _, _ in },
        onBack: @escaping () -> Void = {}
    ) {
        self.onComplete = onComplete
        self.onBack = onBack
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ZStack {
            c.bg.ignoresSafeArea()
            content(c: c)
        }
        .navigationTitle("Recover")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // Platform-backed provider on device; the simulator path falls
            // back to a stable HKDF derivation keyed by the prfSalt.
            if vm == nil {
                vm = RecoveryViewModel(client: server, webAuthn: PlatformWebAuthnProvider())
            }
        }
    }

    @ViewBuilder
    private func content(c: FSColors) -> some View {
        if let seed = recoveredSeed {
            // Wipe-enabled stays false in v1; flipped on in E3.
            PostRecoveryChoiceScreen(
                wipeAndRestartEnabled: false,
                onContinue: { choice in onComplete(choice, seed) }
            )
        } else if working {
            recoveringView(c: c)
        } else if let message = errorMessage {
            failureView(message: message, c: c)
        } else {
            formView(c: c)
        }
    }

    private func formView(c: FSColors) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Spacer().frame(height: FS.space.s6)
                Text("Recover your account")
                    .font(FS.font.h2()).foregroundColor(c.text)
                Text("Enter your account name and recovery passphrase. We'll verify your passkey, fetch your wrapped account key, and bring this device into your existing account.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                TextField("Account name", text: $username)
                    .textContentType(.username)
                    .autocorrectionDisabled(true)
                    .textInputAutocapitalization(.never)
                    .padding(FS.space.s3)
                    .background(c.surface)
                    .overlay(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border))
                    .accessibilityIdentifier("recover-username")
                SecureField("Recovery passphrase", text: $passphrase)
                    .textContentType(.password)
                    .autocorrectionDisabled(true)
                    .textInputAutocapitalization(.never)
                    .padding(FS.space.s3)
                    .background(c.surface)
                    .overlay(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border))
                    .accessibilityIdentifier("recover-passphrase")
                FSPrimaryButton("Recover", block: true, large: true) {
                    Task { await runRecovery() }
                }
                .accessibilityIdentifier("recover-go")
                FSGhostButton("Cancel", block: true, action: onBack)
                Spacer()
            }
            .padding(.horizontal, FS.space.s6)
        }
        .accessibilityIdentifier("recover-form")
    }

    private func recoveringView(c: FSColors) -> some View {
        VStack(spacing: FS.space.s4) {
            Spacer()
            ProgressView()
                .scaleEffect(1.4)
            Text("Hardening your passphrase…")
                .font(FS.font.h3())
                .foregroundColor(c.text)
            Text("This takes a moment. We'll then verify your passkey and fetch your wrapped account key.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, FS.space.s8)
            Spacer()
        }
        .accessibilityIdentifier("recover-recovering")
    }

    private func failureView(message: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Spacer().frame(height: FS.space.s8)
            Text("Couldn't recover account").font(FS.font.h2()).foregroundColor(c.text)
            Text(humanizedError(message))
                .font(FS.font.body())
                .foregroundColor(c.textMuted)
            FSCard {
                HStack(alignment: .top, spacing: FS.space.s2) {
                    Image(systemName: "info.circle.fill").foregroundColor(c.primary)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("What this usually means").font(FS.font.bodySm()).foregroundColor(c.text)
                        Text("Your recovery passkey isn't on this device. If you set up recovery on another device, make sure you're signed into the same iCloud account here — or use a security key. If you've never set up recovery, you'll need to do that on a device that already holds your account.")
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                    }
                }
            }
            Spacer()
            FSPrimaryButton("Try again", block: true, large: true) {
                errorMessage = nil
            }
            FSGhostButton("Back", block: true, action: onBack)
            Spacer().frame(height: FS.space.s8)
        }
        .padding(.horizontal, FS.space.s6)
        .accessibilityIdentifier("recover-failed")
    }

    private func runRecovery() async {
        guard let vm else { return }
        working = true
        defer { working = false }
        let seed = await vm.recover(username: username, passphrase: passphrase)
        if let seed {
            recoveredSeed = seed
            errorMessage = nil
        } else if case .failed(let msg) = vm.phase {
            errorMessage = msg
        } else {
            errorMessage = "Recovery cancelled or unavailable."
        }
    }

    private func humanizedError(_ raw: String) -> String {
        // Surface the most common cases in plain language; otherwise pass
        // through the underlying message. RecoveryViewModel uses
        // error.localizedDescription for everything, so we substring-match.
        let lower = raw.lowercased()
        if lower.contains("wrong passphrase") || lower.contains("invalid fetch token") {
            return "That passphrase didn't match. Check it and try again."
        }
        if lower.contains("not allowed") || lower.contains("no credentials")
            || lower.contains("nomatchingcredential") || lower.contains("interrupted")
        {
            return "We couldn't find a recovery passkey on this device."
        }
        if lower.contains("no cloud recovery") {
            return "No cloud recovery is set up for that account name."
        }
        return raw
    }
}
