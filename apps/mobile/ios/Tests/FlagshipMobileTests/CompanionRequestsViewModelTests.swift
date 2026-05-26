import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipUI

/// P14 Phase 2 — CompanionRequestsViewModel state machine.
///
/// Approve flow: parse intent → IRK-sign the destination envelope →
/// call releaseServerName/revokeServer → on success record
/// `/api/screens/companion/resolve-pending` with "approved". Failure on
/// the destination POST does NOT resolve the row. Deny posts the resolve
/// directly with "denied". Unsupported kinds render an error without
/// auto-action.
@MainActor
final class CompanionRequestsViewModelTests: XCTestCase {

    // MARK: - Helpers

    private func makeClients() -> (MockScreensClient, MockFlagshipServerClient) {
        let s = MockScreensClient()
        s.simulatedLatency = 0
        let f = MockFlagshipServerClient()
        f.simulatedLatency = 0
        return (s, f)
    }

    private func makeSigner() -> (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey) {
        let key = Curve25519.Signing.PrivateKey()
        return { _ in key }
    }

    private func releaseRow(
        requestId: String = "req-rel-1",
        serverDomain: String = "home.alice.flagship.services",
        queuedAt: Int64 = 1_700_000_000_000,
        expiresAt: Int64 = 1_700_000_600_000,
        label: String? = "Library iMac"
    ) -> CompanionPendingWrite {
        return CompanionPendingWrite(
            requestId: requestId,
            companionTokenPrefix: "deadbeef0000",
            companionLabel: label,
            kind: "release-server",
            intent: [
                "username": AnyCodable("alice"),
                "serverDomain": AnyCodable(serverDomain),
                "issuedAt": AnyCodable(1_700_000_000_000 as Int64),
            ],
            queuedAt: queuedAt,
            expiresAt: expiresAt
        )
    }

    private func revokeRow(
        requestId: String = "req-rev-1",
        serverId: String = "home.alice.flagship.services",
        reason: String = "lost",
        queuedAt: Int64 = 1_700_000_001_000
    ) -> CompanionPendingWrite {
        return CompanionPendingWrite(
            requestId: requestId,
            companionTokenPrefix: "f00dcafe1111",
            companionLabel: nil,
            kind: "revoke-server",
            intent: [
                "userId": AnyCodable("alice"),
                "revokedServerId": AnyCodable(serverId),
                "reason": AnyCodable(reason),
                "issuedAt": AnyCodable(1_700_000_001_000 as Int64),
            ],
            queuedAt: queuedAt,
            expiresAt: queuedAt + 600_000
        )
    }

    // MARK: - load()

    func test_load_happyPath_sortsOldestFirst() async {
        let (screens, server) = makeClients()
        screens.companionPendingWritesFixture = CompanionPendingWritesResponse(pending: [
            releaseRow(requestId: "later", queuedAt: 2_000),
            releaseRow(requestId: "earlier", queuedAt: 1_000),
        ])
        let vm = CompanionRequestsViewModel(
            client: screens,
            server: server,
            username: { "alice" },
            signer: makeSigner()
        )
        await vm.load()
        guard case .loaded(let rows) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertEqual(rows.map { $0.requestId }, ["earlier", "later"])
    }

    func test_load_failure_surfacesFailed() async {
        let (screens, server) = makeClients()
        screens.shouldFail = true
        let vm = CompanionRequestsViewModel(
            client: screens,
            server: server,
            username: { "alice" },
            signer: makeSigner()
        )
        await vm.load()
        if case .failed = vm.state {
            // ok
        } else {
            XCTFail("expected .failed, got \(vm.state)")
        }
    }

    // MARK: - approve(release-server)

    func test_approve_releaseServer_signsAndResolves() async {
        let (screens, server) = makeClients()
        let row = releaseRow()
        screens.companionPendingWritesFixture = CompanionPendingWritesResponse(pending: [row])
        let vm = CompanionRequestsViewModel(
            client: screens,
            server: server,
            username: { "alice" },
            signer: makeSigner()
        )
        await vm.load()
        await vm.approve(row)
        XCTAssertEqual(server.releasedServerNames.count, 1)
        XCTAssertEqual(server.releasedServerNames.first?.request.username, "alice")
        XCTAssertEqual(
            server.releasedServerNames.first?.request.serverDomain,
            "home.alice.flagship.services"
        )
        XCTAssertEqual(screens.companionResolveCalls.count, 1)
        XCTAssertEqual(screens.companionResolveCalls.first?.requestId, row.requestId)
        XCTAssertEqual(screens.companionResolveCalls.first?.outcome, "approved")
        XCTAssertTrue(vm.resolvePending.isEmpty)
        XCTAssertNil(vm.rowError[row.requestId])
        // Row is removed from the loaded list after resolve.
        guard case .loaded(let rows) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertTrue(rows.isEmpty)
    }

    // MARK: - approve(revoke-server)

    func test_approve_revokeServer_signsAndResolves() async {
        let (screens, server) = makeClients()
        let row = revokeRow()
        screens.companionPendingWritesFixture = CompanionPendingWritesResponse(pending: [row])
        let vm = CompanionRequestsViewModel(
            client: screens,
            server: server,
            username: { "alice" },
            signer: makeSigner()
        )
        await vm.load()
        await vm.approve(row)
        XCTAssertEqual(server.revokedServers.count, 1)
        XCTAssertEqual(server.revokedServers.first?.request.userId, "alice")
        XCTAssertEqual(server.revokedServers.first?.request.reason, "lost")
        XCTAssertEqual(screens.companionResolveCalls.first?.outcome, "approved")
        XCTAssertNil(vm.rowError[row.requestId])
    }

    // MARK: - approve failure on destination POST

    func test_approve_destinationFailure_doesNotResolve() async {
        let screens = MockScreensClient()
        screens.simulatedLatency = 0
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        // MockFlagshipServerClient.shouldFail makes every method throw —
        // including releaseServerName — without resolving.
        server.shouldFail = true
        let row = releaseRow()
        screens.companionPendingWritesFixture = CompanionPendingWritesResponse(pending: [row])
        let vm = CompanionRequestsViewModel(
            client: screens,
            server: server,
            username: { "alice" },
            signer: makeSigner()
        )
        await vm.load()
        await vm.approve(row)
        XCTAssertEqual(screens.companionResolveCalls.count, 0, "resolve must NOT be posted when destination failed")
        XCTAssertNotNil(vm.rowError[row.requestId])
        // Row stays in the loaded list.
        guard case .loaded(let rows) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertEqual(rows.first?.requestId, row.requestId)
    }

    // MARK: - deny

    func test_deny_postsResolveDirectly_withoutSigning() async {
        let (screens, server) = makeClients()
        let row = releaseRow()
        screens.companionPendingWritesFixture = CompanionPendingWritesResponse(pending: [row])
        let vm = CompanionRequestsViewModel(
            client: screens,
            server: server,
            username: { "alice" },
            signer: makeSigner()
        )
        await vm.load()
        await vm.deny(row)
        XCTAssertEqual(server.releasedServerNames.count, 0)
        XCTAssertEqual(server.revokedServers.count, 0)
        XCTAssertEqual(screens.companionResolveCalls.count, 1)
        XCTAssertEqual(screens.companionResolveCalls.first?.outcome, "denied")
    }

    // MARK: - unsupported kind

    func test_approve_unsupportedKind_doesNotSignOrResolve() async {
        let (screens, server) = makeClients()
        let row = CompanionPendingWrite(
            requestId: "req-unsupported",
            companionTokenPrefix: "0000feed",
            companionLabel: "Library iMac",
            kind: "mystery-kind",
            intent: ["whatever": AnyCodable("blob")],
            queuedAt: 1_700_000_000_000,
            expiresAt: 1_700_000_600_000
        )
        screens.companionPendingWritesFixture = CompanionPendingWritesResponse(pending: [row])
        let vm = CompanionRequestsViewModel(
            client: screens,
            server: server,
            username: { "alice" },
            signer: makeSigner()
        )
        await vm.load()
        await vm.approve(row)
        XCTAssertEqual(server.releasedServerNames.count, 0)
        XCTAssertEqual(server.revokedServers.count, 0)
        XCTAssertEqual(screens.companionResolveCalls.count, 0)
        XCTAssertNotNil(vm.rowError[row.requestId])
    }

    // MARK: - Wire-shape codable round-trip

    func test_pendingWritesResponse_codable_roundTrips() throws {
        let original = CompanionPendingWritesResponse(pending: [
            CompanionPendingWrite(
                requestId: "req-1",
                companionTokenPrefix: "deadbeef",
                companionLabel: "Library iMac",
                kind: "release-server",
                intent: [
                    "username": AnyCodable("alice"),
                    "serverDomain": AnyCodable("home.alice.flagship.services"),
                    "issuedAt": AnyCodable(1_700_000_000_000 as Int64),
                ],
                queuedAt: 1_700_000_000_000,
                expiresAt: 1_700_000_600_000
            )
        ])
        let json = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(CompanionPendingWritesResponse.self, from: json)
        XCTAssertEqual(decoded.pending.count, 1)
        XCTAssertEqual(decoded.pending.first?.requestId, "req-1")
        XCTAssertEqual(decoded.pending.first?.kind, "release-server")
    }
}
