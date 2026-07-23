import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// P14 — CompanionDockViewModel state machine + the wire shape it renders.
/// Mirrors the daemon's desktop-begin → phone-approve contract plus active
/// companion listing and revocation.
@MainActor
final class CompanionDockViewModelTests: XCTestCase {

    private func makeClient() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        return c
    }

    // MARK: - Default mock fixtures

    func test_mockFixture_defaultListIsHonestEmpty() async throws {
        let client = makeClient()
        let r = try await client.companionList()
        XCTAssertTrue(r.companions.isEmpty)
    }

    // MARK: - load()

    func test_load_idle_toLoaded_emptyDefault() async {
        let client = makeClient()
        let vm = CompanionDockViewModel(client: client)
        await vm.load()
        guard case .loaded(let s) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertTrue(s.companions.isEmpty)
    }

    func test_load_pinnedFixture_isReturnedVerbatim() async {
        let client = makeClient()
        client.companionListFixture = CompanionListResponse(companions: [
            CompanionSummary(
                tokenPrefix: "deadbe",
                redeemedAt: 1_700_000_000_000,
                lastSeenMs: 1_700_000_500_000,
                expiresAt: 1_700_014_400_000,
                userAgent: "Mozilla/5.0"
            ),
            CompanionSummary(
                tokenPrefix: "f00dca",
                redeemedAt: 1_700_000_100_000,
                lastSeenMs: 1_700_000_700_000,
                expiresAt: 1_700_014_500_000,
                userAgent: nil
            )
        ])
        let vm = CompanionDockViewModel(client: client)
        await vm.load()
        guard case .loaded(let s) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertEqual(s.companions.count, 2)
        XCTAssertEqual(s.companions[0].tokenPrefix, "deadbe")
        XCTAssertEqual(s.companions[0].userAgent, "Mozilla/5.0")
        XCTAssertNil(s.companions[1].userAgent)
    }

    func test_load_failure_surfacesAsFailed() async {
        let client = makeClient()
        client.shouldFail = true
        let vm = CompanionDockViewModel(client: client)
        await vm.load()
        if case .failed = vm.state {
            // expected
        } else {
            XCTFail("expected .failed, got \(vm.state)")
        }
    }

    // MARK: - desktop-initiated approval

    private var approvalLink: String {
        "flagship://dock?server=home.alice.flagship.services&request=\("ab".repeated(16))&code=\("cd".repeated(32))"
    }

    func test_stageApproval_rejectsUnrelatedLink() {
        let vm = CompanionDockViewModel(client: makeClient(), authenticate: { _ in })
        XCTAssertFalse(vm.stageApproval(link: "https://example.com/not-dock"))
        XCTAssertNil(vm.stagedApproval)
        XCTAssertNotNil(vm.approvalError)
    }

    func test_stageApproval_requiresSelectedServer() {
        let vm = CompanionDockViewModel(
            client: makeClient(),
            expectedServerDomain: "other.alice.flagship.services",
            authenticate: { _ in }
        )
        XCTAssertFalse(vm.stageApproval(link: approvalLink))
        XCTAssertNil(vm.stagedApproval)
        XCTAssertTrue(vm.approvalError?.contains("Switch to") == true)
    }

    func test_approve_faceGatesThenPostsAndRefreshes() async {
        let client = makeClient()
        var biometricCount = 0
        let vm = CompanionDockViewModel(client: client, authenticate: { _ in biometricCount += 1 })
        XCTAssertTrue(vm.stageApproval(link: approvalLink))
        await vm.approve()
        XCTAssertEqual(biometricCount, 1)
        XCTAssertEqual(client.companionApproveDockCalls.count, 1)
        XCTAssertEqual(client.companionApproveDockCalls[0].requestId, "ab".repeated(16))
        XCTAssertTrue(vm.approvalComplete)
        XCTAssertNil(vm.stagedApproval)
    }

    func test_approve_biometricFailureNeverPosts() async {
        struct Cancelled: Error {}
        let client = makeClient()
        let vm = CompanionDockViewModel(client: client, authenticate: { _ in throw Cancelled() })
        XCTAssertTrue(vm.stageApproval(link: approvalLink))
        await vm.approve()
        XCTAssertTrue(client.companionApproveDockCalls.isEmpty)
        XCTAssertFalse(vm.approvalComplete)
        XCTAssertNotNil(vm.approvalError)
    }

    // MARK: - revoke()

    func test_revoke_recordsCall_andClearsPending() async {
        let client = makeClient()
        client.companionListFixture = CompanionListResponse(companions: [
            CompanionSummary(
                tokenPrefix: "deadbe",
                redeemedAt: 1, lastSeenMs: 2, expiresAt: 3, userAgent: nil
            ),
            CompanionSummary(
                tokenPrefix: "f00dca",
                redeemedAt: 1, lastSeenMs: 2, expiresAt: 3, userAgent: nil
            )
        ])
        let vm = CompanionDockViewModel(client: client)
        await vm.load()
        await vm.revoke(tokenPrefix: "deadbe")
        XCTAssertEqual(client.companionRevokeCalls, ["deadbe"])
        XCTAssertFalse(vm.revokePending.contains("deadbe"))
        guard case .loaded(let s) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertEqual(s.companions.map(\.tokenPrefix), ["f00dca"])
    }

    func test_revoke_failure_surfacesAsFailed_andClearsPending() async {
        let client = makeClient()
        let vm = CompanionDockViewModel(client: client)
        await vm.load()
        client.shouldFail = true
        await vm.revoke(tokenPrefix: "deadbe")
        if case .failed = vm.state {
            // expected
        } else {
            XCTFail("expected .failed, got \(vm.state)")
        }
        XCTAssertFalse(vm.revokePending.contains("deadbe"))
    }

    // MARK: - Wire-shape codable round-trip

    func test_listResponse_codable_roundTrips() throws {
        let original = CompanionListResponse(companions: [
            CompanionSummary(
                tokenPrefix: "abcdef",
                redeemedAt: 1, lastSeenMs: 2, expiresAt: 3,
                userAgent: "ua"
            ),
            CompanionSummary(
                tokenPrefix: "012345",
                redeemedAt: 4, lastSeenMs: 5, expiresAt: 6,
                userAgent: nil
            )
        ])
        let json = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(CompanionListResponse.self, from: json)
        XCTAssertEqual(decoded, original)
    }

    func test_mintRequest_codable_isEmptyObject() throws {
        let req = CompanionMintTicketRequest()
        let json = try JSONEncoder().encode(req)
        let obj = try JSONSerialization.jsonObject(with: json) as? [String: Any]
        XCTAssertEqual(obj?.count, 0)
    }

    func test_revokeRequest_codable_carriesTokenPrefix() throws {
        let req = CompanionRevokeRequest(tokenPrefix: "deadbe")
        let json = try JSONEncoder().encode(req)
        let obj = try JSONSerialization.jsonObject(with: json) as? [String: Any]
        XCTAssertEqual(obj?["tokenPrefix"] as? String, "deadbe")
    }
}

private extension String {
    func repeated(_ count: Int) -> String { String(repeating: self, count: count) }
}
