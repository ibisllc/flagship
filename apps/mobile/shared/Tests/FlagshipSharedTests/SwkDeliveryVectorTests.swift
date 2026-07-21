import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the Swift `SwkDelivery` envelope to the EXACT cross-platform vector in
/// `packages/protocol/tests/swkDelivery.test.ts`:
///   UMK seed = 32×0x07 → deriveIRK → pub 3e4a50e7…
///   box identity seed = 32×0x09 → Ed25519 pub fd172438…
///   fixed sealed blob = (i*7+3)&0xff over 76 bytes
///   serverDomain = "kitchen.alice.flagship.services", issuedAt = 1750000000000
///   → signature 660cf5eb…a8867a0f
///
/// The box re-derives these canonical bytes to verify the owner-IRK signature,
/// so any drift in the tag, `|` separator, field order, or issuedAt
/// stringification would break secret-free SWK delivery.
final class SwkDeliveryVectorTests: XCTestCase {
    private let serverDomain = "kitchen.alice.flagship.services"
    private let serverId = "srv-vector-1"
    private let issuedAt: Int64 = 1_750_000_000_000

    // Pinned constants (must match the TS test).
    private let pinnedIrkPub =
        "3e4a50e7afdfae54c86e1ccd70a8691d48155e9613cbdbf4d17bad5b6ba68045"
    private let pinnedBoxIdentityPub =
        "fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618"
    private let pinnedSignature =
        "660cf5eb0be65b17d5e57208b0d130ab3d9dd074f6623cf8c45c6d4055c6e06f" +
        "27403cd87a5247b3476b8985d2a99dafb1dd2aea4feed8732e4bf7e7a8867a0f"

    /// HKDF-SHA256 with an EMPTY salt — mirrors the protocol `derive` used by
    /// `deriveIRK` (info "flagship.irk.v1") and ServerKeys.
    private func hkdf(ikm: Data, info: String) -> Data {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm),
            salt: Data(),
            info: Data(info.utf8),
            outputByteCount: 32
        )
        return key.withUnsafeBytes { Data($0) }
    }

    /// The owner IRK from the pinned UMK (= protocol `deriveIRK(UMK)`).
    private func vectorIrk() -> Curve25519.Signing.PrivateKey {
        let umk = Data(repeating: 0x07, count: 32)
        let seed = hkdf(ikm: umk, info: "flagship.irk.v1")
        return try! Curve25519.Signing.PrivateKey(rawRepresentation: seed)
    }

    func testPinnedIrkPub() {
        XCTAssertEqual(HexUtil.encode(vectorIrk().publicKey.rawRepresentation), pinnedIrkPub)
    }

    func testPinnedBoxIdentityPub() {
        let boxSeed = Data(repeating: 0x09, count: 32)
        let pub = try! Curve25519.Signing.PrivateKey(rawRepresentation: boxSeed).publicKey.rawRepresentation
        XCTAssertEqual(HexUtil.encode(pub), pinnedBoxIdentityPub)
    }

    func testPinnedSignatureOverFixedSealedBlob() throws {
        // A FIXED sealed-blob constant (NOT the random-ephemeral seal output) so
        // the signing + canonical layer is byte-reproducible across platforms.
        var fixedSealed = Data(count: 76)
        for i in 0..<76 { fixedSealed[i] = UInt8((i * 7 + 3) & 0xff) }
        let delivery = SwkDelivery.Delivery(
            serverDomain: serverDomain, sealed: fixedSealed, issuedAt: issuedAt
        )
        let irk = vectorIrk()
        // CryptoKit's Ed25519 signing is RANDOMIZED (not pure RFC 8032
        // deterministic like noble), so we can't assert the exact signature
        // BYTES here. Instead assert the cross-platform vector's PINNED TS
        // signature VERIFIES under our (pinned) IRK pub over our canonical bytes
        // — byte-identical canonical layer ⇒ the TS signature validates. (This is
        // how the repo pins Swift↔TS signing parity.)
        let pinnedSig = HexUtil.decode(pinnedSignature)!
        XCTAssertTrue(irk.publicKey.isValidSignature(pinnedSig, for: try SwkDelivery.canonicalBytes(delivery)))

        // And our own freshly-produced signature verifies too (round-trip).
        let sig = try SwkDelivery.sign(delivery, irk: irk)
        XCTAssertTrue(irk.publicKey.isValidSignature(sig, for: try SwkDelivery.canonicalBytes(delivery)))
    }

    func testCanonicalBytesShape() throws {
        var fixedSealed = Data(count: 76)
        for i in 0..<76 { fixedSealed[i] = UInt8((i * 7 + 3) & 0xff) }
        let delivery = SwkDelivery.Delivery(
            serverDomain: serverDomain, sealed: fixedSealed, issuedAt: issuedAt
        )
        let bytes = try SwkDelivery.canonicalBytes(delivery)
        let expected = "flagship/swk-delivery/v1|\(serverDomain)|\(HexUtil.encode(fixedSealed))|\(issuedAt)"
        XCTAssertEqual(String(data: bytes, encoding: .utf8), expected)
    }

    /// Full round-trip: phone seals to the box identity + signs; the SEAL uses a
    /// random ephemeral key, so this asserts the sealed SWK opens to the exact
    /// 32 bytes (via the box X25519 priv) and the signature verifies.
    func testSealRoundTripOpensExactSwk() throws {
        let umk = Data(repeating: 0x07, count: 32)
        let swk = ServerKeys.deriveSwk(umkSeed: umk, serverId: serverId)!
        let boxSeed = Data(repeating: 0x09, count: 32)
        let boxPub = try! Curve25519.Signing.PrivateKey(rawRepresentation: boxSeed).publicKey.rawRepresentation
        let irk = vectorIrk()

        let built = try SwkDelivery.build(
            serverDomain: serverDomain, swk: swk, boxIdentityPub: boxPub, irk: irk, issuedAt: issuedAt
        )
        // Signature verifies under the owner IRK.
        XCTAssertTrue(irk.publicKey.isValidSignature(built.signature, for: try SwkDelivery.canonicalBytes(built.delivery)))
        // The carrier round-trips through hex JSON.
        let carrier = SwkDelivery.carrierHex(delivery: built.delivery, signature: built.signature)
        XCTAssertFalse(carrier.isEmpty)

        // Box-side unseal with the box X25519 priv (mapped from its Ed25519 seed).
        let x25519Priv = Curve25519Map.edwardsSeedToMontgomery(boxSeed)
        let opened = try SecretSeal.openWithX25519(blob: built.delivery.sealed, recipientX25519Priv: x25519Priv)
        XCTAssertEqual(HexUtil.encode(opened), HexUtil.encode(swk))
    }
}
