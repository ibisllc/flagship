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
    private func aid() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 5, count: 32))
    }
    private let household = Data(repeating: 0x33, count: 32)

    private func makeVM(_ mock: MockServiceAccessClient, now: @escaping () -> Int64 = { 1700 }, counter: @escaping () -> Int = { 0 }) -> ServiceAccessViewModel {
        let k = irk(); let a = aid(); let hh = household
        return ServiceAccessViewModel(
            client: mock, serverDomain: server, serviceRef: serviceRef, username: username, controlBase: control,
            authorKeys: { _ in (k, a.publicKey.rawRepresentation, hh) },
            irkSigner: { _ in k },
            readKeys: { _ in (a.publicKey.rawRepresentation, hh) },
            now: now, counter: counter
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

    func testSetModeSignsValidEnvelope() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, now: { 1700 })
        await vm.setMode(restricted: true)
        XCTAssertTrue(vm.restricted)
        XCTAssertEqual(mock.setModeCalls.count, 1)
        let call = mock.setModeCalls[0]
        XCTAssertEqual(call.serverDomain, server)
        XCTAssertEqual(call.request["serviceRef"], serviceRef)
        XCTAssertEqual(call.request["mode"], "restricted")
        // The posted sig verifies against the exact canonical bytes.
        let bytes = try! ServiceInvite.canonicalSetAccessMode(serverId: server, serviceRef: serviceRef, mode: "restricted", issuedAt: 1700)
        let sig = Data(HexUtil.decode(call.signatureHex)!)
        XCTAssertTrue(irk().publicKey.isValidSignature(sig, for: bytes))
    }

    func testAddPersonSealsBundleSignsCreateAndReturnsLink() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, now: { 1700 }, counter: { 0 })
        let link = await vm.addPerson(name: "Alex", photo: nil)
        XCTAssertNotNil(link)
        XCTAssertTrue(link!.hasPrefix("https://\(server)/invite#"))
        // The secret in the link is 64-hex.
        let frag = String(link!.split(separator: "#").last!)
        XCTAssertEqual(frag.count, 64)
        XCTAssertNotNil(HexUtil.decode(frag))

        XCTAssertEqual(mock.createCalls.count, 1)
        let call = mock.createCalls[0]
        XCTAssertEqual(call.username, username)
        XCTAssertEqual(call.request["serviceRef"], serviceRef)
        // inviteId is the deterministic id for (AID, devicePub=IRK, counter 0).
        let expectedId = ServiceInvite.inviteId(
            authorAidPub: aid().publicKey.rawRepresentation,
            authorDevicePub: irk().publicKey.rawRepresentation,
            counter: 0)!
        XCTAssertEqual(call.request["inviteId"], expectedId)
        XCTAssertEqual(call.request["authorAID"], HexUtil.encode(aid().publicKey.rawRepresentation))
        // secretHash = sha256(secret in the link).
        XCTAssertEqual(call.request["secretHash"], ServiceInvite.secretHash(secret: HexUtil.decode(frag)!))
        // The create sig verifies under the IRK over the exact canonical bytes.
        let encBundle = call.request["encryptedBundle"]!
        let bytes = try! ServiceInvite.canonicalCreate(
            inviteId: expectedId, authorAID: aid().publicKey.rawRepresentation, serviceRef: serviceRef,
            secretHash: call.request["secretHash"]!, encryptedBundle: encBundle, issuedAt: 1700)
        let sig = Data(HexUtil.decode(call.signatureHex)!)
        XCTAssertTrue(irk().publicKey.isValidSignature(sig, for: bytes))
        // The sealed bundle opens back to the typed name under the household key.
        let opened = try! ServiceInvite.openBundle(encBundle, householdKey: household, inviteId: expectedId)
        XCTAssertEqual(opened.name, "Alex")
        XCTAssertNil(opened.photo)
    }

    func testListPeopleDecryptsBundlesAndFiltersRevoked() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 1)
        // Seal two bundles under the household key for two invite ids.
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
    }

    func testRemoveUnredeemedInviteRevokesComOnly() async {
        // No people loaded ⇒ no bound AID ⇒ `.com` revoke only, NO box prune
        // (the allow-list never held an unredeemed invite).
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
        // BOTH legs fire: the `.com` revoke AND the box allow-list prune.
        XCTAssertEqual(mock.revokeCalls.count, 1)
        XCTAssertEqual(mock.revokeCalls[0].inviteId, id)
        XCTAssertEqual(mock.removeAllowCalls.count, 1, "a redeemed friend must be pruned from the box")
        let call = mock.removeAllowCalls[0]
        XCTAssertEqual(call.serverDomain, server)
        XCTAssertEqual(call.request["serverId"], server)
        XCTAssertEqual(call.request["serviceRef"], serviceRef)
        XCTAssertEqual(call.request["aid"], friendAID)
        // The prune sig verifies under the owner IRK over the exact canonical bytes.
        let bytes = try! ServiceInvite.canonicalRemoveServiceAllow(
            serverId: server, serviceRef: serviceRef, aid: friendAID, issuedAt: 1700)
        let sig = Data(HexUtil.decode(call.signatureHex)!)
        XCTAssertTrue(irk().publicKey.isValidSignature(sig, for: bytes), "box prune must be owner-IRK signed over the canonical bytes")
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
        // Fail ONLY the box prune — the `.com` revoke still succeeds, but the
        // friend would keep box access, so this must surface.
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
