import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore

/// End-to-end-ish tests for the phone's relay coordinator against a mock
/// `.com` mailbox. Proves: directory re-verification drops a foreign STK;
/// the unlock-key reply round-trips against the box's STK; the entitlement
/// carrier matches the daemon's EntitlementBundle format.
final class SecretRequestCoordinatorTests: XCTestCase {

    // A deterministic mock mailbox capturing the posted reply.
    final class MockMailbox: SecretMailboxClient, @unchecked Sendable {
        var pending: [PendingSecretRequest] = []
        var directory: [PodDirectoryEntry] = []
        var sealedLuksKeyHex: String?
        var lastPostedAuth: MailboxAuthEnvelope?
        var lastPostedResponse: SecretResponseBody?
        var deposited: [(lease: BoxSealedLeaseWire, signatureHex: String)] = []
        var revoked: [(request: LeaseRevokeWire, signatureHex: String)] = []
        let username: String
        init(username: String) { self.username = username }

        func fetchPendingRequests(auth: MailboxAuthEnvelope) async throws -> SecretRequestsResponse {
            lastPostedAuth = auth
            return SecretRequestsResponse(username: username, requests: pending)
        }
        func postResponse(auth: MailboxAuthEnvelope, response: SecretResponseBody) async throws {
            lastPostedAuth = auth
            lastPostedResponse = response
        }
        func fetchSealedLuksKey(serverDomain: String) async throws -> SealedLuksKeyResponse {
            guard let hex = sealedLuksKeyHex else {
                throw ScreensClientError.http(status: 404, message: "no sealed key on file")
            }
            return SealedLuksKeyResponse(serverDomain: serverDomain, sealedKey: hex, sealedAt: 1)
        }
        func fetchPods(username: String) async throws -> PodsDirectoryResponse {
            PodsDirectoryResponse(username: username, pods: directory)
        }
        func depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String) async throws {
            deposited.append((lease, signatureHex))
        }
        func revokeBoxSealedLease(request: LeaseRevokeWire, signatureHex: String) async throws {
            revoked.append((request, signatureHex))
        }
    }

    // Fixtures: a phone IRK, a box STK, and a phone unseal key.
    private let username = "alice"
    private func phoneIrk() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x01, count: 32))
    }
    // The box STK seed (all-0x07) — its X25519 secret is known from vectors.
    private let stkSeed = Data(repeating: 0x07, count: 32)
    private func boxStk() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: stkSeed)
    }
    private let stkX25519Priv = HexUtil.decode("28ad39fefd7fa3e200a9c626eef599e61a2d055c48a8288a4e7e4c4bca392878")!
    // The phone's LUKS-unseal key (the installer seals against THIS pub).
    private let unsealSeed = Data(repeating: 0x0a, count: 32)

    private func makeBoxRequest(purpose: SecretPurpose, nonce: Data, domain: String) -> (PendingSecretRequest, SecretRequest) {
        let stk = boxStk()
        let request = SecretRequest(
            serverDomain: domain, stkPub: stk.publicKey.rawRepresentation,
            purpose: purpose, nonce: nonce, issuedAt: 1_700_000_000_000
        )
        let sig = try! stk.signature(for: request.canonicalBytes())
        let pending = PendingSecretRequest(
            serverDomain: domain,
            requestNonceHex: HexUtil.encode(nonce),
            stkPub: HexUtil.encode(stk.publicKey.rawRepresentation),
            purpose: purpose.rawValue,
            issuedAt: request.issuedAt,
            requestSignature: HexUtil.encode(sig),
            deviceInfo: DeviceInfoHint(ip: "203.0.113.7", region: "fsn1", os: "Alpine 3.20"),
            postedAt: 1, expiresAt: 1_700_000_300_000
        )
        return (pending, request)
    }

    @MainActor
    private func makeCoordinator(_ mailbox: MockMailbox) -> SecretRequestCoordinator {
        SecretRequestCoordinator(
            mailbox: mailbox,
            username: username,
            irkProvider: { self.phoneIrk() },
            unsealSeedProvider: { _ in [self.unsealSeed] },
            now: { 999 },
            nonceGen: { Data(repeating: 0xaa, count: 32) }
        )
    }

    // MARK: - re-verify against directory

    @MainActor
    func testRejectsRequestNotInDirectory() async throws {
        let mailbox = MockMailbox(username: username)
        let (pending, _) = makeBoxRequest(purpose: .unlockKey, nonce: Data(repeating: 0x33, count: 32), domain: "home.alice.flagship.services")
        mailbox.pending = [pending]
        mailbox.directory = []   // box not registered
        let coord = makeCoordinator(mailbox)
        let verified = try await coord.fetchVerifiedRequests()
        XCTAssertTrue(verified.isEmpty)
    }

    @MainActor
    func testRejectsForeignDirectoryStk() async throws {
        let mailbox = MockMailbox(username: username)
        let (pending, _) = makeBoxRequest(purpose: .unlockKey, nonce: Data(repeating: 0x33, count: 32), domain: "home.alice.flagship.services")
        mailbox.pending = [pending]
        // The directory lists a DIFFERENT STK than the request was signed
        // by — a lying relay can't get the phone to seal for this box.
        let foreign = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        mailbox.directory = [PodDirectoryEntry(
            serverDomain: "home.alice.flagship.services",
            identityPubKey: HexUtil.encode(foreign)
        )]
        let coord = makeCoordinator(mailbox)
        let verified = try await coord.fetchVerifiedRequests()
        XCTAssertTrue(verified.isEmpty, "a request whose STK isn't directory-bound must be dropped")
    }

    @MainActor
    func testAcceptsDirectoryVerifiedRequestAndExposesDeviceInfo() async throws {
        let mailbox = MockMailbox(username: username)
        let (pending, _) = makeBoxRequest(purpose: .unlockKey, nonce: Data(repeating: 0x33, count: 32), domain: "home.alice.flagship.services")
        mailbox.pending = [pending]
        mailbox.directory = [PodDirectoryEntry(
            serverDomain: "home.alice.flagship.services",
            identityPubKey: HexUtil.encode(boxStk().publicKey.rawRepresentation)
        )]
        let coord = makeCoordinator(mailbox)
        let verified = try await coord.fetchVerifiedRequests()
        XCTAssertEqual(verified.count, 1)
        XCTAssertEqual(verified[0].serverDomain, "home.alice.flagship.services")
        XCTAssertEqual(verified[0].purpose, .unlockKey)
        // The device-info backstop is surfaced for the confirm sheet.
        XCTAssertEqual(verified[0].deviceInfo?.ip, "203.0.113.7")
        XCTAssertEqual(verified[0].deviceInfo?.region, "fsn1")
    }

    // MARK: - unlock-key reply round-trip

    @MainActor
    func testUnlockKeyReplyRoundTripsAgainstBoxStk() async throws {
        let mailbox = MockMailbox(username: username)
        let nonce = Data(repeating: 0x33, count: 32)
        let (pending, request) = makeBoxRequest(purpose: .unlockKey, nonce: nonce, domain: "home.alice.flagship.services")
        mailbox.pending = [pending]
        mailbox.directory = [PodDirectoryEntry(
            serverDomain: "home.alice.flagship.services",
            identityPubKey: HexUtil.encode(boxStk().publicKey.rawRepresentation)
        )]
        // The installer-sealed LUKS key: sealed FOR the phone's unseal pub.
        let luksKey = Data("real-luks-disk-key-0123456789abc".utf8)
        let unsealPub = try Curve25519.Signing.PrivateKey(rawRepresentation: unsealSeed).publicKey.rawRepresentation
        let sealedForPhone = try SecretSeal.sealForEd25519Recipient(plaintext: luksKey, recipientEd25519Pub: unsealPub)
        mailbox.sealedLuksKeyHex = HexUtil.encode(sealedForPhone)

        let coord = makeCoordinator(mailbox)
        let verified = try await coord.fetchVerifiedRequests()
        try await coord.confirmAndRespond(verified[0])

        let reply = try XCTUnwrap(mailbox.lastPostedResponse)
        XCTAssertEqual(reply.purpose, "unlock-key")
        XCTAssertEqual(reply.serverDomain, "home.alice.flagship.services")
        XCTAssertEqual(reply.requestNonceHex, HexUtil.encode(nonce))

        // The BOX opens the reply with its STK X25519 priv → recovers the
        // framed payload, checks the (nonce, purpose) ctx, recovers the key.
        let sealedReply = try XCTUnwrap(HexUtil.decode(reply.sealed))
        let payload = try SecretSeal.openWithX25519(blob: sealedReply, recipientX25519Priv: stkX25519Priv)
        let ctxLen = (Int(payload[0]) << 24) | (Int(payload[1]) << 16) | (Int(payload[2]) << 8) | Int(payload[3])
        let ctx = payload.subdata(in: 4..<(4 + ctxLen))
        XCTAssertEqual(ctx, SealedSecretResponse.context(nonce: request.nonce, purpose: .unlockKey))
        let recovered = payload.subdata(in: (4 + ctxLen)..<payload.count)
        XCTAssertEqual(recovered, luksKey)
    }

    @MainActor
    func testUnlockKeyFailsWhenNoSealedKeyOnFile() async throws {
        let mailbox = MockMailbox(username: username)
        let (pending, _) = makeBoxRequest(purpose: .unlockKey, nonce: Data(repeating: 0x33, count: 32), domain: "home.alice.flagship.services")
        mailbox.pending = [pending]
        mailbox.directory = [PodDirectoryEntry(
            serverDomain: "home.alice.flagship.services",
            identityPubKey: HexUtil.encode(boxStk().publicKey.rawRepresentation)
        )]
        mailbox.sealedLuksKeyHex = nil  // 404
        let coord = makeCoordinator(mailbox)
        let verified = try await coord.fetchVerifiedRequests()
        do {
            try await coord.confirmAndRespond(verified[0])
            XCTFail("expected noSealedLuksKey")
        } catch SecretRequestCoordinator.CoordinatorError.noSealedLuksKey {
            // expected
        }
    }

    // MARK: - entitlement reply carrier

    @MainActor
    func testEntitlementReplyMatchesDaemonCarrier() async throws {
        let mailbox = MockMailbox(username: username)
        let nonce = Data(repeating: 0x44, count: 32)
        let (pending, _) = makeBoxRequest(purpose: .entitlement, nonce: nonce, domain: "home.alice.flagship.services")
        mailbox.pending = [pending]
        mailbox.directory = [PodDirectoryEntry(
            serverDomain: "home.alice.flagship.services",
            identityPubKey: HexUtil.encode(boxStk().publicKey.rawRepresentation)
        )]
        let coord = makeCoordinator(mailbox)
        let verified = try await coord.fetchVerifiedRequests()
        try await coord.confirmAndRespond(verified[0])

        let reply = try XCTUnwrap(mailbox.lastPostedResponse)
        XCTAssertEqual(reply.purpose, "entitlement")

        // The `sealed` is the hex of the EntitlementBundle JSON carrier the
        // daemon's entitlementBundleStore parses. Decode + assert shape.
        let carrierBytes = try XCTUnwrap(HexUtil.decode(reply.sealed))
        let obj = try JSONSerialization.jsonObject(with: carrierBytes) as! [String: Any]
        let root = obj["rootEntitlement"] as! [String: Any]
        XCTAssertEqual(root["username"] as? String, "alice")
        XCTAssertEqual(root["podPubKey"] as? String, HexUtil.encode(boxStk().publicKey.rawRepresentation))
        XCTAssertEqual(root["podCanonical"] as? String, "home.alice.flagship.services")
        XCTAssertEqual(root["issuedAt"] as? Int64, 999)
        XCTAssertEqual((obj["rootEntitlementSig"] as! String).count, 128)
        XCTAssertTrue(obj["serviceEntitlement"] is NSNull)

        // The carrier's RootEntitlement must verify under the user's IRK
        // (the daemon checks this against the baked phone key).
        let cert = RootEntitlement(
            username: "alice",
            podPubKey: boxStk().publicKey.rawRepresentation,
            podCanonical: "home.alice.flagship.services",
            issuedAt: 999
        )
        let sig = try XCTUnwrap(HexUtil.decode(obj["rootEntitlementSig"] as! String))
        XCTAssertTrue(RootEntitlement.verify(cert, signature: sig, irkPub: phoneIrk().publicKey))
    }

    // MARK: - auto-mode box-sealed lease deposit + revoke

    @MainActor
    func testAutoModeDepositsBoxSealedLeaseThatRoundTrips() async throws {
        let mailbox = MockMailbox(username: username)
        let nonce = Data(repeating: 0x33, count: 32)
        let (pending, _) = makeBoxRequest(purpose: .unlockKey, nonce: nonce, domain: "home.alice.flagship.services")
        mailbox.pending = [pending]
        mailbox.directory = [PodDirectoryEntry(
            serverDomain: "home.alice.flagship.services",
            identityPubKey: HexUtil.encode(boxStk().publicKey.rawRepresentation)
        )]
        let luksKey = Data("real-luks-disk-key-0123456789abc".utf8)
        let unsealPub = try Curve25519.Signing.PrivateKey(rawRepresentation: unsealSeed).publicKey.rawRepresentation
        mailbox.sealedLuksKeyHex = HexUtil.encode(try SecretSeal.sealForEd25519Recipient(plaintext: luksKey, recipientEd25519Pub: unsealPub))

        let coord = makeCoordinator(mailbox)
        let verified = try await coord.fetchVerifiedRequests()
        let leaseId = try await coord.confirmAndRespond(verified[0], depositAutoLease: true)

        // A lease was deposited and its id returned for the kill switch.
        XCTAssertNotNil(leaseId)
        XCTAssertEqual(mailbox.deposited.count, 1)
        let dep = try XCTUnwrap(mailbox.deposited.first)
        XCTAssertEqual(dep.lease.leaseId, leaseId)
        XCTAssertEqual(dep.lease.serverDomain, "home.alice.flagship.services")
        XCTAssertEqual(dep.lease.stkPub, HexUtil.encode(boxStk().publicKey.rawRepresentation))

        // The box opens the lease's sealedKey with its STK X25519 priv → key.
        let recovered = try SecretSeal.openWithX25519(
            blob: try XCTUnwrap(HexUtil.decode(dep.lease.sealedKey)),
            recipientX25519Priv: stkX25519Priv
        )
        XCTAssertEqual(recovered, luksKey)

        // The lease signature verifies under the user's IRK (I2 pinning).
        let lease = AutoUnlockLeaseV2(
            serverDomain: dep.lease.serverDomain,
            stkPub: try XCTUnwrap(HexUtil.decode(dep.lease.stkPub)),
            leaseId: dep.lease.leaseId,
            sealedKey: try XCTUnwrap(HexUtil.decode(dep.lease.sealedKey)),
            issuedAt: dep.lease.issuedAt,
            expiresAt: dep.lease.expiresAt,
            maxUses: dep.lease.maxUses
        )
        let sig = try XCTUnwrap(HexUtil.decode(dep.signatureHex))
        XCTAssertTrue(phoneIrk().publicKey.isValidSignature(sig, for: try lease.canonicalBytes()))
    }

    @MainActor
    func testApproveModeDoesNotDepositALease() async throws {
        let mailbox = MockMailbox(username: username)
        let nonce = Data(repeating: 0x33, count: 32)
        let (pending, _) = makeBoxRequest(purpose: .unlockKey, nonce: nonce, domain: "home.alice.flagship.services")
        mailbox.pending = [pending]
        mailbox.directory = [PodDirectoryEntry(
            serverDomain: "home.alice.flagship.services",
            identityPubKey: HexUtil.encode(boxStk().publicKey.rawRepresentation)
        )]
        let unsealPub = try Curve25519.Signing.PrivateKey(rawRepresentation: unsealSeed).publicKey.rawRepresentation
        mailbox.sealedLuksKeyHex = HexUtil.encode(try SecretSeal.sealForEd25519Recipient(plaintext: Data("k".utf8), recipientEd25519Pub: unsealPub))
        let coord = makeCoordinator(mailbox)
        let verified = try await coord.fetchVerifiedRequests()
        let leaseId = try await coord.confirmAndRespond(verified[0], depositAutoLease: false)
        XCTAssertNil(leaseId)
        XCTAssertTrue(mailbox.deposited.isEmpty, "approve mode must never deposit a self-unlock lease")
    }

    @MainActor
    func testRevokeAutoUnlockLeaseSignsTheRevocation() async throws {
        let mailbox = MockMailbox(username: username)
        let coord = makeCoordinator(mailbox)
        try await coord.revokeAutoUnlockLease(serverDomain: "home.alice.flagship.services", leaseId: "deadbeefdeadbeef")
        XCTAssertEqual(mailbox.revoked.count, 1)
        let rev = try XCTUnwrap(mailbox.revoked.first)
        XCTAssertEqual(rev.request.serverDomain, "home.alice.flagship.services")
        XCTAssertEqual(rev.request.leaseId, "deadbeefdeadbeef")
        let model = LeaseRevocation(serverDomain: rev.request.serverDomain, leaseId: rev.request.leaseId, issuedAt: rev.request.issuedAt)
        let sig = try XCTUnwrap(HexUtil.decode(rev.signatureHex))
        XCTAssertTrue(phoneIrk().publicKey.isValidSignature(sig, for: try model.canonicalBytes()))
    }

    // MARK: - mailbox auth shape

    @MainActor
    func testMailboxAuthIsIrkSigned() async throws {
        let mailbox = MockMailbox(username: username)
        mailbox.directory = []
        let coord = makeCoordinator(mailbox)
        _ = try await coord.fetchVerifiedRequests()
        let auth = try XCTUnwrap(mailbox.lastPostedAuth)
        XCTAssertEqual(auth.auth.username, "alice")
        XCTAssertEqual(auth.auth.phoneIrkPub, HexUtil.encode(phoneIrk().publicKey.rawRepresentation))
        XCTAssertEqual(auth.auth.nonce.count, 64)   // 32 bytes hex
        XCTAssertEqual(auth.authSignature.count, 128)
        // Verify the auth signature re-verifies (proves it's IRK-signed
        // over the exact canonical bytes).
        let claim = DeviceEndpointClaim(
            username: auth.auth.username,
            endpointLabel: auth.auth.endpointLabel,
            phoneIrkPub: HexUtil.decode(auth.auth.phoneIrkPub)!,
            issuedAt: auth.auth.issuedAt,
            expiresAt: auth.auth.expiresAt,
            nonce: HexUtil.decode(auth.auth.nonce)!
        )
        let sig = HexUtil.decode(auth.authSignature)!
        XCTAssertTrue(DeviceEndpointClaim.verify(claim, signature: sig, irkPub: phoneIrk().publicKey))
    }
}
