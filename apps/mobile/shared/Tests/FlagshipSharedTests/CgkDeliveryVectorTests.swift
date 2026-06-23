import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the Swift `CgkDelivery` envelope to the EXACT cross-platform vector in
/// `packages/protocol/tests/cgkDelivery.test.ts`:
///   UMK seed = 32×0x07 → deriveIRK → pub 3e4a50e7…  AND  deriveCGK → 1d8e3bc3…
///   box identity seed = 32×0x09 → Ed25519 pub fd172438…
///   fixed sealed blob = (i*7+3)&0xff over 76 bytes
///   serverDomain = "kitchen.alice.flagship.services", issuedAt = 1750000000000
///   → signature 147205c6…44417a0f
///
/// The box re-derives these canonical bytes to verify the owner-IRK signature,
/// so any drift in the tag, `|` separator, field order, or issuedAt
/// stringification would break secret-free CGK delivery. The CGK is the per-CLOUD
/// key (no serverId).
final class CgkDeliveryVectorTests: XCTestCase {
    private let serverDomain = "kitchen.alice.flagship.services"
    private let issuedAt: Int64 = 1_750_000_000_000

    // Pinned constants (must match the TS test).
    private let pinnedIrkPub =
        "3e4a50e7afdfae54c86e1ccd70a8691d48155e9613cbdbf4d17bad5b6ba68045"
    private let pinnedBoxIdentityPub =
        "fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618"
    private let pinnedCgk =
        "1d8e3bc393a91de22edec0b862a0539856bdc73b42ab60a26d7d51fbb091badd"
    private let pinnedSignature =
        "147205c68400bbce5ac3f92d853ca6745715d7d7d092991eaad7cb769ee6b037" +
        "7f39497865292f667b3d5e3b94454d3517dd81f6d622e3cbcf375c1d44417a0f"

    /// HKDF-SHA256 with an EMPTY salt — mirrors the protocol `derive` used by
    /// `deriveIRK` (info "flagship.irk.v1").
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

    /// The deterministic CGK = `CloudGossip.deriveCGK(umk.seed)` (per cloud, no
    /// serverId) must match the pinned cross-platform value.
    func testPinnedCgk() {
        let umk = Data(repeating: 0x07, count: 32)
        let cgk = CloudGossip.deriveCGK(umkSeed: umk)
        XCTAssertEqual(HexUtil.encode(cgk!), pinnedCgk)
    }

    func testPinnedSignatureOverFixedSealedBlob() throws {
        // A FIXED sealed-blob constant (NOT the random-ephemeral seal output) so
        // the signing + canonical layer is byte-reproducible across platforms.
        var fixedSealed = Data(count: 76)
        for i in 0..<76 { fixedSealed[i] = UInt8((i * 7 + 3) & 0xff) }
        let delivery = CgkDelivery.Delivery(
            serverDomain: serverDomain, sealed: fixedSealed, issuedAt: issuedAt
        )
        let irk = vectorIrk()
        // CryptoKit's Ed25519 signing is RANDOMIZED (not pure RFC 8032
        // deterministic like noble), so we can't assert the exact signature BYTES
        // here. Instead assert the cross-platform vector's PINNED TS signature
        // VERIFIES under our (pinned) IRK pub over our canonical bytes —
        // byte-identical canonical layer ⇒ the TS signature validates. (This is
        // how the repo pins Swift↔TS signing parity, exactly as SwkDelivery does.)
        let pinnedSig = HexUtil.decode(pinnedSignature)!
        XCTAssertTrue(irk.publicKey.isValidSignature(pinnedSig, for: try CgkDelivery.canonicalBytes(delivery)))

        // And our own freshly-produced signature verifies too (round-trip).
        let sig = try CgkDelivery.sign(delivery, irk: irk)
        XCTAssertTrue(irk.publicKey.isValidSignature(sig, for: try CgkDelivery.canonicalBytes(delivery)))
    }

    func testCanonicalBytesShape() throws {
        var fixedSealed = Data(count: 76)
        for i in 0..<76 { fixedSealed[i] = UInt8((i * 7 + 3) & 0xff) }
        let delivery = CgkDelivery.Delivery(
            serverDomain: serverDomain, sealed: fixedSealed, issuedAt: issuedAt
        )
        let bytes = try CgkDelivery.canonicalBytes(delivery)
        let expected = "flagship/cgk-delivery/v1|\(serverDomain)|\(HexUtil.encode(fixedSealed))|\(issuedAt)"
        XCTAssertEqual(String(data: bytes, encoding: .utf8), expected)
    }

    /// Full round-trip: phone seals the deterministic CGK to the box identity +
    /// signs; the SEAL uses a random ephemeral key, so this asserts the sealed
    /// CGK opens to the EXACT 32 bytes (via the box X25519 priv) and the
    /// signature verifies — exactly mirroring the swk-delivery Swift test.
    func testSealRoundTripOpensExactCgk() throws {
        let umk = Data(repeating: 0x07, count: 32)
        let cgk = CloudGossip.deriveCGK(umkSeed: umk)!
        XCTAssertEqual(HexUtil.encode(cgk), pinnedCgk)
        let boxSeed = Data(repeating: 0x09, count: 32)
        let boxPub = try! Curve25519.Signing.PrivateKey(rawRepresentation: boxSeed).publicKey.rawRepresentation
        let irk = vectorIrk()

        let built = try CgkDelivery.build(
            serverDomain: serverDomain, cgk: cgk, boxIdentityPub: boxPub, irk: irk, issuedAt: issuedAt
        )
        // Signature verifies under the owner IRK.
        XCTAssertTrue(irk.publicKey.isValidSignature(built.signature, for: try CgkDelivery.canonicalBytes(built.delivery)))
        // The carrier round-trips through hex JSON.
        let carrier = CgkDelivery.carrierHex(delivery: built.delivery, signature: built.signature)
        XCTAssertFalse(carrier.isEmpty)

        // Box-side unseal with the box X25519 priv (mapped from its Ed25519 seed).
        let x25519Priv = Curve25519Map.edwardsSeedToMontgomery(boxSeed)
        let opened = try SecretSeal.openWithX25519(blob: built.delivery.sealed, recipientX25519Priv: x25519Priv)
        XCTAssertEqual(HexUtil.encode(opened), HexUtil.encode(cgk))
    }
}
