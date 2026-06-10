import XCTest
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// `BootApprovalWatcher` is the account-level "which boxes are waiting?" poll
/// that feeds the per-server liveness classifier. One fetch maps the verified,
/// non-expired unlock-key requests to their serverDomains and publishes the
/// set on AppState. These tests drive it through the same injected fake
/// `ApprovalSource` (no network / biometric) with a fixed clock.
@MainActor
final class BootApprovalWatcherTests: XCTestCase {
    private let domain = "home.demo1234.flagship.services"
    private let other = "other.demo1234.flagship.services"
    private let nowMs: Int64 = 1_700_000_000_000

    private func request(
        serverDomain: String,
        purpose: SecretPurpose = .unlockKey,
        expiresAt: Int64
    ) -> SecretRequestCoordinator.VerifiedRequest {
        let pending = PendingSecretRequest(
            serverDomain: serverDomain,
            requestNonceHex: String(repeating: "0", count: 64),
            stkPub: String(repeating: "1", count: 64),
            purpose: purpose.rawValue,
            issuedAt: nowMs,
            requestSignature: String(repeating: "2", count: 128),
            deviceInfo: nil,
            postedAt: nowMs,
            expiresAt: expiresAt
        )
        return SecretRequestCoordinator.VerifiedRequest(
            pending: pending,
            directoryStkPubHex: String(repeating: "1", count: 64)
        )
    }

    private final class FakeSource: ApprovalSource {
        var requests: [SecretRequestCoordinator.VerifiedRequest] = []
        var fetchError: Error?
        func verifiedRequests() async throws -> [SecretRequestCoordinator.VerifiedRequest] {
            if let fetchError { throw fetchError }
            return requests
        }
        @discardableResult
        func approve(_ request: SecretRequestCoordinator.VerifiedRequest, depositAutoLease: Bool) async throws -> String? { nil }
    }

    private func makeWatcher(_ app: AppState, _ source: FakeSource) -> BootApprovalWatcher {
        BootApprovalWatcher(
            app: app,
            makeCoordinator: { source },
            pollIntervalNanos: 1,
            now: { [nowMs] in nowMs }
        )
    }

    func test_publishesLiveUnlockDomains() async {
        let app = AppState(currentUser: "demo1234")
        let source = FakeSource()
        source.requests = [request(serverDomain: domain, expiresAt: nowMs + 60_000)]
        let w = makeWatcher(app, source)
        let set = await w.pollOnce()
        XCTAssertEqual(set, [domain])
        XCTAssertEqual(app.serversAwaitingApproval, [domain])
    }

    func test_ignoresExpiredAndNonUnlockRequests() async {
        let app = AppState(currentUser: "demo1234")
        let source = FakeSource()
        source.requests = [
            request(serverDomain: domain, expiresAt: nowMs - 1),                 // expired
            request(serverDomain: other, purpose: .entitlement, expiresAt: nowMs + 60_000), // wrong purpose
        ]
        let w = makeWatcher(app, source)
        let set = await w.pollOnce()
        XCTAssertTrue(set.isEmpty)
    }

    func test_transientThrowLeavesPriorSetUntouched() async {
        let app = AppState(currentUser: "demo1234")
        app.serversAwaitingApproval = [domain]
        let source = FakeSource()
        source.fetchError = ScreensClientError.http(status: 500, message: "blip")
        let w = makeWatcher(app, source)
        let set = await w.pollOnce()
        XCTAssertEqual(set, [domain], "a fetch blip must not clear the waiting set")
    }

    func test_nilCoordinatorIsNoOp() async {
        let app = AppState(currentUser: "demo1234")
        app.serversAwaitingApproval = [domain]
        let w = BootApprovalWatcher(app: app, makeCoordinator: { nil }, pollIntervalNanos: 1, now: { self.nowMs })
        let set = await w.pollOnce()
        XCTAssertEqual(set, [domain])
    }
}
