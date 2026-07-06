import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// The SWK migration hold (docs/server-migration.md invariant 4): the store
/// lifecycle + the resolver `SwkDepositCoordinator` consults before deriving.
final class MigrationHoldStoreTests: XCTestCase {
    private func freshStore() -> MigrationHoldStore {
        let suite = "flagship.migrationHold.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return MigrationHoldStore(defaults: defaults)
    }

    func test_lifecycle() {
        let store = freshStore()
        let d = "home.harry.flagship.services"
        XCTAssertFalse(store.hasHold(for: d))
        XCTAssertTrue(store.holds().isEmpty)
        store.setHold(for: d)
        XCTAssertTrue(store.hasHold(for: d))
        XCTAssertEqual(store.holds(), [d])
        store.clearHold(for: d)
        XCTAssertFalse(store.hasHold(for: d))
        XCTAssertTrue(store.holds().isEmpty)
    }

    func test_holdsAreLowercasedAndCaseInsensitive() {
        let store = freshStore()
        store.setHold(for: "HOME.Harry.Flagship.Services")
        XCTAssertTrue(store.hasHold(for: "home.harry.flagship.services"))
        XCTAssertEqual(store.holds(), ["home.harry.flagship.services"])
    }
}

final class MigrationSwkResolverTests: XCTestCase {
    private let migrating = "home.alice.flagship.services"
    private let provisional = "attic.alice.flagship.services"

    private func session(phase: String, newServerDomain: String?) -> MigrationSession {
        MigrationSession(
            serverDomain: migrating, phase: phase,
            disposition: "wipe-after-handoff",
            oldStkPubHex: String(repeating: "ab", count: 32),
            newServerDomain: newServerDomain,
            initiatedAt: 1
        )
    }

    private final class ClearedBox { var domains: [String] = [] }

    private func resolve(
        podDomain: String,
        holds: [String]? = nil,
        session: MigrationSession?,
        throwing: Bool = false,
        clearedInto cleared: ClearedBox? = nil
    ) async -> MigrationSwkResolution {
        await MigrationSwkResolver.resolve(
            podDomain: podDomain,
            holds: holds ?? [migrating],
            fetchSession: { _ in
                if throwing { throw ScreensClientError.http(status: 0, message: "offline") }
                return session
            },
            clearHold: { cleared?.domains.append($0) }
        )
    }

    func test_attachedNewBoxDerivesFromMigratingDomain() async {
        let r = await resolve(
            podDomain: provisional,
            session: session(phase: "provisioned", newServerDomain: provisional)
        )
        XCTAssertEqual(r, .migratingDomain(migrating))
    }

    func test_unattachedLiveSessionDefers() async {
        // The migration hasn't attached its new box yet — we cannot tell
        // whether this fresh pod is the provisional one; a wrong-name SWK
        // poisons the restore, so the deposit holds off.
        let r = await resolve(
            podDomain: provisional,
            session: session(phase: "initiated", newServerDomain: nil)
        )
        XCTAssertEqual(r, .deferDeposit)
    }

    func test_unreachableComDefers() async {
        let r = await resolve(podDomain: provisional, session: nil, throwing: true)
        XCTAssertEqual(r, .deferDeposit)
    }

    func test_unrelatedPodDerivesNormally() async {
        // A different pod is the migration's new box — this one is unrelated.
        let r = await resolve(
            podDomain: "shed.alice.flagship.services",
            session: session(phase: "provisioned", newServerDomain: provisional)
        )
        XCTAssertEqual(r, .normal)
    }

    func test_migratingPodItselfDerivesNormally() async {
        var fetched = false
        let r = await MigrationSwkResolver.resolve(
            podDomain: migrating,
            holds: [migrating],
            fetchSession: { _ in fetched = true; return nil },
            clearHold: { _ in }
        )
        XCTAssertEqual(r, .normal)
        XCTAssertFalse(fetched, "the migrating box itself never resolves a session")
    }

    func test_terminalSessionClearsHoldAndDerivesNormally() async {
        for terminal in ["taken-over", "aborted"] {
            let cleared = ClearedBox()
            let r = await resolve(
                podDomain: provisional,
                session: session(phase: terminal, newServerDomain: provisional),
                clearedInto: cleared
            )
            XCTAssertEqual(r, .normal, "phase \(terminal)")
            XCTAssertEqual(cleared.domains, [migrating], "phase \(terminal) clears the hold")
        }
    }

    func test_goneSessionClearsHold() async {
        let cleared = ClearedBox()
        let r = await resolve(podDomain: provisional, session: nil, clearedInto: cleared)
        XCTAssertEqual(r, .normal)
        XCTAssertEqual(cleared.domains, [migrating])
    }

    func test_noHoldsIsNormalWithoutFetching() async {
        var fetched = false
        let r = await MigrationSwkResolver.resolve(
            podDomain: provisional,
            holds: [],
            fetchSession: { _ in fetched = true; return nil },
            clearHold: { _ in }
        )
        XCTAssertEqual(r, .normal)
        XCTAssertFalse(fetched)
    }
}
