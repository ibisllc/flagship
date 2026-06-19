import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class ServiceAccessViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private let serviceRef = "alice-notes"
    private let username = "alice"
    private let control = URL(string: "https://flagshipserver.com")!

    private func irk() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
    }
    /// The author's stable AID — the v2 create/revoke/list signer.
    private func aid() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 5, count: 32))
    }
    private let household = Data(repeating: 0x33, count: 32)

    private func makeVM(
        _ mock: MockServiceAccessClient,
        now: @escaping () -> Int64 = { 1700 },
        store: (any InviteCreateStore)? = nil
    ) -> ServiceAccessViewModel {
        let k = irk(); let a = aid(); let hh = household
        return ServiceAccessViewModel(
            client: mock, serverDomain: server, serviceRef: serviceRef, username: username, controlBase: control,
            createStore: store ?? InMemoryInviteCreateStore(),
            authorAidKeys: { _ in (a, hh) },
            irkSigner: { _ in k },
            now: now
        )
    }

    func testLoadReadsTrueMode() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 3)
        let vm = makeVM(mock)
        await vm.load()
        XCTAssertEqual(vm.phase, .ready)
        XCTAssertTrue(vm.restricted)
        XCTAssertEqual(vm.allowCount, 3)
    }

    func testSetModeSignsValidEnvelopeUnderIrk() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, now: { 1700 })
        await vm.setMode(restricted: true)
        XCTAssertTrue(vm.restricted)
        XCTAssertEqual(mock.setModeCalls.count, 1)
        let call = mock.setModeCalls[0]
        XCTAssertEqual(call.request["mode"], "restricted")
        // The box mode toggle stays owner-IRK signed (the box pins the IRK).
        let bytes = try! ServiceInvite.canonicalSetAccessMode(serverId: server, serviceRef: serviceRef, mode: "restricted", issuedAt: 1700)
        let sig = Data(HexUtil.decode(call.signatureHex)!)
        XCTAssertTrue(irk().publicKey.isValidSignature(sig, for: bytes))
    }

    func testAddPersonAidSignsCreateAndReturnsV2Link() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, now: { 1700 })
        let link = await vm.addPerson(name: "Alex", photo: nil)
        XCTAssertNotNil(link)
        // Canonical v2 link: BARE leading secret (no k=) + the author AID, no
        // inviteId for an auto invite.
        XCTAssertNotNil(link!.range(of: "https://\(server)/invite#[0-9a-f]{64}&a=", options: .regularExpression))
        XCTAssertTrue(link!.contains("&a=\(HexUtil.encode(aid().publicKey.rawRepresentation))"))
        XCTAssertFalse(link!.contains("&i="), "auto invite link omits the inviteId")
        XCTAssertFalse(link!.contains("k="), "canonical link has a bare secret, no k= prefix")

        XCTAssertEqual(mock.createCalls.count, 1)
        let call = mock.createCalls[0]
        XCTAssertEqual(call.request["serviceRef"], serviceRef)
        XCTAssertEqual(call.request["authorAID"], HexUtil.encode(aid().publicKey.rawRepresentation))
        // No approvalMode / maxRedemptions for a personal-auto invite.
        XCTAssertNil(call.request["approvalMode"])
        XCTAssertNil(call.request["maxRedemptions"])
        // The create sig verifies under the AID (v2 switch from IRK) over the bytes.
        let inviteId = call.request["inviteId"]!
        let encBundle = call.request["encryptedBundle"]!
        let bytes = try! ServiceInvite.canonicalCreate(
            inviteId: inviteId, authorAID: aid().publicKey.rawRepresentation, serviceRef: serviceRef,
            secretHash: call.request["secretHash"]!, encryptedBundle: encBundle, issuedAt: 1700)
        let sig = Data(HexUtil.decode(call.signatureHex)!)
        XCTAssertTrue(aid().publicKey.isValidSignature(sig, for: bytes), "v2 create must be AID-signed")
        XCTAssertFalse(irk().publicKey.isValidSignature(sig, for: bytes), "v2 create must NOT be IRK-signed")
        // inviteId is a random 128-bit hex (NOT the structured devicePub form).
        XCTAssertEqual(inviteId.count, 64)
    }

    func testAddManualInviteSetsApprovalModeAndInviteIdInLink() async {
        let mock = MockServiceAccessClient()
        let store = InMemoryInviteCreateStore()
        let vm = makeVM(mock, now: { 1700 }, store: store)
        let link = await vm.addPerson(name: "Sam", photo: nil, tier: .personalManual)
        XCTAssertNotNil(link)
        let call = mock.createCalls[0]
        XCTAssertEqual(call.request["approvalMode"], "manual")
        // The manual link carries the inviteId as the canonical `&i=` (the friend
        // needs it to sign the acceptance).
        let inviteId = call.request["inviteId"]!
        XCTAssertTrue(link!.contains("&i=\(inviteId)"))
        // The signed create is cached locally (so the author can finalize later).
        XCTAssertNotNil(store.get(inviteId: inviteId), "manual create must be persisted for finalize")
        XCTAssertEqual(store.get(inviteId: inviteId)?.createSigHex, call.signatureHex.lowercased())
    }

    func testAddGroupInviteSetsCapsAndExpiry() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, now: { 1700 })
        let link = await vm.addPerson(name: "Chess club", photo: nil, tier: .group(maxRedemptions: 10, expiresAt: 1_700_009_999_999))
        XCTAssertNotNil(link)
        let call = mock.createCalls[0]
        XCTAssertEqual(call.request["maxRedemptions"], "10")
        XCTAssertEqual(call.request["expiresAt"], "1700009999999")
        XCTAssertNil(call.request["approvalMode"], "group is auto-approve")
        // The create sig (with caps appended) verifies under the AID.
        let inviteId = call.request["inviteId"]!
        let bytes = try! ServiceInvite.canonicalCreate(
            inviteId: inviteId, authorAID: aid().publicKey.rawRepresentation, serviceRef: serviceRef,
            secretHash: call.request["secretHash"]!, encryptedBundle: call.request["encryptedBundle"]!,
            issuedAt: 1700, maxRedemptions: 10, expiresAt: 1_700_009_999_999)
        XCTAssertTrue(aid().publicKey.isValidSignature(Data(HexUtil.decode(call.signatureHex)!), for: bytes))
    }

    func testRefreshPeopleSignsListQueryUnderAid() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 1)
        let vm = makeVM(mock, now: { 1700 })
        await vm.load()
        XCTAssertGreaterThanOrEqual(mock.listCalls.count, 1)
        let call = mock.listCalls.last!
        XCTAssertEqual(call.query["authorAID"], HexUtil.encode(aid().publicKey.rawRepresentation))
        XCTAssertEqual(call.query["scope"], "list")
        XCTAssertEqual(call.query["cursor"], "0")
        // The list query is OWNER-SIGNED (v2 §C2) under the AID.
        let bytes = try! ServiceInvite.canonicalListQuery(
            username: username, authorAID: HexUtil.encode(aid().publicKey.rawRepresentation),
            scope: "list", cursor: 0, issuedAt: 1700)
        XCTAssertTrue(aid().publicKey.isValidSignature(Data(HexUtil.decode(call.signatureHex)!), for: bytes))
    }

    func testListPeopleDecryptsBundlesAndFiltersRevoked() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 1)
        let id1 = "aa" + String(repeating: "0", count: 62)
        let id2 = "bb" + String(repeating: "0", count: 62)
        let b1 = try! ServiceInvite.sealBundle(.init(name: "Alex", photo: nil), householdKey: household, inviteId: id1)
        let b2 = try! ServiceInvite.sealBundle(.init(name: "Sam", photo: nil), householdKey: household, inviteId: id2)
        mock.rows = [
            ServiceInviteRow(inviteId: id1, serviceRef: serviceRef, encryptedBundleHex: b1, boundAidHex: "ff", boundAt: 1, createdAt: 1, revokedAt: nil),
            ServiceInviteRow(inviteId: id2, serviceRef: serviceRef, encryptedBundleHex: b2, boundAidHex: nil, boundAt: nil, createdAt: 2, revokedAt: 99), // revoked → filtered
        ]
        let vm = makeVM(mock)
        await vm.load()
        XCTAssertEqual(vm.people.count, 1)
        XCTAssertEqual(vm.people[0].name, "Alex")
        XCTAssertTrue(vm.people[0].bound)
        XCTAssertFalse(vm.people[0].isGroup)
    }

    func testGroupRowSurfacesBoundSetAndCap() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 2)
        let id = "cc" + String(repeating: "0", count: 62)
        let sealed = try! ServiceInvite.sealBundle(.init(name: "Chess club", photo: nil), householdKey: household, inviteId: id)
        let m1 = "a1" + String(repeating: "0", count: 62)
        let m2 = "a2" + String(repeating: "0", count: 62)
        mock.rows = [
            ServiceInviteRow(
                inviteId: id, serviceRef: serviceRef, encryptedBundleHex: sealed,
                boundAidHex: nil, boundAt: nil, createdAt: 1, revokedAt: nil,
                boundAidsHex: [m1, m2], maxRedemptions: 10, expiresAt: nil, redemptions: 2, approvalMode: "auto"),
        ]
        let vm = makeVM(mock)
        await vm.load()
        XCTAssertEqual(vm.people.count, 1)
        let g = vm.people[0]
        XCTAssertTrue(g.isGroup)
        XCTAssertEqual(g.groupMax, 10)
        XCTAssertEqual(Set(g.groupBoundAIDs), Set([m1, m2]))
        XCTAssertTrue(g.bound)
    }

    func testRemoveUnredeemedInviteRevokesComOnlyUnderAid() async {
        // No people loaded ⇒ no bound AID ⇒ `.com` revoke only, NO box prune.
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, now: { 1700 })
        await vm.remove(inviteId: "deadbeef")
        XCTAssertEqual(mock.revokeCalls.count, 1)
        XCTAssertEqual(mock.revokeCalls[0].inviteId, "deadbeef")
        XCTAssertTrue(mock.removeAllowCalls.isEmpty, "no box prune for an unredeemed invite")
    }

    func testRemoveBoundFriendPrunesBoxAllowList() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 1)
        let id = "aa" + String(repeating: "0", count: 62)
        let friendAID = "a1f3c968acbff6ca2b8267282715e72559cc09bf1e25aecbfd316650a4012b6c"
        let sealed = try! ServiceInvite.sealBundle(.init(name: "Alex", photo: nil), householdKey: household, inviteId: id)
        mock.rows = [
            ServiceInviteRow(inviteId: id, serviceRef: serviceRef, encryptedBundleHex: sealed, boundAidHex: friendAID, boundAt: 1, createdAt: 1, revokedAt: nil),
        ]
        let vm = makeVM(mock, now: { 1700 })
        await vm.load()
        XCTAssertEqual(vm.people.count, 1)

        await vm.remove(inviteId: id)
        // The `.com` revoke is AID-signed; the box prune is IRK-signed.
        XCTAssertEqual(mock.revokeCalls.count, 1)
        XCTAssertEqual(mock.removeAllowCalls.count, 1, "a redeemed friend must be pruned from the box")
        let call = mock.removeAllowCalls[0]
        XCTAssertEqual(call.request["aid"], friendAID)
        let bytes = try! ServiceInvite.canonicalRemoveServiceAllow(serverId: server, serviceRef: serviceRef, aid: friendAID, issuedAt: 1700)
        XCTAssertTrue(irk().publicKey.isValidSignature(Data(HexUtil.decode(call.signatureHex)!), for: bytes), "box prune must be owner-IRK signed")
    }

    func testRemoveGroupPrunesEveryBoundAid() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 3)
        let id = "cc" + String(repeating: "0", count: 62)
        let sealed = try! ServiceInvite.sealBundle(.init(name: "Chess club", photo: nil), householdKey: household, inviteId: id)
        let m1 = "a1" + String(repeating: "0", count: 62)
        let m2 = "a2" + String(repeating: "0", count: 62)
        let m3 = "a3" + String(repeating: "0", count: 62)
        mock.rows = [
            ServiceInviteRow(
                inviteId: id, serviceRef: serviceRef, encryptedBundleHex: sealed,
                boundAidHex: nil, boundAt: nil, createdAt: 1, revokedAt: nil,
                boundAidsHex: [m1, m2, m3], maxRedemptions: 10, expiresAt: nil, redemptions: 3, approvalMode: "auto"),
        ]
        let vm = makeVM(mock, now: { 1700 })
        await vm.load()
        await vm.remove(inviteId: id)
        // One `.com` revoke + a box prune for EVERY bound member.
        XCTAssertEqual(mock.revokeCalls.count, 1)
        XCTAssertEqual(mock.removeAllowCalls.count, 3, "group revoke prunes every member")
        XCTAssertEqual(Set(mock.removeAllowCalls.map { $0.request["aid"] }), Set([m1, m2, m3]))
    }

    func testRemoveBoxPruneFailureSurfaces() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 1)
        let id = "aa" + String(repeating: "0", count: 62)
        let sealed = try! ServiceInvite.sealBundle(.init(name: "Alex", photo: nil), householdKey: household, inviteId: id)
        mock.rows = [
            ServiceInviteRow(inviteId: id, serviceRef: serviceRef, encryptedBundleHex: sealed, boundAidHex: "a1f3c968acbff6ca2b8267282715e72559cc09bf1e25aecbfd316650a4012b6c", boundAt: 1, createdAt: 1, revokedAt: nil),
        ]
        let vm = makeVM(mock)
        await vm.load()
        mock.removeAllowError = ScreensClientError.http(status: 403, message: "bad sig")
        await vm.remove(inviteId: id)
        XCTAssertEqual(mock.revokeCalls.count, 1)
        XCTAssertEqual(mock.removeAllowCalls.count, 1, "the box prune was attempted")
        if case .failed = vm.phase {} else { XCTFail("a box-prune failure must surface") }
    }

    func testSetModeFailureSurfaces() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ScreensClientError.http(status: 403, message: "bad sig")
        let vm = makeVM(mock)
        await vm.setMode(restricted: true)
        if case .failed = vm.phase {} else { XCTFail("expected .failed") }
    }
}
