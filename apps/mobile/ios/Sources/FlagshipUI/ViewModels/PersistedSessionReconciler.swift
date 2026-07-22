import FlagshipAPI

/// Restores a Keychain-backed identity locally, then observes whether the
/// account directory still lists it. Directory state is informational only:
/// neither a missing-account response nor a server failure may revoke the
/// phone's identity, erase its keys, or prevent offline access.
@MainActor
public enum PersistedSessionReconciler {
    public enum Outcome: Equatable, Sendable {
        case restored
        case missing
        case restoredOffline
    }

    public static func reconcile(
        username: String,
        server: any FlagshipServerClient,
        restore: @MainActor (String) -> Void
    ) async -> Outcome {
        // The local keystore is authoritative for local access. Restore before
        // making any network request so `.com` can never become a launch gate.
        restore(username)

        do {
            let resolution = try await server.resolveAccount(username: username)
            return resolution.exists ? .restored : .missing
        } catch {
            return .restoredOffline
        }
    }
}
