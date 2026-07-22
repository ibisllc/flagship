import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

@MainActor
final class PersistedSessionReconcilerTests: XCTestCase {
    func test_missingAccount_restoresAndOnlyReportsMissing() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        var restored: String?

        let outcome = await PersistedSessionReconciler.reconcile(
            username: "jolly-quince",
            server: server,
            restore: { restored = $0 }
        )

        XCTAssertEqual(outcome, .missing)
        XCTAssertEqual(restored, "jolly-quince")
    }

    func test_existingAccount_restores() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.demoServers["alice"] = DemoServerBlock(
            fqdn: "home.alice.flagship.services",
            status: "up",
            ttlIdleMinutes: 30
        )
        var restored: String?

        let outcome = await PersistedSessionReconciler.reconcile(
            username: "alice",
            server: server,
            restore: { restored = $0 }
        )

        XCTAssertEqual(outcome, .restored)
        XCTAssertEqual(restored, "alice")
    }

    func test_networkFailure_preservesOfflineAccess() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.shouldFail = true
        var restored: String?

        let outcome = await PersistedSessionReconciler.reconcile(
            username: "alice",
            server: server,
            restore: { restored = $0 }
        )

        XCTAssertEqual(outcome, .restoredOffline)
        XCTAssertEqual(restored, "alice")
    }
}
