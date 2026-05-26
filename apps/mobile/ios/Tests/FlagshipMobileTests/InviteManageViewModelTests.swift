import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// P6 — InviteManageViewModel state machine + revoke happy path + the
/// idempotency contract (a re-revoke returns `alreadyRevoked: true`).
@MainActor
final class InviteManageViewModelTests: XCTestCase {

    private func makeClient() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        return c
    }

    private func makePending(opaqueTag: String, inviteId: String, role: String = "member") -> AppInvitePendingSummary {
        AppInvitePendingSummary(
            opaqueTag: opaqueTag,
            inviteId: inviteId,
            role: role,
            expiresAt: 1_800_000_000_000
        )
    }

    private func makeAccess(opaqueTag: String, irkPubHex: String, role: String = "member") -> AppInviteAccessSummary {
        AppInviteAccessSummary(
            opaqueTag: opaqueTag,
            irkPubHex: irkPubHex,
            role: role,
            grantedAt: 1_700_000_000_000
        )
    }

    func test_load_idleToLoaded_withEmptyDefaults() async {
        let client = makeClient()
        let vm = InviteManageViewModel(
            serviceId: "harry-plants",
            client: client,
            labelBook: InMemoryInviteLabelBook()
        )
        await vm.load()
        guard case let .loaded(snap) = vm.state else {
            XCTFail("expected .loaded, got \(vm.state)"); return
        }
        XCTAssertTrue(snap.pending.isEmpty)
        XCTAssertTrue(snap.access.isEmpty)
    }

    func test_load_pinnedFixtures_areReturnedVerbatim() async {
        let client = makeClient()
        client.appInviteListFixture = AppInviteListResponse(pending: [
            makePending(opaqueTag: "aa".replicated16(), inviteId: "inv-1", role: "admin"),
            makePending(opaqueTag: "bb".replicated16(), inviteId: "inv-2", role: "reader"),
        ])
        client.appInviteAccessFixture = AppInviteAccessResponse(access: [
            makeAccess(opaqueTag: "cc".replicated16(),
                       irkPubHex: "ee".replicated32(),
                       role: "member"),
        ])
        let book = InMemoryInviteLabelBook()
        book.put(
            serviceId: "harry-plants",
            opaqueTagHex: "aa".replicated16(),
            label: InviteLabel(displayName: "John (work)", channel: "imessage",
                               sentTo: "x", notes: "", sentAt: 1)
        )
        let vm = InviteManageViewModel(
            serviceId: "harry-plants",
            client: client,
            labelBook: book
        )
        await vm.load()
        guard case let .loaded(snap) = vm.state else {
            XCTFail("expected .loaded"); return
        }
        XCTAssertEqual(snap.pending.count, 2)
        XCTAssertEqual(snap.access.count, 1)
        XCTAssertEqual(snap.pending[0].inviteId, "inv-1")
        XCTAssertEqual(snap.pending[0].role, "admin")

        XCTAssertEqual(vm.label(for: "aa".replicated16())?.displayName, "John (work)")
        XCTAssertNil(vm.label(for: "bb".replicated16()))
    }

    func test_revokeInvite_sendsScopeInviteAndPurgesLocalLabel() async {
        let client = makeClient()
        let tag = "ab".replicated16()
        client.appInviteListFixture = AppInviteListResponse(pending: [
            makePending(opaqueTag: tag, inviteId: "inv-99"),
        ])
        client.appInviteAccessFixture = AppInviteAccessResponse(access: [])
        let book = InMemoryInviteLabelBook()
        book.put(
            serviceId: "harry-plants",
            opaqueTagHex: tag,
            label: InviteLabel(displayName: "x", channel: "other", sentTo: "", notes: "", sentAt: 1)
        )
        let vm = InviteManageViewModel(
            serviceId: "harry-plants",
            client: client,
            labelBook: book
        )
        await vm.load()
        await vm.revokeInvite(inviteId: "inv-99", opaqueTagHex: tag)

        XCTAssertEqual(client.appInviteRevokeCalls.count, 1)
        let revoke = client.appInviteRevokeCalls[0]
        XCTAssertEqual(revoke.scope, "invite")
        XCTAssertEqual(revoke.serviceId, "harry-plants")
        XCTAssertEqual(revoke.inviteId, "inv-99")
        XCTAssertNil(revoke.irkPubKey)

        XCTAssertNil(book.get(serviceId: "harry-plants", opaqueTagHex: tag))
        XCTAssertEqual(vm.lastRevokeOutcome, "revoked")
    }

    func test_revokeAccess_sendsScopeAccessWithIrkPubKey() async {
        let client = makeClient()
        let irk = "11".replicated32()
        client.appInviteListFixture = AppInviteListResponse(pending: [])
        client.appInviteAccessFixture = AppInviteAccessResponse(access: [
            makeAccess(opaqueTag: "cd".replicated16(), irkPubHex: irk),
        ])
        let vm = InviteManageViewModel(
            serviceId: "harry-plants",
            client: client,
            labelBook: InMemoryInviteLabelBook()
        )
        await vm.load()
        await vm.revokeAccess(irkPubKey: irk, opaqueTagHex: "cd".replicated16())

        XCTAssertEqual(client.appInviteRevokeCalls.count, 1)
        let revoke = client.appInviteRevokeCalls[0]
        XCTAssertEqual(revoke.scope, "access")
        XCTAssertEqual(revoke.irkPubKey, irk)
        XCTAssertNil(revoke.inviteId)
    }

    func test_revokeInvite_idempotentReportsAlreadyRevoked() async {
        let client = makeClient()
        let vm = InviteManageViewModel(
            serviceId: "harry-plants",
            client: client,
            labelBook: InMemoryInviteLabelBook()
        )
        await vm.load()
        await vm.revokeInvite(inviteId: "inv-1", opaqueTagHex: nil)
        await vm.revokeInvite(inviteId: "inv-1", opaqueTagHex: nil)
        XCTAssertEqual(vm.lastRevokeOutcome, "already revoked")
    }

    func test_load_clientFailure_landsInFailed() async {
        let client = makeClient()
        client.shouldFail = true
        let vm = InviteManageViewModel(
            serviceId: "harry-plants",
            client: client,
            labelBook: InMemoryInviteLabelBook()
        )
        await vm.load()
        if case .failed = vm.state {
            // expected
        } else {
            XCTFail("expected .failed, got \(vm.state)")
        }
    }

    func test_codableRoundTrip_appInviteRevokeRequest_inviteScope() throws {
        let req = AppInviteRevokeRequest.invite(serviceId: "harry-plants", inviteId: "inv-7")
        let data = try JSONEncoder().encode(req)
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertTrue(json.contains("\"scope\":\"invite\""))
        XCTAssertTrue(json.contains("\"inviteId\":\"inv-7\""))
        // The nil irkPubKey should not surface in the encoded blob;
        // optional defaults omit. (Roundtrip ensures the daemon's
        // discriminated parser doesn't trip on a stray null.)
        let round = try JSONDecoder().decode(AppInviteRevokeRequest.self, from: data)
        XCTAssertEqual(round.scope, "invite")
        XCTAssertEqual(round.inviteId, "inv-7")
    }
}

private extension String {
    /// `"ab".replicated16()` → a 32-char hex string ("ababab…ab", 32
    /// chars). Used for the 16-byte opaqueTag fixtures.
    func replicated16() -> String { String(repeating: self, count: 16) }
    /// `"11".replicated32()` → a 64-char hex string. Used for the
    /// 32-byte IRK pubkey hex fixtures.
    func replicated32() -> String { String(repeating: self, count: 32) }
}
