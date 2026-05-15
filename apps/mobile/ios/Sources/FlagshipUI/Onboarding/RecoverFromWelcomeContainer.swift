import SwiftUI
import CryptoKit
import FlagshipCore
import FlagshipAPI

/// Hosts the "I already have an account" branch from Welcome.
///
/// Lifecycle:
///   1. .recovering — fires RecoveryViewModel.recover() on .task.
///   2. .succeeded(seed) — shows PostRecoveryChoiceScreen so the
///      user picks Keep-both / Replace-lost / Wipe.
///   3. .failed(reason) — shows ErrorCard + retry, with a clear
///      hint for the "no passkey on this device" case (the most
///      common cause: user is on a fresh phone with a different
///      Apple ID, or has iCloud Keychain disabled).
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
            if vm == nil { vm = RecoveryViewModel(client: server) }
            await runRecoveryIfNeeded()
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
        } else if let message = errorMessage {
            failureView(message: message, c: c)
        } else {
            recoveringView(c: c)
        }
    }

    private func recoveringView(c: FSColors) -> some View {
        VStack(spacing: FS.space.s4) {
            Spacer()
            ProgressView()
                .scaleEffect(1.4)
            Text("Authenticate with your passkey")
                .font(FS.font.h3())
                .foregroundColor(c.text)
            Text("We'll fetch your wrapped account key and bring this device into your existing Flagship account.")
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, FS.space.s8)
            Spacer()
            FSGhostButton("Cancel", block: true, action: onBack)
                .padding(.horizontal, FS.space.s6)
                .padding(.bottom, FS.space.s6)
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
                Task { await runRecoveryIfNeeded(force: true) }
            }
            FSGhostButton("Back", block: true, action: onBack)
            Spacer().frame(height: FS.space.s8)
        }
        .padding(.horizontal, FS.space.s6)
        .accessibilityIdentifier("recover-failed")
    }

    private func runRecoveryIfNeeded(force: Bool = false) async {
        guard let vm else { return }
        if !force && recoveredSeed != nil { return }
        let seed = await vm.recover()
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
        // Surface the most common case (no credentials on this device)
        // in plain language; otherwise pass through the underlying
        // message. RecoveryViewModel uses error.localizedDescription
        // for everything, so we substring-match.
        let lower = raw.lowercased()
        if lower.contains("not allowed") || lower.contains("no credentials")
            || lower.contains("nomatchingcredential") || lower.contains("interrupted")
        {
            return "We couldn't find a recovery passkey on this device."
        }
        return raw
    }
}
