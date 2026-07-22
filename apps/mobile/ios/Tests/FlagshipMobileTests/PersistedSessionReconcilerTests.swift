import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

@MainActor
final class PersistedSessionReconcilerTests: XCTestCase {
    func test_missingAccount_wipesInsteadOfRestoring() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        var restored: String?
        var wiped = false

        let outcome = await PersistedSessionReconciler.reconcile(
            username: "jolly-quince",
            server: server,
            restore: { restored = $0 },
            wipe: { wiped = true }
        )

        XCTAssertEqual(outcome, .removed)
        XCTAssertNil(restored)
        XCTAssertTrue(wiped)
    }

    func test_existingAccount_restoresWithoutWiping() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.demoServers["alice"] = DemoServerBlock(
            fqdn: "home.alice.flagship.services",
            status: "up",
            ttlIdleMinutes: 30
        )
        var restored: String?
        var wiped = false

        let outcome = await PersistedSessionReconciler.reconcile(
            username: "alice",
            server: server,
            restore: { restored = $0 },
            wipe: { wiped = true }
        )

        XCTAssertEqual(outcome, .restored)
        XCTAssertEqual(restored, "alice")
        XCTAssertFalse(wiped)
    }

    func test_networkFailure_preservesOfflineAccess() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.shouldFail = true
        var restored: String?
        var wiped = false

        let outcome = await PersistedSessionReconciler.reconcile(
            username: "alice",
            server: server,
            restore: { restored = $0 },
            wipe: { wiped = true }
        )

        XCTAssertEqual(outcome, .restoredOffline)
        XCTAssertEqual(restored, "alice")
        XCTAssertFalse(wiped)
    }
}
