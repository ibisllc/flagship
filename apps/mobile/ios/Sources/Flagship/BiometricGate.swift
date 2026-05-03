import Foundation
import LocalAuthentication

public struct BiometricGate {
    public enum GateError: Error {
        case notAvailable
        case userCancelled
        case underlying(Error)
    }

    public init() {}

    public func evaluate(reason: String) async throws {
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
