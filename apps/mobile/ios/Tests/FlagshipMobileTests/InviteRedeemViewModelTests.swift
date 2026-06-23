import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class InviteRedeemViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private let secret = String(repeating: "07", count: 32) // 64-hex
    private let authorAid = String(repeating: "b4", count: 32) // 64-hex
    private let inviteId = String(repeating: "ea", count: 32)   // 64-hex

    /// The friend's per-author CONTACT AID — what v2 presents (NOT the global AID).
    private func contactAid() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 5, count: 32))
    }

    private func makeVM(
        _ mock: MockServiceAccessClient,
        secret: String? = nil,
        authorAidHex: String? = nil,
        inviteId: String? = nil,
        now: @escaping () -> Int64 = { 1700 }
    ) -> InviteRedeemViewModel {
        let k = contactAid()
        return InviteRedeemViewModel(
            client: mock, serverDomain: server, secretHex: secret ?? self.secret,
            authorAidHex: authorAidHex, inviteId: inviteId,
            redeemAid: { _, _ in k }, now: now)
    }

    func testRedeemPresentsContactAidNotGlobal() async {
        let mock = MockServiceAccessClient()
        mock.redeemResult = RedeemResult(serviceRef: "alice--notes", boundAidHex: HexUtil.encode(contactAid().publicKey.rawRepresentation), firstBind: true)
        let vm = makeVM(mock, authorAidHex: authorAid, inviteId: nil)
        await vm.redeem()
        if case .done(let ref, let first) = vm.phase {
            XCTAssertEqual(ref, "alice--notes")
            XCTAssertTrue(first)
        } else { XCTFail("expected .done, got \(vm.phase)") }
        XCTAssertEqual(mock.redeemCalls.count, 1)
        let call = mock.redeemCalls[0]
        XCTAssertEqual(call.secretHex, secret) // RAW secret sent (box re-hashes)
        // The presented visitorAID is the CONTACT AID, not a global one.
        XCTAssertEqual(call.visitorAidHex, HexUtil.encode(contactAid().publicKey.rawRepresentation))
    }

    func testRedeemSigVerifiesUnderContactAid() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, authorAidHex: authorAid, now: { 1700 })
        await vm.redeem()
        let secretHash = ServiceInvite.secretHash(secret: HexUtil.decode(secret)!)
        let bytes = try! ServiceInvite.canonicalRedeem(secretHash: secretHash, visitorAID: contactAid().publicKey.rawRepresentation, redeemedAt: 1700)
        let sig = try! contactAid().signature(for: bytes)
        XCTAssertTrue(contactAid().publicKey.isValidSignature(sig, for: bytes))
        XCTAssertEqual(mock.redeemCalls.count, 1)
    }

    func testManualPendingBuildsAcceptanceReply() async {
        let mock = MockServiceAccessClient()
        // The box returns {pending} for a manual-approve invite.
        mock.redeemResult = RedeemResult(serviceRef: "alice--notes", boundAidHex: "", firstBind: false, pending: true)
        let vm = makeVM(mock, authorAidHex: authorAid, inviteId: inviteId)
        await vm.redeem()
        guard case .pendingApproval(let ref, let replyLink) = vm.phase else {
            return XCTFail("expected .pendingApproval, got \(vm.phase)")
        }
        XCTAssertEqual(ref, "alice--notes")
        // The reply is a valid invite-accept deeplink the AUTHOR can open.
        guard case .inviteAccept(let s, let iid, let r, let aid, let sigHex, _) = DeepLink.parse(URL(string: replyLink)!) else {
            return XCTFail("reply link must parse to .inviteAccept")
        }
        XCTAssertEqual(s, server)
        XCTAssertEqual(iid, inviteId)
        XCTAssertEqual(r, "alice--notes")
        XCTAssertEqual(aid, HexUtil.encode(contactAid().publicKey.rawRepresentation))
        // The acceptance sig in the reply verifies under the contact AID over the
        // canonical accept bytes (binds inviteId + serviceRef + contactAID).
        // (acceptedAt is the VM's now() = 1700.)
        let bytes = try! ServiceInvite.canonicalAccept(
            inviteId: inviteId, serviceRef: "alice--notes",
            contactAID: contactAid().publicKey.rawRepresentation, acceptedAt: 1700)
        XCTAssertTrue(contactAid().publicKey.isValidSignature(Data(HexUtil.decode(sigHex)!), for: bytes))
    }

    func testManualPendingWithoutInviteIdFails() async {
        let mock = MockServiceAccessClient()
        mock.redeemResult = RedeemResult(serviceRef: "alice--notes", boundAidHex: "", firstBind: false, pending: true)
        // No inviteId in the link ⇒ can't sign the acceptance ⇒ a clear failure.
        let vm = makeVM(mock, authorAidHex: authorAid, inviteId: nil)
        await vm.redeem()
        if case .failed = vm.phase {} else { XCTFail("manual pending without inviteId must fail") }
    }

    func testUnknownInvite404() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ServiceAccessError.inviteUnknown
        let vm = makeVM(mock, authorAidHex: authorAid)
        await vm.redeem()
        if case .failed(let msg) = vm.phase { XCTAssertTrue(msg.contains("unknown") || msg.contains("withdrawn")) }
        else { XCTFail("expected .failed") }
    }

    func testAlreadyBound409() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ServiceAccessError.inviteAlreadyBound
        let vm = makeVM(mock, authorAidHex: authorAid)
        await vm.redeem()
        if case .failed(let msg) = vm.phase { XCTAssertTrue(msg.contains("another account")) }
        else { XCTFail("expected .failed") }
    }

    func testExpiredOrFull410() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ServiceAccessError.inviteExpiredOrFull
        let vm = makeVM(mock, authorAidHex: authorAid)
        await vm.redeem()
        if case .failed(let msg) = vm.phase { XCTAssertTrue(msg.contains("expired") || msg.contains("full")) }
        else { XCTFail("expected .failed") }
    }

    func testMalformedSecretRejectedBeforeNetwork() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, secret: "notahexsecret", authorAidHex: authorAid)
        await vm.redeem()
        if case .failed = vm.phase {} else { XCTFail("expected .failed") }
        XCTAssertTrue(mock.redeemCalls.isEmpty)
    }
}
