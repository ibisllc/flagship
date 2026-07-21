import Foundation
import FlagshipAPI

/// SWK migration hold (docs/server-migration.md invariant 4) — the device-local
/// record that a migration was initiated HERE for a domain. While a hold is
/// live, the SWK deposit for any OTHER pod of this account must first resolve
/// the migration session (`MigrationSwkResolver`): the migration's provisional
/// new pod needs the MIGRATING domain's SWK (`ServerKeys.deriveSwk` DOTS
/// "flagship.swk.v1|<serverId>"), NOT its own name's — a wrong-name SWK
/// poisons the restore. Mirror of the webapp's `flagship.migrationHold.*`
/// localStorage keys; UserDefaults-keyed like `PendingSwkDepositStore`.
public struct MigrationHoldStore {
    private let defaults: UserDefaults
    private static let prefix = "flagship.migrationHold."

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private static func key(_ migratingDomain: String) -> String {
        prefix + migratingDomain.lowercased()
    }

    /// Record at initiate: the NEXT added pod may be this migration's new box.
    public func setHold(for migratingDomain: String) {
        defaults.set(true, forKey: Self.key(migratingDomain))
    }

    /// Clear on aborted / taken-over (the session is terminal).
    public func clearHold(for migratingDomain: String) {
        defaults.removeObject(forKey: Self.key(migratingDomain))
    }

    public func hasHold(for migratingDomain: String) -> Bool {
        defaults.bool(forKey: Self.key(migratingDomain))
    }

    /// Every migrating domain with a live hold (lowercased).
    public func holds() -> [String] {
        defaults.dictionaryRepresentation().keys
            .filter { $0.hasPrefix(Self.prefix) }
            .map { String($0.dropFirst(Self.prefix.count)) }
            .sorted()
    }
}

/// Which serverId should the SWK for a pod derive from? Consulted by the
/// SwkDepositCoordinator BEFORE deriving (the webapp's `migrationSwkServerId`).
public enum MigrationSwkResolution: Equatable, Sendable {
    /// This pod is the migration's attached new box — derive with the
    /// MIGRATING domain as the serverId (the whole point).
    case migratingDomain(String)
    /// A live migration hasn't attached its new box yet (or `.com` is
    /// unreachable) — hold the deposit off; the pending marker stays and the
    /// next reconcile retries.
    case deferDeposit
    /// No migration involvement — derive from the pod's own name.
    case normal
}

public enum MigrationSwkResolver {
    /// `fetchSession` returns nil for "no session" (404) and THROWS on an
    /// unreachable `.com` — the two are conservatively different: no session
    /// clears the hold, unreachable defers (a wrong-name SWK poisons the
    /// restore, a deferred one just retries).
    public static func resolve(
        podDomain: String,
        holds: [String],
        fetchSession: (String) async throws -> MigrationSession?,
        clearHold: (String) -> Void
    ) async -> MigrationSwkResolution {
        let pod = podDomain.lowercased()
        for migrating in holds {
            // The migrating box itself derives normally.
            if migrating == pod { continue }
            let session: MigrationSession?
            do {
                session = try await fetchSession(migrating)
            } catch {
                return .deferDeposit
            }
            guard let session, ServerMigrationTimeline.activePhases.contains(session.phase) else {
                if session == nil || session?.phase == "taken-over" || session?.phase == "aborted" {
                    clearHold(migrating)
                }
                continue
            }
            let attached = session.newServerDomain?.lowercased()
            if attached == pod { return .migratingDomain(migrating) }
            if attached == nil { return .deferDeposit }
            // A different pod is the migration's new box — this one is unrelated.
        }
        return .normal
    }
}
