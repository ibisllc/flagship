import Foundation
import LocalAuthentication
import FlagshipCore

public struct BiometricGate {
    /// Why a gate didn't pass. Every case reads as a sentence: the old
    /// `underlying(Error)` payload case surfaced as Swift's bridged
    /// "Flagship.BiometricGate.GateError error 0".
    public enum GateError: Error, Equatable, LocalizedError {
        /// The device has no passcode, so nothing can be evaluated.
        case notAvailable
        /// The person dismissed the prompt.
        case userCancelled
        /// The system or the app ended the prompt, or it couldn't be shown
        /// because the app wasn't in front. Nobody was asked anything.
        case interrupted
        /// Too many failed attempts; the device wants its passcode first.
        case lockedOut
        /// The face, finger or passcode didn't match.
        case failed
        /// Any other LocalAuthentication outcome, by its code.
        case other(code: Int)

        /// Nothing to tell the person: they backed out, or no prompt was shown.
        public var isSilent: Bool {
            self == .userCancelled || self == .interrupted
        }

        public var errorDescription: String? {
            switch self {
            case .notAvailable:
                return "This device has no screen lock set up."
            case .userCancelled:
                return "Unlock was cancelled."
            case .interrupted:
                return "Unlock was interrupted. Try again."
            case .lockedOut:
                return "Too many failed attempts. Unlock your device with its passcode, then try again."
            case .failed:
                return "That didn't match. Try again."
            case .other:
                return "Unlock didn't work. Try again."
            }
        }

        public static func from(_ error: Error) -> GateError {
            if let gate = error as? GateError { return gate }
            let ns = error as NSError
            guard ns.domain == LAErrorDomain else { return .other(code: ns.code) }
            switch LAError.Code(rawValue: ns.code) {
            case .userCancel?, .userFallback?:
                return .userCancelled
            case .appCancel?, .systemCancel?, .notInteractive?:
                return .interrupted
            case .passcodeNotSet?, .biometryNotAvailable?, .biometryNotEnrolled?:
                return .notAvailable
            case .biometryLockout?:
                return .lockedOut
            case .authenticationFailed?:
                return .failed
            default:
                return .other(code: ns.code)
            }
        }
    }

    public init() {}

    public func evaluate(reason: String) async throws {
        // GYM-ONLY (`-smoke-mode` seam): the Simulator has no enrolled
        // biometric, so this UI-consent prompt would make its gated screens
        // unreachable in the no-backend gym. The bypass emits NO crypto —
        // load-bearing ceremonies (keychain unseal / SE ECDH) still require
        // the real thing. Production never sets the flag.
        if GymSeams.bypassBiometricGates { return }
        let context = LAContext()
        var error: NSError?
        // `.deviceOwnerAuthentication` = biometrics OR the device passcode, so a
        // device with a passcode but no enrolled biometric still passes the gate
        // (parity with Android's BIOMETRIC_STRONG|DEVICE_CREDENTIAL).
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            let mapped = error.map { GateError.from($0) }
            throw mapped == .lockedOut ? GateError.lockedOut : GateError.notAvailable
        }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: reason
            ) { success, evalError in
                if success {
                    cont.resume()
                } else if let evalError = evalError {
                    cont.resume(throwing: GateError.from(evalError))
                } else {
                    cont.resume(throwing: GateError.userCancelled)
                }
            }
        }
    }
}
