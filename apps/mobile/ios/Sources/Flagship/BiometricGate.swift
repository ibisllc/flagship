import Foundation
#if !os(watchOS)
import LocalAuthentication
#endif

public struct BiometricGate {
    public enum GateError: Error {
        case notAvailable
        case userCancelled
        case underlying(Error)
    }

    public init() {}

    public func evaluate(reason: String) async throws {
        #if os(watchOS)
        // LAPolicy.deviceOwnerAuthenticationWithBiometrics is unavailable
        // on watchOS — the Watch app doesn't call this surface today
        // (biometric-gated actions are iPhone-only), but the SPM target
        // this file lives in gets pulled into the watchOS build pass
        // when FlagshipApp embeds FlagshipWatchApp. Returning
        // .notAvailable keeps the API shape consistent so any future
        // watch-side caller fails the same way Touch ID-less devices do.
        _ = reason
        throw GateError.notAvailable
        #else
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
        #endif
    }
}
