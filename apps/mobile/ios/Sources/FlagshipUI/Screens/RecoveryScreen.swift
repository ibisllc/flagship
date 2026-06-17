import SwiftUI
import CryptoKit
import Flagship
import FlagshipCore

/// Settings → Recovery setup. Walks the user through registering a
/// passkey on flagshipserver.com + uploading a wrapped UMK envelope.
public struct RecoveryScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: RecoveryViewModel
    /// Receives the recovery PASSPHRASE the user typed (Task #4 — entered
    /// twice + validated here before enroll).
    var onRunSetup: (String) async -> Void = { _ in }
    /// Receives the recovery PASSPHRASE for the restore path.
    var onRunRecover: (String) async -> Void = { _ in }
    var onShowReattachProgress: () -> Void = {}

    @State private var enrollPassphrase = ""
    @State private var enrollPassphrase2 = ""
    @State private var recoverPassphrase = ""
    @State private var localError: String?

    public init(
        vm: RecoveryViewModel,
        onRunSetup: @escaping (String) async -> Void = { _ in },
        onRunRecover: @escaping (String) async -> Void = { _ in },
        onShowReattachProgress: @escaping () -> Void = {}
    ) {
        self.vm = vm
        self.onRunSetup = onRunSetup
        self.onRunRecover = onRunRecover
        self.onShowReattachProgress = onShowReattachProgress
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Recover on a new device").font(FS.font.h2()).foregroundColor(c.text)
                Text("Your account's master key lives only on this device. Set up recovery now so you can get back in fast and safely if you lose it. We keep a copy locked away in the cloud — unlockable only with your passkey (synced through iCloud) and a recovery passphrase you choose. We can't open it, and we can't reset your passphrase. With recovery, you install Flagship on a new device, sign in, enter your passphrase, and you're back in. Without it you can still get back in, but only the slow way: a single-device account can be claimed from a new device after a 3-day wait — and because that same path lets anyone who knows your username start a claim, you'll want recovery's instant, private route instead.")
                    .font(FS.font.body()).foregroundColor(c.textMuted)

                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        Text("CLOUD RECOVERY").font(.system(size: 12, weight: .semibold)).tracking(1).foregroundColor(c.textMuted)
                        switch vm.phase {
                        case .idle:
                            Text("Recovery isn't set up yet.").foregroundColor(c.text)
                            Text("Pick a passphrase (8+ characters) — treat it like a password and write it down somewhere safe. You'll need it, plus your passkey, to get back in on a new device. We can't reset it.")
                                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                            SecureField("Recovery passphrase", text: $enrollPassphrase)
                                .textContentType(.newPassword)
                                .autocorrectionDisabled(true)
                                .textInputAutocapitalization(.never)
                                .padding(FS.space.s3)
                                .background(c.surface)
                                .overlay(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border))
                                .accessibilityIdentifier("recovery-enroll-passphrase")
                            SecureField("Re-enter passphrase", text: $enrollPassphrase2)
                                .textContentType(.newPassword)
                                .autocorrectionDisabled(true)
                                .textInputAutocapitalization(.never)
                                .padding(FS.space.s3)
                                .background(c.surface)
                                .overlay(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border))
                                .accessibilityIdentifier("recovery-enroll-passphrase-2")
                            if let localError {
                                Text(localError).font(FS.font.caption()).foregroundColor(c.danger)
                            }
                            FSPrimaryButton("Set up recovery", block: true) {
                                guard validateEnroll() else { return }
                                let pp = enrollPassphrase
                                Task { await onRunSetup(pp) }
                            }
                            .accessibilityIdentifier("recovery-enroll-go")
                        case .settingUp:
                            HStack { ProgressView(); Text("Registering passkey…").foregroundColor(c.textMuted) }
                        case .registered(let credId):
                            HStack(spacing: FS.space.s2) {
                                Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                                Text("Recovery active").foregroundColor(c.text)
                            }
                            Text("Passkey: \(credId)").font(FS.font.mono()).foregroundColor(c.textMuted).lineLimit(1).truncationMode(.middle)
                            Text("If you lose this device, install Flagship on a new one, choose \"I already have an account,\" and recover with your passphrase.").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        case .recovering:
                            HStack { ProgressView(); Text("Verifying passkey…").foregroundColor(c.textMuted) }
                        case .recovered:
                            HStack(spacing: FS.space.s2) {
                                Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                                Text("UMK recovered. Re-pair your servers.").foregroundColor(c.text)
                            }
                        case .failed(let msg):
                            ErrorCard(message: msg)
                            FSGhostButton("Try again", block: true) { vm.phase = .idle }
                        }
                    }
                }

                FSCard {
                    HStack(alignment: .top, spacing: FS.space.s2) {
                        Image(systemName: "info.circle.fill").foregroundColor(c.primary)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("How this works").font(FS.font.bodySm()).foregroundColor(c.text)
                            Text("Your passkey turns your passphrase into a key that only you can produce. We use it to lock a copy of your account key and store that locked copy on our servers. We never see the key inside — only your passkey can unlock it.")
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                        }
                    }
                }

                Button(action: onShowReattachProgress) {
                    FSCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Re-attach progress").foregroundColor(c.text)
                                Text("See per-app re-anchoring after a recovery.")
                                    .font(FS.font.bodySm())
                                    .foregroundColor(c.textMuted)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Recovery")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Mirror recovery.js enroll validation: 8+ chars and the two entries
    /// must match. Surfaces the error inline without leaving `.idle`.
    private func validateEnroll() -> Bool {
        if enrollPassphrase.count < 8 {
            localError = "Passphrase must be 8+ characters."
            return false
        }
        if enrollPassphrase != enrollPassphrase2 {
            localError = "Passphrases do not match."
            return false
        }
        localError = nil
        return true
    }
}
