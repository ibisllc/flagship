import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore

/// Mirror-tests for the phone-as-unlock-endpoint RELAY model. These pin the
/// Swift implementation against deterministic vectors generated from
/// `@flagship/protocol`'s `phoneEndpoint.ts` / `encryption.ts`, so a drift
/// in the canonical bytes or the seal layout fails loudly (the
/// iOS-Mock-matches-Worker-wire invariant).
final class PhoneEndpointTests: XCTestCase {

    // A fixed Ed25519 signing seed shared with the TS vector generator.
    private let seedHex = "0101010101010101010101010101010101010101010101010101010101010101"
    private func signingKey() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: HexUtil.decode(seedHex)!)
    }

    // MARK: - DeviceEndpointClaim canonical-bytes pin

    func testDeviceEndpointClaimSignatureMatchesProtocol() throws {
        let key = signingKey()
        let claim = DeviceEndpointClaim(
            username: "alice",
            endpointLabel: "device",
            phoneIrkPub: key.publicKey.rawRepresentation,
            issuedAt: 1_700_000_000_000,
            expiresAt: 1_700_000_120_000,
            nonce: Data(repeating: 0x11, count: 32)
        )
        // Pin the CANONICAL BYTES (deterministic) — CryptoKit's Ed25519
        // signatures are randomized per RFC 8032, so we verify the sig
        // round-trips rather than pinning the sig bytes.
        XCTAssertEqual(
            HexUtil.encode(try claim.canonicalBytes()),
            "666c6167736869702f6465766963652d656e64706f696e742d636c61696d2f76317c616c6963657c6465766963657c386138386533646437343039663139356664353264623264336362613564373263613637303962663164393431323162663337343838303162343066366635637c313730303030303030303030307c313730303030303132303030307c31313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131"
        )
        let sig = try claim.sign(with: key)
        XCTAssertTrue(DeviceEndpointClaim.verify(claim, signature: sig, irkPub: key.publicKey))
    }

    func testDeviceEndpointClaimRejectsTamper() throws {
        let key = signingKey()
        let claim = DeviceEndpointClaim(
            username: "alice", endpointLabel: "device",
            phoneIrkPub: key.publicKey.rawRepresentation,
            issuedAt: 1, expiresAt: 2, nonce: Data(repeating: 0x11, count: 32)
        )
        let sig = try claim.sign(with: key)
        var tampered = claim
        tampered.username = "mallory"
        XCTAssertFalse(DeviceEndpointClaim.verify(tampered, signature: sig, irkPub: key.publicKey))
    }

    func testDeviceEndpointClaimFieldGuardRejectsSeparator() {
        let key = signingKey()
        let claim = DeviceEndpointClaim(
            username: "alice|admin", endpointLabel: "device",
            phoneIrkPub: key.publicKey.rawRepresentation,
            issuedAt: 1, expiresAt: 2, nonce: Data(repeating: 0x11, count: 32)
        )
        XCTAssertThrowsError(try claim.canonicalBytes())
    }

    // MARK: - SecretRequest canonical-bytes pin + re-verify

    func testSecretRequestSignatureMatchesProtocol() throws {
        let key = signingKey()
        let request = SecretRequest(
            serverDomain: "pin.alice.flagship.services",
            stkPub: key.publicKey.rawRepresentation,
            purpose: .unlockKey,
            nonce: Data(repeating: 0x22, count: 32),
            issuedAt: 1_700_000_000_000
        )
        XCTAssertEqual(
            HexUtil.encode(try request.canonicalBytes()),
            "666c6167736869702f7365637265742d726571756573742f76317c70696e2e616c6963652e666c6167736869702e73657276696365737c386138386533646437343039663139356664353264623264336362613564373263613637303962663164393431323162663337343838303162343066366635637c756e6c6f636b2d6b65797c323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232327c31373030303030303030303030"
        )
        let signature = try key.signature(for: request.canonicalBytes())
        // Re-verify against the directory-resolved STK succeeds.
        XCTAssertTrue(SecretRequest.verify(request, signature: signature, stkPub: key.publicKey))
    }

    func testSecretRequestRejectsForeignStk() throws {
        let key = signingKey()
        let request = SecretRequest(
            serverDomain: "pin.alice.flagship.services",
            stkPub: key.publicKey.rawRepresentation,
            purpose: .unlockKey,
            nonce: Data(repeating: 0x22, count: 32),
            issuedAt: 1_700_000_000_000
        )
        let signature = try key.signature(for: request.canonicalBytes())
        // A DIFFERENT STK (a lying relay's substituted directory entry)
        // must NOT verify the box's request — `.com` is not a trust anchor.
        let foreign = Curve25519.Signing.PrivateKey()
        XCTAssertFalse(SecretRequest.verify(request, signature: signature, stkPub: foreign.publicKey))
    }

    // MARK: - Ed25519 → X25519 (Montgomery) public-key map

    func testEdwardsPubToMontgomeryMatchesNoble() throws {
        // Box STK = Ed25519 pub of the all-0x07 seed.
        let stkPub = HexUtil.decode("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")!
        let mont = try Curve25519Map.edwardsPubToMontgomery(stkPub)
        XCTAssertEqual(
            HexUtil.encode(mont),
            "761d88ec830413919dfe9d4d1d56f17e653c8c994082df5b137b90a0ae6edf74"
        )
    }

    func testEdwardsSeedToMontgomeryMatchesNoble() {
        let seed = Data(repeating: 0x07, count: 32)
        let mont = Curve25519Map.edwardsSeedToMontgomery(seed)
        XCTAssertEqual(
            HexUtil.encode(mont),
            "28ad39fefd7fa3e200a9c626eef599e61a2d055c48a8288a4e7e4c4bca392878"
        )
    }

    /// The phone reuses its EXISTING key material to recover the LUKS key:
    /// the installer seals the LUKS key against a phone Ed25519 pubkey, and
    /// the phone opens it by mapping that key's SEED to X25519. Prove the
    /// full reuse path: seal-for-Ed25519-pub → open-with-Ed25519-seed.
    func testLuksUnsealReusesEd25519SeedMap() throws {
        let phoneSeed = Data(repeating: 0x07, count: 32)
        let phonePub = try Curve25519.Signing.PrivateKey(rawRepresentation: phoneSeed).publicKey.rawRepresentation
        let luksKey = Data("the-real-luks-disk-key-32-bytes!!".utf8)
        // Installer-side: seal the LUKS key against the phone's Ed25519 pub.
        let sealedLuks = try SecretSeal.sealForEd25519Recipient(plaintext: luksKey, recipientEd25519Pub: phonePub)
        // Phone-side: open it by mapping the SAME key's seed.
        let recovered = try SecretSeal.openWithEd25519Seed(blob: sealedLuks, recipientEd25519Seed: phoneSeed)
        XCTAssertEqual(recovered, luksKey)
    }

    // MARK: - SealedSecretResponse seal → open round-trip

    func testSealedSecretResponseRoundTripsAgainstStk() throws {
        // Box STK pub + its X25519 secret (from the TS vectors).
        let stkPub = HexUtil.decode("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")!
        let stkX25519Priv = HexUtil.decode("28ad39fefd7fa3e200a9c626eef599e61a2d055c48a8288a4e7e4c4bca392878")!

        let request = SecretRequest(
            serverDomain: "home.alice.flagship.services",
            stkPub: stkPub,
            purpose: .unlockKey,
            nonce: Data(repeating: 0x33, count: 32),
            issuedAt: 1_700_000_000_000
        )
        let luksKey = Data("the-disk-key-aaaaaaaaaaaaaaaaaaaa".utf8)
        let resp = try SealedSecretResponse.build(secret: luksKey, request: request, now: { 12345 })

        XCTAssertEqual(resp.serverDomain, "home.alice.flagship.services")
        XCTAssertEqual(resp.requestNonceHex, HexUtil.encode(request.nonce))
        XCTAssertEqual(resp.purpose, .unlockKey)
        XCTAssertEqual(resp.issuedAt, 12345)
        // No plaintext field anywhere except inside `sealed`.
        XCTAssertFalse(resp.sealed.isEmpty)
        XCTAssertNotEqual(resp.sealed, luksKey)

        // The box (X25519 priv) opens the seal → recovers the framed
        // payload [ctxLen:4][ctx][secret]; verify the ctx + the secret.
        let payload = try SecretSeal.openWithX25519(blob: resp.sealed, recipientX25519Priv: stkX25519Priv)
        let ctxLen = (Int(payload[0]) << 24) | (Int(payload[1]) << 16) | (Int(payload[2]) << 8) | Int(payload[3])
        let ctx = payload.subdata(in: 4..<(4 + ctxLen))
        let expectedCtx = SealedSecretResponse.context(nonce: request.nonce, purpose: .unlockKey)
        XCTAssertEqual(ctx, expectedCtx)
        let recovered = payload.subdata(in: (4 + ctxLen)..<payload.count)
        XCTAssertEqual(recovered, luksKey)
    }

    func testSealedSecretResponseFreshEphemeralPerSeal() throws {
        let stkPub = HexUtil.decode("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")!
        let request = SecretRequest(
            serverDomain: "home.alice.flagship.services", stkPub: stkPub,
            purpose: .unlockKey, nonce: Data(repeating: 0x33, count: 32),
            issuedAt: 1
        )
        let a = try SealedSecretResponse.build(secret: Data("x".utf8), request: request)
        let b = try SealedSecretResponse.build(secret: Data("x".utf8), request: request)
        XCTAssertNotEqual(a.sealed, b.sealed) // fresh ephemeral key per seal
    }

    func testSecretSealEmptyPlaintextRoundTrips() throws {
        let stkPub = HexUtil.decode("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")!
        let stkX25519Priv = HexUtil.decode("28ad39fefd7fa3e200a9c626eef599e61a2d055c48a8288a4e7e4c4bca392878")!
        let sealed = try SecretSeal.sealForEd25519Recipient(plaintext: Data(), recipientEd25519Pub: stkPub)
        let opened = try SecretSeal.openWithX25519(blob: sealed, recipientX25519Priv: stkX25519Priv)
        XCTAssertEqual(opened, Data())
    }

    // MARK: - RootEntitlement canonical-bytes pin + carrier

    func testRootEntitlementSignatureMatchesProtocol() throws {
        let key = signingKey()
        let cert = RootEntitlement(
            username: "alice",
            podPubKey: key.publicKey.rawRepresentation,
            podCanonical: "home.alice.flagship.services",
            issuedAt: 1_700_000_000_000
        )
        XCTAssertEqual(
            HexUtil.encode(cert.canonicalBytes()),
            "666c6167736869702f726f6f742d656e7469746c656d656e742f76317c616c6963657c386138386533646437343039663139356664353264623264336362613564373263613637303962663164393431323162663337343838303162343066366635637c686f6d652e616c6963652e666c6167736869702e73657276696365737c31373030303030303030303030"
        )
        let sig = try cert.sign(with: key)
        XCTAssertTrue(RootEntitlement.verify(cert, signature: sig, irkPub: key.publicKey))
    }

    func testEntitlementBundleCarrierMatchesDaemonFormat() throws {
        let key = signingKey()
        let cert = RootEntitlement(
            username: "alice",
            podPubKey: key.publicKey.rawRepresentation,
            podCanonical: "home.alice.flagship.services",
            issuedAt: 1_700_000_000_000
        )
        let sig = try cert.sign(with: key)
        let json = EntitlementBundleCarrier.serialize(rootEntitlement: cert, rootEntitlementSig: sig)

        // Parse it back the way the daemon's parseEntitlementBundle does and
        // assert the exact field shape (root-only, hex byte fields).
        let obj = try JSONSerialization.jsonObject(with: json) as! [String: Any]
        let root = obj["rootEntitlement"] as! [String: Any]
        XCTAssertEqual(root["username"] as? String, "alice")
        XCTAssertEqual(root["podPubKey"] as? String, HexUtil.encode(key.publicKey.rawRepresentation))
        XCTAssertEqual(root["podCanonical"] as? String, "home.alice.flagship.services")
        XCTAssertEqual(root["issuedAt"] as? Int64, 1_700_000_000_000)
        XCTAssertEqual(obj["rootEntitlementSig"] as? String, HexUtil.encode(sig))
        XCTAssertTrue(obj["serviceEntitlement"] is NSNull)
        XCTAssertTrue(obj["serviceEntitlementSig"] is NSNull)
        // podPubKey + sig must be valid hex of the right lengths (the
        // daemon's HEX32 / HEX64 regexes).
        XCTAssertEqual((root["podPubKey"] as! String).count, 64)
        XCTAssertEqual((obj["rootEntitlementSig"] as! String).count, 128)
    }
}
