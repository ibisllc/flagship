import Foundation
import Flagship
import FlagshipCore

/// Face ID or the device passcode before an action that erases this device's
/// account key from a screen that sits above the app lock. A deleted app
/// leaves that key in the Keychain, so these are the only ways a person
/// holding the phone could destroy it without passing the lock.
enum DestructiveAuth {
    enum Outcome: Equatable {
        case allowed
        /// The person dismissed the prompt: say nothing.
        case declined
        case failed(String)
    }

    /// A phone with no screen lock has nothing to ask with, and the
    /// destructive action is then the only way off the screen: allowed.
    static func ask(reason: String) async -> Outcome {
        do {
            try await BiometricGate().evaluate(reason: reason)
            return .allowed
        } catch {
            if BiometricGate.GateError.from(error) == .notAvailable { return .allowed }
            return BiometricLockScreen.message(for: error).map(Outcome.failed) ?? .declined
        }
    }

    /// Delete = forget for a voi.ci conversation (docs/voici-calls.md "Deleting a conversation"): it goes from every
    /// device of the account, so Face ID, Touch ID or the device passcode first. Nil when allowed, else the sentence
    /// to show; nothing may be deleted or sent unless it is nil. A phone with no screen lock has nothing to ask with
    /// and deletes, as `ask` allows.
    static func askToDeleteConversation() async -> String? {
        switch await ask(reason: String(localized: "Delete this conversation")) {
        case .allowed: return nil
        case .declined: return String(localized: "The conversation wasn't deleted.")
        case .failed(let why): return why
        }
    }

    /// The account is already open this session, so the person passed the lock.
    @MainActor
    static func accountUnlocked(_ app: AppState) -> Bool {
        #if DEBUG
        if GymSeams.refuseBiometricGates { return false }
        // The mock gym has no enrolled biometric: its consent prompts are bypassed.
        if GymSeams.bypassBiometricGates { return true }
        #endif
        return app.isDemoAccount || Keystore.hasSessionKey()
    }
}
