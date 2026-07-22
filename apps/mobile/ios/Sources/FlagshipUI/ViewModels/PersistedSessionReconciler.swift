import FlagshipAPI

/// Validates a Keychain-restored profile against the account directory before
/// the app presents its biometric lock. A missing account is authoritative and
/// clears the orphaned local identity; a transport/server failure is not, so
/// offline access keeps working.
@MainActor
public enum PersistedSessionReconciler {
    public enum Outcome: Equatable, Sendable {
        case restored
        case removed
        case restoredOffline
    }

    public static func reconcile(
        username: String,
        server: any FlagshipServerClient,
        restore: @MainActor (String) -> Void,
        wipe: @MainActor () -> Void
    ) async -> Outcome {
        do {
            let resolution = try await server.resolveAccount(username: username)
            guard resolution.exists else {
                wipe()
                return .removed
            }
            restore(username)
            return .restored
        } catch {
            restore(username)
            return .restoredOffline
        }
    }
}
