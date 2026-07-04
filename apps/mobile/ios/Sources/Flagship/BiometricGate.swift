import Foundation
import LocalAuthentication
import FlagshipCore

public struct BiometricGate {
    public enum GateError: Error {
        case notAvailable
        case userCancelled
        case underlying(Error)
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
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            throw GateError.notAvailable
        }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: reason
            ) { success, evalError in
                if success {
                    cont.resume()
                } else if let evalError = evalError {
                    cont.resume(throwing: GateError.underlying(evalError))
                } else {
                    cont.resume(throwing: GateError.userCancelled)
                }
            }
        }
    }
}
