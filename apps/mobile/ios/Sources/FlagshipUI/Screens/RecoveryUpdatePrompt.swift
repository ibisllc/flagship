import SwiftUI
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// SEC-REPAIR-001: a recovery record from before `.com` checked the passkey is released on the
/// passphrase alone. The app asks ONCE per account on this device to update it (one passkey sheet);
/// declining keeps everything working and leaves a quiet row in Settings.
@MainActor
public enum RecoveryUpdatePrompt {
    public static let title = String(localized: "Update your account recovery")
    public static let body = String(localized: "Account recovery can now also check your passkey, so your passphrase alone can't download your recovery copy. Enter your recovery passphrase, then confirm with your passkey once.")
    public static let update = String(localized: "Update")
    public static let notNow = String(localized: "Not now")
    public static let updated = String(localized: "Account recovery updated.")
    public static let settingsRow = String(localized: "Update account recovery")

    /// Where the "already asked" flags live (tests swap it).
    public static var store: UserDefaults = .standard
    private static func key(_ username: String) -> String { "flagship.recoveryUpdateAsked.\(username.lowercased())" }

    public static func wasAsked(username: String) -> Bool { store.bool(forKey: key(username)) }
    public static func markAsked(username: String) { store.set(true, forKey: key(username)) }

    /// Ask only for a record `.com` says is from before (never for an unknown `.com` answer), once.
    public static func shouldAsk(state: RecoveryRecordState?, username: String?) -> Bool {
        guard let username, !username.isEmpty, let state else { return false }
        return state.needsPasskeyUpdate && !wasAsked(username: username)
    }

    /// The passphrase a recovery on this device just used, kept in memory only, so the update right
    /// after it doesn't ask again.
    private static var held: [String: String] = [:]
    public static func hold(passphrase: String, for username: String) { held[username.lowercased()] = passphrase }
    public static func heldPassphrase(for username: String) -> String? { held[username.lowercased()] }
    public static func forget(_ username: String) { held[username.lowercased()] = nil }
}

/// The passkey provider for recovery screens: the mock in a gym launch, the platform otherwise.
@MainActor
public enum RecoveryWebAuthn {
    public static func provider(username: String?) -> any WebAuthnProvider {
        #if DEBUG
        if GymLaunch.usesMocks { return MockWebAuthnProvider() }
        #endif
        return PlatformWebAuthnProvider(username: username)
    }
}

/// Runs the update: re-enrols recovery with a new passkey whose public key `.com` keeps.
@Observable
@MainActor
public final class RecoveryUpdateViewModel {
    public enum Phase: Equatable { case ask, working, done, failed(String) }
    public private(set) var phase: Phase = .ask
    public var passphrase = ""
    public var passphrase2 = ""
    public let username: String
    /// True when a recovery just ran on this device: its passphrase is used, no fields shown.
    public let holdsPassphrase: Bool

    private let client: any FlagshipServerClient
    private let webAuthn: any WebAuthnProvider
    private let loadUMK: @MainActor () async throws -> SymmetricKey

    public init(username: String, client: any FlagshipServerClient, webAuthn: any WebAuthnProvider,
                loadUMK: @escaping @MainActor () async throws -> SymmetricKey = {
                    try await Keystore.currentUMK(reason: String(localized: "Update your account recovery"))
                }) {
        self.username = username
        self.client = client
        self.webAuthn = webAuthn
        self.loadUMK = loadUMK
        holdsPassphrase = RecoveryUpdatePrompt.heldPassphrase(for: username) != nil
    }

    /// The passphrase check before anything runs; nil when it may go.
    public var fieldError: String? {
        if holdsPassphrase { return nil }
        if passphrase.count < 8 { return RecoveryPasskeyCopy.passphraseTooShort }
        if passphrase != passphrase2 { return String(localized: "Passphrases do not match.") }
        return nil
    }

    public func update() async -> Bool {
        if case .working = phase { return false }
        let chosen = RecoveryUpdatePrompt.heldPassphrase(for: username) ?? passphrase
        if !holdsPassphrase, let err = fieldError {
            phase = .failed(err)
            return false
        }
        RecoveryUpdatePrompt.markAsked(username: username)
        phase = .working
        do {
            let umk = try await loadUMK()
            let vm = RecoveryViewModel(client: client, webAuthn: webAuthn, username: { [username] in username })
            await vm.setup(umkSeed: umk, passphrase: chosen)
            switch vm.phase {
            case .registered:
                RecoveryUpdatePrompt.forget(username)
                phase = .done
                return true
            case .failed(let msg):
                phase = .failed(msg)
            default:
                phase = .failed(String(localized: "Nothing was changed."))
            }
        } catch {
            phase = .failed(UserErrorText.of(error))
        }
        return false
    }

    public func decline() {
        RecoveryUpdatePrompt.markAsked(username: username)
        RecoveryUpdatePrompt.forget(username)
    }
}

/// "Update your account recovery": Update (one passkey sheet) or Not now.
public struct RecoveryUpdateSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @Bindable var vm: RecoveryUpdateViewModel
    var onUpdated: () -> Void

    public init(vm: RecoveryUpdateViewModel, onUpdated: @escaping () -> Void) {
        self.vm = vm
        self.onUpdated = onUpdated
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Image(systemName: "person.badge.key").font(FS.font.scaled(34)).foregroundColor(c.accent)
                Text(RecoveryUpdatePrompt.title)
                    .font(FS.font.h3()).foregroundColor(c.text)
                    .accessibilityIdentifier("recovery-update-title")
                Text(RecoveryUpdatePrompt.body)
                    .font(FS.font.body()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("recovery-update-body")
                if !vm.holdsPassphrase {
                    SecureField(String(localized: "Recovery passphrase"), text: $vm.passphrase)
                        .textContentType(.password)
                        .autocorrectionDisabled(true)
                        .textInputAutocapitalization(.never)
                        .fsInputBox()
                        .accessibilityIdentifier("recovery-update-passphrase")
                    SecureField(String(localized: "Re-enter passphrase"), text: $vm.passphrase2)
                        .textContentType(.password)
                        .autocorrectionDisabled(true)
                        .textInputAutocapitalization(.never)
                        .fsInputBox()
                        .accessibilityIdentifier("recovery-update-passphrase-2")
                    Text(RecoveryPasskeyCopy.passphraseHint)
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("recovery-update-hint")
                }
                if case .failed(let msg) = vm.phase {
                    Text(msg).font(FS.font.bodySm()).foregroundColor(c.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("recovery-update-error")
                }
                FSPrimaryButton(vm.phase == .working ? String(localized: "Updating…") : RecoveryUpdatePrompt.update,
                                enabled: vm.phase != .working, block: true) {
                    Task {
                        if await vm.update() {
                            onUpdated()
                            dismiss()
                        }
                    }
                }
                .accessibilityIdentifier("recovery-update-confirm")
                FSGhostButton(RecoveryUpdatePrompt.notNow, block: true) {
                    vm.decline()
                    dismiss()
                }
                .disabled(vm.phase == .working)
                .accessibilityIdentifier("recovery-update-not-now")
            }
            .padding(FS.space.s6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(c.bg.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(vm.phase == .working)
        // Asked once: swiping it away counts as Not now.
        .onAppear { RecoveryUpdatePrompt.markAsked(username: vm.username) }
    }
}
