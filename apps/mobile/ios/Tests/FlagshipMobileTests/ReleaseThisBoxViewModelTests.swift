import XCTest
import CryptoKit
@testable import FlagshipUI
import FlagshipAPI
import FlagshipCore

/// "Release this box" on the server page: admin-root signed, Face ID first, the box's refusal
/// codes in the owner's words.
@MainActor
final class ReleaseThisBoxViewModelTests: XCTestCase {
    private let domain = "home.bright-maple.flagship.services"
    private let stk = String(repeating: "ab", count: 32)
    private let admin = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x5a, count: 32))

    private func mock() -> MockScreensClient {
        let m = MockScreensClient()
        m.simulatedLatency = 0
        return m
    }

    func testSignsAnOrderTheBoxVerifies() async throws {
        let c = mock()
        var prompts: [String] = []
        let vm = ReleaseThisBoxViewModel(serverDomain: domain, username: "harry", stkPubHex: stk, client: c, canRelease: true,
                                         signer: { reason in prompts.append(reason); return self.admin },
                                         pqSigner: { _, _ in nil }, now: { 1_790_000_000_000 })
        await vm.release()
        XCTAssertTrue(vm.released)
        XCTAssertNil(vm.error)
        XCTAssertEqual(prompts.count, 1)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(c.releaseBodies.first)) as? [String: Any])
        let o = try XCTUnwrap(body["order"] as? [String: Any])
        let order = ReleaseThisBox.Order(serverDomain: o["serverDomain"] as! String, stkPubHex: o["stkPubHex"] as! String,
                                         issuedAt: (o["issuedAt"] as! NSNumber).int64Value, nonceHex: o["nonceHex"] as! String)
        XCTAssertEqual(order.stkPubHex, stk)
        XCTAssertTrue(ReleaseThisBox.verify(order, signatureHex: body["signatureHex"] as! String, adminRootPub: admin.publicKey.rawRepresentation))
        XCTAssertNil(body["pqSignature"])
    }

    func testCarriesTheHybridSignatureWhenGiven() async throws {
        let c = mock()
        let vm = ReleaseThisBoxViewModel(serverDomain: domain, username: "harry", stkPubHex: stk, client: c, canRelease: true,
                                         signer: { _ in self.admin }, pqSigner: { _, _ in PqSignatureWire(suite: ReleaseThisBox.hybridSuite, signature: "00") })
        await vm.release()
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(c.releaseBodies.first)) as? [String: Any])
        XCTAssertEqual((body["pqSignature"] as? [String: Any])?["suite"] as? String, ReleaseThisBox.hybridSuite)
    }

    func testNonAdminDeviceSendsNothing() async {
        let c = mock()
        let vm = ReleaseThisBoxViewModel(serverDomain: domain, username: "harry", stkPubHex: stk, client: c, canRelease: false,
                                         signer: { _ in self.admin }, pqSigner: { _, _ in nil })
        await vm.release()
        XCTAssertTrue(c.releaseBodies.isEmpty)
        XCTAssertFalse(vm.released)
    }

    func testRefusalsAreSentences() async {
        let c = mock()
        c.releaseRefusal = "release-needs-hybrid"
        let vm = ReleaseThisBoxViewModel(serverDomain: domain, username: "harry", stkPubHex: stk, client: c, canRelease: true,
                                         signer: { _ in self.admin }, pqSigner: { _, _ in nil })
        await vm.release()
        XCTAssertFalse(vm.released)
        XCTAssertEqual(vm.error, ReleaseThisBox.refusal("release-needs-hybrid"))
    }

    func testResetWindowSentenceNamesTheServer() {
        XCTAssertTrue(PushNotifications.resetWindowText(server: domain).contains("home"))
        XCTAssertFalse(PushNotifications.resetWindowText(server: domain).contains("bright-maple"))
    }
}
