import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// Transfer-a-box VM logic (Layer C). Drives the giver + acquirer VMs against
/// MockServerTransferClient + MockSecretMailboxClient, asserting the signed wire
/// bodies the broker accepts and the phase machine.
@MainActor
final class TransferViewModelTests: XCTestCase {
    private let host = "home.alice.flagship.services"
    private func key(_ b: UInt8) -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: b, count: 32))
    }

    func testGiverStartSignsOffersAndExposesQR() async {
        let giver = key(11)
        let client = MockServerTransferClient()
        let mailbox = MockSecretMailboxClient()
        let vm = TransferGiverViewModel(
            client: client, mailbox: mailbox, serverDomain: host, username: "alice",
            signer: { _ in giver }, now: { 1700 }
        )
        await vm.start()

        XCTAssertEqual(vm.phase, .awaitingClaim)
        XCTAssertNotNil(vm.qrText)
        XCTAssertEqual(client.offers.count, 1)
        // The offer signature verifies under the giver IRK over the canonical bytes.
        let body = client.offers[0].body
        let order = ServerTransferOfferOrder(
            serverDomain: host, transferNonce: body.offer.transferNonce,
            issuedAt: body.offer.issuedAt, expiresAt: body.offer.expiresAt
        )
        let sig = HexUtil.decode(body.offerSignature)!
        XCTAssertTrue(giver.publicKey.isValidSignature(sig, for: order.canonicalBytes()))
        // The QR parses back to a transfer offer.
        let qr = try! ServerTransferFlow.parseQR(vm.qrText!)
        XCTAssertEqual(qr.serverDomain, host)
    }

    func testGiverPollResealsDiskKeyOnClaim() async {
        let giver = key(11)
        let acquirer = key(22)
        // The box's disk key, sealed FOR the giver IRK at install time.
        let diskKey = Data(repeating: 0x42, count: 32)
        let sealedForGiver = try! SecretSeal.sealForEd25519Recipient(
            plaintext: diskKey, recipientEd25519Pub: giver.publicKey.rawRepresentation
        )
        let client = MockServerTransferClient()
        client.scriptedPoll = TransferClaimPoll(
            newServerDomain: "home.bob.flagship.services",
            acquirerUsername: "bob",
            acquirerIrkPub: HexUtil.encode(acquirer.publicKey.rawRepresentation)
        )
        let mailbox = MockSecretMailboxClient()
        mailbox.sealedLuksKeyHex = HexUtil.encode(sealedForGiver)

        let vm = TransferGiverViewModel(
            client: client, mailbox: mailbox, serverDomain: host, username: "alice",
            signer: { _ in giver }, now: { 1700 }
        )
        await vm.start()
        let done = await vm.pollOnce()

        XCTAssertTrue(done)
        XCTAssertEqual(vm.phase, .completed(newServerDomain: "home.bob.flagship.services"))
        XCTAssertEqual(client.diskKeyDeposits.count, 1)
        // The deposited blob opens with the ACQUIRER IRK and yields the disk key.
        let sealedHex = client.diskKeyDeposits[0].body.sealedDiskKey
        let opened = try! ServerTransferFlow.openDiskKey(sealedHex: sealedHex, acquirerIrk: acquirer)
        XCTAssertEqual(opened, diskKey)
    }

    func testAcquirerIngestThenClaimSignsUnderAcquirerIrk() async {
        let giver = key(11)
        let acquirer = key(22)
        // Build a real QR via the giver flow.
        let (_, qr) = try! ServerTransferFlow.buildOffer(
            serverDomain: host, username: "alice", irk: giver,
            issuedAt: 1, ttlMs: 9_999_999_999_999, nonce: Data(repeating: 0xab, count: 32),
            authNonce: Data(repeating: 0x01, count: 32)
        )
        let qrText = try! ServerTransferFlow.encodeQR(qr)

        let client = MockServerTransferClient()
        let vm = TransferAcquirerViewModel(
            client: client, username: "Bob", signer: { _ in acquirer }, now: { 1800 }
        )
        XCTAssertTrue(vm.ingest(qrText))
        await vm.confirm()

        XCTAssertEqual(vm.phase, .claimed(newServerDomain: host))
        XCTAssertEqual(client.claims.count, 1)
        let body = client.claims[0].body
        XCTAssertEqual(body.claim.acquirerUsername, "bob")
        let order = ServerTransferClaimOrder(
            serverDomain: host, transferNonce: body.claim.transferNonce,
            acquirerUsername: "bob", acquirerIrkPubHex: body.claim.acquirerIrkPub, issuedAt: 1800
        )
        let sig = HexUtil.decode(body.claimSignature)!
        XCTAssertTrue(acquirer.publicKey.isValidSignature(sig, for: order.canonicalBytes()))
    }

    func testAcquirerRejectsNonTransferQR() {
        let vm = TransferAcquirerViewModel(client: MockServerTransferClient(), username: "bob", signer: { _ in self.key(1) })
        XCTAssertFalse(vm.ingest("garbage"))
        if case .failed = vm.phase {} else { XCTFail("expected .failed") }
    }
}
