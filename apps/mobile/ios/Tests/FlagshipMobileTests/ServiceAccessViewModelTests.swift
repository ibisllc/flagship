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

    func testRemoveSignsRevoke() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, now: { 1700 })
        await vm.remove(inviteId: "deadbeef")
        XCTAssertEqual(mock.revokeCalls.count, 1)
        XCTAssertEqual(mock.revokeCalls[0].inviteId, "deadbeef")
        // (the revoke envelope was signed; the Mock records the call — the
        // canonical-bytes verification is covered by the vector test.)
    }

    func testSetModeFailureSurfaces() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ScreensClientError.http(status: 403, message: "bad sig")
        let vm = makeVM(mock)
        await vm.setMode(restricted: true)
        if case .failed = vm.phase {} else { XCTFail("expected .failed") }
    }
}
