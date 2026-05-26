import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// P14 — CompanionDockViewModel state machine + the wire shape it renders.
/// Mirrors the daemon's `/api/screens/companion/*` BFF contract:
///   - `companionMintTicket` → 60s ticket the QR encodes.
///   - `companionList` → active companions, honest-empty by default.
///   - `companionRevoke` → kills the session by tokenPrefix.
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
                tokenPrefix: "deadbe", label: "Work MacBook",
                redeemedAt: 1_700_000_000_000,
                lastSeenMs: 1_700_000_500_000,
                expiresAt: 1_700_014_400_000,
                userAgent: "Mozilla/5.0"
            ),
            CompanionSummary(
                tokenPrefix: "f00dca", label: nil,
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
        XCTAssertEqual(s.companions[0].label, "Work MacBook")
        XCTAssertEqual(s.companions[0].userAgent, "Mozilla/5.0")
        XCTAssertNil(s.companions[1].label)
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

    // MARK: - mint()

    func test_mint_recordsCall_andSurfacesTicket() async {
        let client = makeClient()
        let vm = CompanionDockViewModel(client: client)
        await vm.mint(label: "My laptop")
        XCTAssertEqual(client.companionMintCalls.count, 1)
        XCTAssertEqual(client.companionMintCalls.first?.label, "My laptop")
        XCTAssertNotNil(vm.mintedTicket)
        XCTAssertNil(vm.mintError)
        // 60s TTL — within a 5s slack so the test isn't flaky on slow CI.
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let remaining = (vm.mintedTicket?.expiresAt ?? 0) - now
        XCTAssertGreaterThan(remaining, 55_000)
        XCTAssertLessThanOrEqual(remaining, 60_000)
    }

    func test_mint_blankLabelNormalizedToNil() async {
        let client = makeClient()
        let vm = CompanionDockViewModel(client: client)
        await vm.mint(label: "   ")
        XCTAssertEqual(client.companionMintCalls.count, 1)
        XCTAssertNil(client.companionMintCalls.first?.label)
    }

    func test_mint_nilLabelStaysNil() async {
        let client = makeClient()
        let vm = CompanionDockViewModel(client: client)
        await vm.mint(label: nil)
        XCTAssertEqual(client.companionMintCalls.count, 1)
        XCTAssertNil(client.companionMintCalls.first?.label)
    }

    func test_mint_failure_setsMintError_clearsTicket() async {
        let client = makeClient()
        client.shouldFail = true
        let vm = CompanionDockViewModel(client: client)
        await vm.mint(label: "x")
        XCTAssertNil(vm.mintedTicket)
        XCTAssertNotNil(vm.mintError)
    }

    func test_dismissMintedTicket_clears() async {
        let client = makeClient()
        let vm = CompanionDockViewModel(client: client)
        await vm.mint(label: nil)
        XCTAssertNotNil(vm.mintedTicket)
        vm.dismissMintedTicket()
        XCTAssertNil(vm.mintedTicket)
    }

    // MARK: - revoke()

    func test_revoke_recordsCall_andClearsPending() async {
        let client = makeClient()
        client.companionListFixture = CompanionListResponse(companions: [
            CompanionSummary(
                tokenPrefix: "deadbe", label: "Work MacBook",
                redeemedAt: 1, lastSeenMs: 2, expiresAt: 3, userAgent: nil
            ),
            CompanionSummary(
                tokenPrefix: "f00dca", label: nil,
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
                tokenPrefix: "abcdef", label: "Office",
                redeemedAt: 1, lastSeenMs: 2, expiresAt: 3,
                userAgent: "ua"
            ),
            CompanionSummary(
                tokenPrefix: "012345", label: nil,
                redeemedAt: 4, lastSeenMs: 5, expiresAt: 6,
                userAgent: nil
            )
        ])
        let json = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(CompanionListResponse.self, from: json)
        XCTAssertEqual(decoded, original)
    }

    func test_mintRequest_codable_omitsNilLabelAsNull() throws {
        // The daemon accepts both `{label: null}` and `{}` (label is
        // optional). Swift's JSONEncoder emits `null` for nil; pin that
        // shape so the wire-format match with TS/Kotlin is observable.
        let req = CompanionMintTicketRequest(label: nil)
        let json = try JSONEncoder().encode(req)
        let obj = try JSONSerialization.jsonObject(with: json) as? [String: Any]
        XCTAssertNotNil(obj)
        // Either the key is absent OR explicitly NSNull — both are
        // acceptable on the wire.
        if let raw = obj?["label"] {
            XCTAssertTrue(raw is NSNull, "label should be null, got \(raw)")
        }
    }

    func test_mintRequest_codable_includesLabelWhenPresent() throws {
        let req = CompanionMintTicketRequest(label: "My laptop")
        let json = try JSONEncoder().encode(req)
        let obj = try JSONSerialization.jsonObject(with: json) as? [String: Any]
        XCTAssertEqual(obj?["label"] as? String, "My laptop")
    }

    func test_revokeRequest_codable_carriesTokenPrefix() throws {
        let req = CompanionRevokeRequest(tokenPrefix: "deadbe")
        let json = try JSONEncoder().encode(req)
        let obj = try JSONSerialization.jsonObject(with: json) as? [String: Any]
        XCTAssertEqual(obj?["tokenPrefix"] as? String, "deadbe")
    }
}
