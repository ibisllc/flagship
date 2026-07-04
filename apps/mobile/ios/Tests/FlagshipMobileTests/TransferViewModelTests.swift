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
            signer: { _ in giver }, now: { 1700 }, hasAdminRoot: { false }
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
        // The QR is rendered as the universal link (Slice C); parseScanned
        // decodes the `o=` param back to a transfer offer.
        XCTAssertTrue(vm.qrText!.contains("/transfer?o="))
        let qr = try! ServerTransferFlow.parseScanned(vm.qrText!)
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
            signer: { _ in giver }, now: { 1700 }, hasAdminRoot: { false }
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
        // No admin root on the giver device ⇒ legacy account: NO §9.8 admin
        // hand-off, but the LEGACY re-home authorization (v1-sec GAP 3) IS
        // deposited so the box (pinning the giver owner IRK) will re-home.
        XCTAssertEqual(client.adminHandoffs.count, 0)
        XCTAssertEqual(client.rehomeAuths.count, 1)
    }

    /// v1-sec GAP 3 — a legacy giver (no admin root) deposits a re-home
    /// authorization the box verifies against its PINNED owner IRK before
    /// re-homing. The Face ID that derived the IRK EMITS the signature.
    func testGiverLegacyPostsBoxVerifiableRehomeAuth() async {
        let giver = key(11)
        let acquirer = key(22)
        let client = MockServerTransferClient()
        client.scriptedPoll = TransferClaimPoll(
            newServerDomain: "home.bob.flagship.services",
            acquirerUsername: "bob",
            acquirerIrkPub: HexUtil.encode(acquirer.publicKey.rawRepresentation)
        )
        let vm = TransferGiverViewModel(
            client: client, mailbox: MockSecretMailboxClient(), serverDomain: host,
            username: "alice", signer: { _ in giver }, now: { 1700 }, hasAdminRoot: { false }
        )
        await vm.start()
        let done = await vm.pollOnce()

        XCTAssertTrue(done)
        XCTAssertEqual(vm.phase, .completed(newServerDomain: "home.bob.flagship.services"))
        XCTAssertEqual(client.adminHandoffs.count, 0)
        XCTAssertEqual(client.rehomeAuths.count, 1)
        // Deposited against the box's OLD canonical; issuedAt from `now`.
        XCTAssertEqual(client.rehomeAuths[0].serverDomain, host)
        let body = client.rehomeAuths[0].body
        XCTAssertEqual(body.issuedAt, 1700)
        // The box re-verifies the SAME canonical (old + new domain + acquirer IRK)
        // against its pinned owner IRK (== the giver's).
        let order = RehomeAuthorizationOrder(
            oldServerDomain: host,
            newServerDomain: "home.bob.flagship.services",
            acquirerIrkPubHex: HexUtil.encode(acquirer.publicKey.rawRepresentation),
            issuedAt: 1700
        )
        let sig = HexUtil.decode(body.signatureHex)!
        XCTAssertTrue(order.verify(signature: sig, giverIrkPub: giver.publicKey.rawRepresentation))
    }

    /// §9.8 — a giver holding the admin master root deposits a hand-off proof
    /// carrying the claim poll's acquirer values, bound to the offer's nonce,
    /// and signed by the giver root (the box's pinned anchor).
    func testGiverWithAdminRootPostsSignedHandoff() async {
        let giver = key(11)
        let giverRoot = key(33)
        let acquirer = key(22)
        let acquirerRootHex = String(repeating: "ef", count: 32)
        let client = MockServerTransferClient()
        client.scriptedPoll = TransferClaimPoll(
            newServerDomain: "home.bob.flagship.services",
            acquirerUsername: "bob",
            acquirerIrkPub: HexUtil.encode(acquirer.publicKey.rawRepresentation),
            acquirerAdminRootPub: acquirerRootHex
        )
        let vm = TransferGiverViewModel(
            client: client, mailbox: MockSecretMailboxClient(), serverDomain: host,
            username: "alice", signer: { _ in giver }, now: { 1700 },
            hasAdminRoot: { true }, adminRootKey: { _ in giverRoot }
        )
        await vm.start()
        let done = await vm.pollOnce()

        XCTAssertTrue(done)
        XCTAssertEqual(vm.phase, .completed(newServerDomain: "home.bob.flagship.services"))
        XCTAssertEqual(client.adminHandoffs.count, 1)
        let body = client.adminHandoffs[0].body
        // Deposited against the box's OLD canonical.
        XCTAssertEqual(client.adminHandoffs[0].serverDomain, host)
        XCTAssertEqual(body.handoff.serverDomain, host)
        XCTAssertEqual(body.handoff.giverUsername, "alice")
        XCTAssertEqual(body.handoff.acquirerUsername, "bob")
        XCTAssertEqual(body.handoff.oldAdminRootPub, HexUtil.encode(giverRoot.publicKey.rawRepresentation))
        XCTAssertEqual(body.handoff.newAdminRootPub, acquirerRootHex)
        // Bound to THIS transfer: the nonce the offer was minted with.
        XCTAssertEqual(body.handoff.transferNonce, client.offers[0].body.offer.transferNonce)
        // The proof verifies under the GIVER admin root over the canonical bytes.
        let h = AdminRootTransfer(
            serverDomain: body.handoff.serverDomain,
            giverUsername: body.handoff.giverUsername,
            acquirerUsername: body.handoff.acquirerUsername,
            oldAdminRootPubHex: body.handoff.oldAdminRootPub,
            newAdminRootPubHex: body.handoff.newAdminRootPub,
            transferNonce: body.handoff.transferNonce,
            issuedAt: body.handoff.issuedAt
        )
        let sig = HexUtil.decode(body.signatureHex)!
        XCTAssertTrue(h.verify(signature: sig, giverAdminRootPub: giverRoot.publicKey.rawRepresentation))
    }

    /// An acquirer with no admin root ("" / nil on the poll) yields an UNPIN
    /// hand-off: newAdminRootPub is the empty string.
    func testGiverHandoffEmptyAcquirerRootMeansUnpin() async {
        let giver = key(11)
        let giverRoot = key(33)
        let acquirer = key(22)
        let client = MockServerTransferClient()
        client.scriptedPoll = TransferClaimPoll(
            newServerDomain: "home.bob.flagship.services",
            acquirerUsername: "bob",
            acquirerIrkPub: HexUtil.encode(acquirer.publicKey.rawRepresentation),
            acquirerAdminRootPub: nil
        )
        let vm = TransferGiverViewModel(
            client: client, mailbox: MockSecretMailboxClient(), serverDomain: host,
            username: "alice", signer: { _ in giver }, now: { 1700 },
            hasAdminRoot: { true }, adminRootKey: { _ in giverRoot }
        )
        await vm.start()
        _ = await vm.pollOnce()

        XCTAssertEqual(client.adminHandoffs.count, 1)
        XCTAssertEqual(client.adminHandoffs[0].body.handoff.newAdminRootPub, "")
        XCTAssertEqual(vm.phase, .completed(newServerDomain: "home.bob.flagship.services"))
    }

    /// A hand-off deposit failure degrades exactly like a re-seal failure:
    /// ownership already moved, so the phase is the retryable warning — and the
    /// disk-key re-seal that already landed is unaffected.
    func testGiverHandoffDepositFailureDegradesButReSealStands() async {
        let giver = key(11)
        let giverRoot = key(33)
        let acquirer = key(22)
        let diskKey = Data(repeating: 0x42, count: 32)
        let sealedForGiver = try! SecretSeal.sealForEd25519Recipient(
            plaintext: diskKey, recipientEd25519Pub: giver.publicKey.rawRepresentation
        )
        let client = MockServerTransferClient()
        client.scriptedPoll = TransferClaimPoll(
            newServerDomain: "home.bob.flagship.services",
            acquirerUsername: "bob",
            acquirerIrkPub: HexUtil.encode(acquirer.publicKey.rawRepresentation),
            acquirerAdminRootPub: String(repeating: "ef", count: 32)
        )
        client.adminHandoffError = ScreensClientError.http(status: 500, message: "boom")
        let mailbox = MockSecretMailboxClient()
        mailbox.sealedLuksKeyHex = HexUtil.encode(sealedForGiver)

        let vm = TransferGiverViewModel(
            client: client, mailbox: mailbox, serverDomain: host, username: "alice",
            signer: { _ in giver }, now: { 1700 },
            hasAdminRoot: { true }, adminRootKey: { _ in giverRoot }
        )
        await vm.start()
        let done = await vm.pollOnce()

        XCTAssertTrue(done)
        // The disk-key re-seal already landed and stands.
        XCTAssertEqual(client.diskKeyDeposits.count, 1)
        guard case .failed(let message) = vm.phase else {
            return XCTFail("expected degraded .failed; phase=\(vm.phase)")
        }
        XCTAssertTrue(message.contains("Ownership moved"))
        XCTAssertTrue(message.contains("wait for this hand-off before re-homing"))
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
            client: client, username: "Bob", signer: { _ in acquirer }, now: { 1800 },
            adminRootPubHex: { nil }
        )
        XCTAssertTrue(vm.ingest(qrText))
        await vm.confirm()

        XCTAssertEqual(vm.phase, .claimed(newServerDomain: host))
        XCTAssertEqual(client.claims.count, 1)
        let body = client.claims[0].body
        XCTAssertEqual(body.claim.acquirerUsername, "bob")
        // No admin root ⇒ the v2 canonical's admin slot is the EMPTY string.
        XCTAssertEqual(body.claim.acquirerAdminRootPub, "")
        let order = ServerTransferClaimOrder(
            serverDomain: host, transferNonce: body.claim.transferNonce,
            acquirerUsername: "bob", acquirerIrkPubHex: body.claim.acquirerIrkPub,
            acquirerAdminRootPubHex: "", issuedAt: 1800
        )
        let sig = HexUtil.decode(body.claimSignature)!
        XCTAssertTrue(acquirer.publicKey.isValidSignature(sig, for: order.canonicalBytes()))
    }

    /// §9.8 — the claim commits to the acquirer's admin root pub INSIDE the v2
    /// signed canonical (byte-vector-checked), so `.com` can't substitute the
    /// anchor the box re-pins.
    func testAcquirerClaimCarriesAdminRootPubUnderV2Bytes() async {
        let giver = key(11)
        let acquirer = key(22)
        let adminHex = String(repeating: "ef", count: 32)
        let nonce = String(repeating: "ab", count: 32)
        let (_, qr) = try! ServerTransferFlow.buildOffer(
            serverDomain: host, username: "alice", irk: giver,
            issuedAt: 1, ttlMs: 9_999_999_999_999, nonce: Data(repeating: 0xab, count: 32),
            authNonce: Data(repeating: 0x01, count: 32)
        )
        let client = MockServerTransferClient()
        let vm = TransferAcquirerViewModel(
            client: client, username: "Bob", signer: { _ in acquirer }, now: { 1800 },
            adminRootPubHex: { adminHex }
        )
        XCTAssertTrue(vm.ingest(try! ServerTransferFlow.encodeQR(qr)))
        await vm.confirm()

        XCTAssertEqual(client.claims.count, 1)
        let body = client.claims[0].body
        XCTAssertEqual(body.claim.acquirerAdminRootPub, adminHex)
        // Vector-check the EXACT v2 canonical the signature covers.
        let irkHex = HexUtil.encode(acquirer.publicKey.rawRepresentation)
        let expected = "flagship/server-transfer-claim/v2|\(host)|\(nonce)|bob|\(irkHex)|\(adminHex)|1800"
        let order = ServerTransferClaimOrder(
            serverDomain: host, transferNonce: body.claim.transferNonce,
            acquirerUsername: "bob", acquirerIrkPubHex: irkHex,
            acquirerAdminRootPubHex: adminHex, issuedAt: 1800
        )
        XCTAssertEqual(String(data: order.canonicalBytes(), encoding: .utf8), expected)
        let sig = HexUtil.decode(body.claimSignature)!
        XCTAssertTrue(acquirer.publicKey.isValidSignature(sig, for: Data(expected.utf8)))
    }

    func testAcquirerRejectsNonTransferQR() {
        let vm = TransferAcquirerViewModel(client: MockServerTransferClient(), username: "bob", signer: { _ in self.key(1) })
        XCTAssertFalse(vm.ingest("garbage"))
        if case .failed = vm.phase {} else { XCTFail("expected .failed") }
    }

    /// Slice C security gate — a well-formed but FORGED offer (signed by an
    /// attacker, not the advertised giverIrkPub) must be refused on ingest, with
    /// no `.scanned` confirm ever surfaced and no claim built.
    func testAcquirerRefusesForgedOffer() async {
        let giver = key(11)
        let attacker = key(99)
        let issuedAt: Int64 = 1, expiresAt: Int64 = 9_999_999_999_999
        let order = ServerTransferOfferOrder(
            serverDomain: host, transferNonce: String(repeating: "ab", count: 32),
            issuedAt: issuedAt, expiresAt: expiresAt
        )
        let forgedSig = try! order.sign(with: attacker)
        let forged = ServerTransferFlow.OfferQR(
            serverDomain: host, transferNonce: String(repeating: "ab", count: 32),
            giverIrkPub: HexUtil.encode(giver.publicKey.rawRepresentation),
            issuedAt: issuedAt, expiresAt: expiresAt,
            offerSignature: HexUtil.encode(forgedSig)
        )
        let client = MockServerTransferClient()
        let vm = TransferAcquirerViewModel(client: client, username: "bob", signer: { _ in attacker }, now: { 1800 })

        XCTAssertFalse(vm.ingest(try! ServerTransferFlow.encodeQR(forged)))
        if case .failed = vm.phase {} else { XCTFail("expected .failed on forged offer") }
        XCTAssertNil(vm.offer)

        // Even if confirm() is somehow reached, it re-verifies and never posts.
        await vm.confirm()
        XCTAssertEqual(client.claims.count, 0)
    }

    // MARK: - §9.8 canonical vectors (must match the TS spine byte-for-byte)

    /// Fixed-input vector for the hand-off canonical, mirroring the
    /// AdminRootRotation vector style: tag | serverDomain | giverUsername |
    /// acquirerUsername | oldPub | newPub-or-"" | transferNonce | issuedAt,
    /// all string fields lowercased.
    func testAdminRootTransferCanonicalBytesVector() {
        let nonce = String(repeating: "ab", count: 32)
        let old = String(repeating: "aa", count: 32)
        let new = String(repeating: "BB", count: 32)
        let h = AdminRootTransfer(
            serverDomain: "HOME.alice.flagship.services", giverUsername: "Alice",
            acquirerUsername: "Bob", oldAdminRootPubHex: old, newAdminRootPubHex: new,
            transferNonce: nonce, issuedAt: 1_700_000_000_000
        )
        let expected = "flagship/admin-root-transfer/v1|home.alice.flagship.services|alice|bob|"
            + old + "|" + String(repeating: "bb", count: 32) + "|" + nonce + "|1700000000000"
        XCTAssertEqual(h.canonicalBytes(), Data(expected.utf8))

        let unpin = AdminRootTransfer(
            serverDomain: "home.alice.flagship.services", giverUsername: "alice",
            acquirerUsername: "bob", oldAdminRootPubHex: old, newAdminRootPubHex: "",
            transferNonce: nonce, issuedAt: 42
        )
        XCTAssertEqual(
            unpin.canonicalBytes(),
            Data(("flagship/admin-root-transfer/v1|home.alice.flagship.services|alice|bob|" + old + "||" + nonce + "|42").utf8)
        )
    }

    /// Fixed-input vector for the v2 claim canonical — the admin-root slot sits
    /// between the IRK pub and issuedAt, EMPTY when the acquirer has no root.
    func testServerTransferClaimV2CanonicalBytesVector() {
        let nonce = String(repeating: "ab", count: 32)
        let irkHex = String(repeating: "cd", count: 32)
        let adminHex = String(repeating: "ef", count: 32)
        let with = ServerTransferClaimOrder(
            serverDomain: "home.alice.flagship.services", transferNonce: nonce,
            acquirerUsername: "Bob", acquirerIrkPubHex: irkHex,
            acquirerAdminRootPubHex: adminHex, issuedAt: 1800
        )
        XCTAssertEqual(
            with.canonicalBytes(),
            Data("flagship/server-transfer-claim/v2|home.alice.flagship.services|\(nonce)|bob|\(irkHex)|\(adminHex)|1800".utf8)
        )
        let without = ServerTransferClaimOrder(
            serverDomain: "home.alice.flagship.services", transferNonce: nonce,
            acquirerUsername: "bob", acquirerIrkPubHex: irkHex,
            acquirerAdminRootPubHex: "", issuedAt: 1800
        )
        XCTAssertEqual(
            without.canonicalBytes(),
            Data("flagship/server-transfer-claim/v2|home.alice.flagship.services|\(nonce)|bob|\(irkHex)||1800".utf8)
        )
    }

    /// An expired offer is refused on ingest too.
    func testAcquirerRefusesExpiredOffer() {
        let giver = key(11)
        let (_, qr) = try! ServerTransferFlow.buildOffer(
            serverDomain: host, username: "alice", irk: giver,
            issuedAt: 1_000, ttlMs: 5_000, nonce: Data(repeating: 0xab, count: 32),
            authNonce: Data(repeating: 0x01, count: 32)
        )
        let vm = TransferAcquirerViewModel(client: MockServerTransferClient(), username: "bob", signer: { _ in giver }, now: { 1_000_000 })
        XCTAssertFalse(vm.ingest(try! ServerTransferFlow.encodeQR(qr)))
        if case .failed = vm.phase {} else { XCTFail("expected .failed on expired offer") }
    }
}
