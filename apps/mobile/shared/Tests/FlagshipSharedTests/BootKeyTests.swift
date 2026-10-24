import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipAPI

/// Pins `BootKey` to packages/protocol/test-vectors/boot-key/vectors.json (also
/// read by the TS reference and the webapp), and checks that disk-key replies
/// and leases go to the boot key only when the pinned STK vouched for it.
final class BootKeyVectorTests: XCTestCase {
    static func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/boot-key/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    static func wire(_ any: Any?) throws -> BootKeyBindingWire {
        let data = try JSONSerialization.data(withJSONObject: try XCTUnwrap(any))
        return try JSONDecoder().decode(BootKeyBindingWire.self, from: data)
    }

    func testBindingCasesMatchTheVectors() throws {
        let v = try Self.vectors()
        let b = try XCTUnwrap(v["binding"] as? [String: Any])
        let cases = try XCTUnwrap(b["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let expect = try XCTUnwrap(c["expect"] as? [String: Any])
            let got = BootKey.verified(try Self.wire(c["wire"]), serverDomain: expect["serverDomain"] as! String,
                                       stkPubHex: expect["stkPubHex"] as! String)
            XCTAssertEqual(got, c["bootKeyPubHex"] as? String, c["name"] as? String ?? "")
        }
    }

    func testOwnerAdoptsOnlyUnderThePinnedStk() async throws {
        let v = try Self.vectors()
        let domain = v["serverDomain"] as! String
        let b = try XCTUnwrap(v["binding"] as? [String: Any])
        let mailbox = MockSecretMailboxClient()
        mailbox.bootKeyBindings[domain] = try Self.wire(b["wire"])
        let pins = BoxKeyPins(defaults: nil)

        var got = await BootKey.forServer(username: "alice", serverDomain: domain, mailbox: mailbox, pins: pins)
        XCTAssertNil(got, "nothing pinned yet")

        pins.repin(username: "alice", serverDomain: domain, stkHex: v["otherStkPubHex"] as! String)
        got = await BootKey.forServer(username: "alice", serverDomain: domain, mailbox: mailbox, pins: pins)
        XCTAssertNil(got, "signed by a key other than the pinned STK")

        pins.repin(username: "alice", serverDomain: domain, stkHex: v["stkPubHex"] as! String)
        got = await BootKey.forServer(username: "alice", serverDomain: domain, mailbox: mailbox, pins: pins)
        XCTAssertEqual(got, v["bootKeyPubHex"] as? String)

        mailbox.bootKeyBindings = [:]
        got = await BootKey.forServer(username: "alice", serverDomain: domain, mailbox: mailbox, pins: pins)
        XCTAssertEqual(got, v["bootKeyPubHex"] as? String, "the pinned boot key survives a 404")
    }

    func testSharedServerVerifiesAgainstTheOfferStk() async throws {
        let v = try Self.vectors()
        let domain = v["serverDomain"] as! String
        let w = try Self.wire((v["binding"] as? [String: Any])?["wire"])
        let ok = await BootKey.forSharedServer(serverDomain: domain, pinnedStkHex: v["stkPubHex"] as! String) { w }
        XCTAssertEqual(ok, v["bootKeyPubHex"] as? String)
        let other = await BootKey.forSharedServer(serverDomain: domain, pinnedStkHex: v["otherStkPubHex"] as! String) { w }
        XCTAssertNil(other)
        let failed = await BootKey.forSharedServer(serverDomain: domain, pinnedStkHex: v["stkPubHex"] as! String) {
            throw URLError(.notConnectedToInternet)
        }
        XCTAssertNil(failed)
    }
}

@MainActor
final class BootKeyCoordinatorTests: XCTestCase {
    private let user = "alice"
    private let unsealSeed = Data(repeating: 0x0a, count: 32)
    private let luks = Data((0..<64).map { UInt8($0) })

    private struct Fixture {
        let domain: String
        let stk: Curve25519.Signing.PrivateKey
        let boot: Curve25519.Signing.PrivateKey
        let wire: BootKeyBindingWire
    }

    private func fixture() throws -> Fixture {
        let v = try BootKeyVectorTests.vectors()
        let stk = try Curve25519.Signing.PrivateKey(rawRepresentation: XCTUnwrap(HexUtil.decode(v["stkSeedHex"] as! String)))
        let boot = try Curve25519.Signing.PrivateKey(rawRepresentation: XCTUnwrap(HexUtil.decode(v["bootKeySeedHex"] as! String)))
        XCTAssertEqual(HexUtil.encode(boot.publicKey.rawRepresentation), v["bootKeyPubHex"] as? String)
        return Fixture(domain: v["serverDomain"] as! String, stk: stk, boot: boot,
                       wire: try BootKeyVectorTests.wire((v["binding"] as? [String: Any])?["wire"]))
    }

    private func pending(_ purpose: SecretPurpose, signer: Curve25519.Signing.PrivateKey, domain: String) throws -> PendingSecretRequest {
        let nonce = Data(repeating: 0x33, count: 32)
        let req = SecretRequest(serverDomain: domain, stkPub: signer.publicKey.rawRepresentation,
                                purpose: purpose, nonce: nonce, issuedAt: 1_700_000_000_000)
        let sig = try signer.signature(for: req.canonicalBytes())
        return PendingSecretRequest(
            serverDomain: domain, requestNonceHex: HexUtil.encode(nonce),
            stkPub: HexUtil.encode(signer.publicKey.rawRepresentation), purpose: purpose.rawValue,
            issuedAt: req.issuedAt, requestSignature: HexUtil.encode(sig),
            deviceInfo: nil, postedAt: 1, expiresAt: .max)
    }

    private func world(_ f: Fixture) throws -> (MockSecretMailboxClient, SecretRequestCoordinator) {
        let mailbox = MockSecretMailboxClient()
        mailbox.directory = [PodDirectoryEntry(serverDomain: f.domain, identityPubKey: HexUtil.encode(f.stk.publicKey.rawRepresentation))]
        let unsealPub = try Curve25519.Signing.PrivateKey(rawRepresentation: unsealSeed).publicKey.rawRepresentation
        mailbox.sealedLuksKeyHex = HexUtil.encode(try SecretSeal.sealForEd25519Recipient(plaintext: luks, recipientEd25519Pub: unsealPub))
        let coord = SecretRequestCoordinator(
            mailbox: mailbox, username: user,
            irkProvider: { try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x07, count: 32)) },
            unsealSeedProvider: { _ in [self.unsealSeed] },
            now: { 1_700_000_000_500 },
            firstContactSecrets: InMemoryFirstContactSecrets(),
            pins: BoxKeyPins(defaults: nil))
        return (mailbox, coord)
    }

    private func openedSecret(_ sealedHex: String, seed: Data) throws -> Data {
        let opened = try SecretSeal.openWithEd25519Seed(blob: XCTUnwrap(HexUtil.decode(sealedHex)), recipientEd25519Seed: seed)
        let len = Int(opened[0]) << 24 | Int(opened[1]) << 16 | Int(opened[2]) << 8 | Int(opened[3])
        return opened.subdata(in: (4 + len)..<opened.count)
    }

    func testABootKeySignedUnlockIsSealedToTheBootKey() async throws {
        let f = try fixture()
        let (mailbox, coord) = try world(f)
        mailbox.bootKeyBindings[f.domain] = f.wire
        mailbox.pending = [try pending(.unlockKey, signer: f.boot, domain: f.domain)]

        let verified = try await coord.fetchVerifiedRequests()
        XCTAssertEqual(verified.count, 1)
        let bootHex = HexUtil.encode(f.boot.publicKey.rawRepresentation)
        XCTAssertEqual(verified.first?.recipientPubHex, bootHex)

        let leaseId = try await coord.confirmAndRespond(try XCTUnwrap(verified.first), depositAutoLease: true)
        XCTAssertNotNil(leaseId)
        let reply = try XCTUnwrap(mailbox.postedResponses.first?.response)
        XCTAssertEqual(try openedSecret(reply.sealed, seed: f.boot.rawRepresentation), luks)
        XCTAssertThrowsError(try openedSecret(reply.sealed, seed: f.stk.rawRepresentation))

        let lease = try XCTUnwrap(mailbox.deposited.first?.lease)
        XCTAssertEqual(lease.stkPub, bootHex)
        XCTAssertEqual(try SecretSeal.openWithEd25519Seed(blob: XCTUnwrap(HexUtil.decode(lease.sealedKey)),
                                                         recipientEd25519Seed: f.boot.rawRepresentation), luks)
        XCTAssertEqual(mailbox.entitlementDeposits.first?.body.deposit.stkPub,
                       HexUtil.encode(f.stk.publicKey.rawRepresentation), "the entitlement still names the STK")
    }

    func testABindingSignedByAnotherKeyIsIgnored() async throws {
        let f = try fixture()
        let (mailbox, coord) = try world(f)
        let rogue = Curve25519.Signing.PrivateKey()
        let b = f.wire.binding
        let msg = try XCTUnwrap(BoxKeyPins.canonicalBootKeyBinding(serverDomain: b.serverDomain, bootPubHex: b.bootPubHex, issuedAt: b.issuedAt))
        mailbox.bootKeyBindings[f.domain] = BootKeyBindingWire(binding: b, signature: HexUtil.encode(try rogue.signature(for: msg)))
        mailbox.pending = [try pending(.unlockKey, signer: f.boot, domain: f.domain),
                           try pending(.unlockKey, signer: f.stk, domain: f.domain)]

        let verified = try await coord.fetchVerifiedRequests()
        XCTAssertEqual(verified.count, 1, "the boot-key request is dropped")
        XCTAssertNil(verified.first?.recipientPubHex)
        try await coord.confirmAndRespond(try XCTUnwrap(verified.first), depositAutoLease: true)
        let reply = try XCTUnwrap(mailbox.postedResponses.first?.response)
        XCTAssertEqual(try openedSecret(reply.sealed, seed: f.stk.rawRepresentation), luks)
        XCTAssertEqual(mailbox.deposited.first?.lease.stkPub, HexUtil.encode(f.stk.publicKey.rawRepresentation))
    }

    func testOnlyADiskUnlockMayComeFromTheBootKey() async throws {
        let f = try fixture()
        let (mailbox, coord) = try world(f)
        mailbox.bootKeyBindings[f.domain] = f.wire
        mailbox.pending = [try pending(.entitlement, signer: f.boot, domain: f.domain)]
        let verified = try await coord.fetchVerifiedRequests()
        XCTAssertTrue(verified.isEmpty)
    }

    func testAShareStartupFromTheVouchedBootKeyVerifies() throws {
        let f = try fixture()
        let stkHex = HexUtil.encode(f.stk.publicKey.rawRepresentation)
        let bootHex = HexUtil.encode(f.boot.publicKey.rawRepresentation)
        let p = try pending(.unlockKey, signer: f.boot, domain: f.domain)
        let row = ShareBootPending(
            request: .init(serverDomain: f.domain, stkPub: p.stkPub, purpose: p.purpose, nonce: p.requestNonceHex, issuedAt: p.issuedAt),
            signature: p.requestSignature, postedAt: 1, expiresAt: nil)
        XCTAssertTrue(ServerShareMemberFlow.verifiedStartups([row], serverDomain: f.domain, stkPubHex: stkHex, now: 0).isEmpty)
        let ok = ServerShareMemberFlow.verifiedStartups([row], serverDomain: f.domain, stkPubHex: stkHex, bootPubHex: bootHex, now: 0)
        XCTAssertEqual(ok.first?.request.stkPub, f.boot.publicKey.rawRepresentation)
        let reply = try SealedSecretResponse.build(secret: luks, request: try XCTUnwrap(ok.first).request)
        XCTAssertEqual(try openedSecret(HexUtil.encode(reply.sealed), seed: f.boot.rawRepresentation), luks)
    }
}
