import SwiftUI
import CryptoKit
import Flagship

/// Settings → Recovery setup. Walks the user through registering a
/// passkey on flagshipserver.com + uploading a wrapped UMK envelope.
public struct RecoveryScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: RecoveryViewModel
    var onRunSetup: () async -> Void = {}
    var onRunRecover: () async -> Void = {}

    public init(
        vm: RecoveryViewModel,
        onRunSetup: @escaping () async -> Void = {},
        onRunRecover: @escaping () async -> Void = {}
    ) {
        self.vm = vm
        self.onRunSetup = onRunSetup
        self.onRunRecover = onRunRecover
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("If you lose this phone").font(FS.font.h2()).foregroundColor(c.text)
                Text("Your User Master Key (UMK) is what owns your account. We can wrap a copy under a key derived from a passkey — only you can unlock it with Face ID / Touch ID / security key.")
                    .font(FS.font.body()).foregroundColor(c.textMuted)

                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        Text("CLOUD RECOVERY (WebAuthn-PRF)").font(.system(size: 12, weight: .semibold)).tracking(1).foregroundColor(c.textMuted)
                        switch vm.phase {
                        case .idle:
                            Text("No recovery envelope on file yet.").foregroundColor(c.text)
                            FSPrimaryButton("Set up recovery", block: true) { Task { await onRunSetup() } }
                        case .settingUp:
                            HStack { ProgressView(); Text("Registering passkey…").foregroundColor(c.textMuted) }
                        case .registered(let credId):
                            HStack(spacing: FS.space.s2) {
                                Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                                Text("Recovery active").foregroundColor(c.text)
                            }
                            Text("Credential: \(credId)").font(FS.font.mono()).foregroundColor(c.textMuted).lineLimit(1).truncationMode(.middle)
                            Text("If you lose this phone, install Flagship on a new one and pick \"I lost my phone\" on the welcome screen.").font(FS.font.bodySm()).foregroundColor(c.textMuted)
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
                            Text("Your passkey + a salt derive a 32-byte secret via the PRF extension (hmac-secret). We AES-GCM encrypt the UMK with it and store the ciphertext on flagshipserver.com keyed by credentialID. Flagship can't decrypt — only your passkey can.")
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                        }
                    }
                }
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Recovery")
        .navigationBarTitleDisplayMode(.inline)
    }
}
