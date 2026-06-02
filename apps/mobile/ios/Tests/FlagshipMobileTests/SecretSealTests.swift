import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore

/// #28 SEAL-TO-BOX — the cross-platform crypto lock for `SecretSeal`.
///
/// These four known-answer tests pin the iOS seal primitive against the
/// TypeScript `@flagship/protocol` (`encryption.ts`) and the Android
/// `SecretSeal`. The birational Ed25519→X25519 map runs over a hand-rolled
/// GF(2^255 − 19) bignum (Swift has no big-integer); a wrong map silently
/// produces blobs the box can't open, so every vector below MUST stay green.
/// All four were verified against the live TS implementation before commit.
final class SecretSealTests: XCTestCase {

    private func hex(_ d: Data) -> String { HexUtil.encode(d) }
    private func bytes(_ h: String) -> Data { HexUtil.decode(h)! }

    // KAT 1 — toMontgomery (public-key birational map).
    func test_kat1_toMontgomery_publicKey() throws {
        let edPub = bytes("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")
        let x = try SecretSeal.toMontgomery(edPub)
        XCTAssertEqual(
            hex(x),
            "761d88ec830413919dfe9d4d1d56f17e653c8c994082df5b137b90a0ae6edf74"
        )
        // Same answer via the underlying map directly.
        XCTAssertEqual(try Curve25519Map.edwardsPubToMontgomery(edPub), x)
    }

    // KAT 2 — toMontgomerySecret (seed → X25519 scalar).
    func test_kat2_toMontgomerySecret_seed() {
        let seed = Data(repeating: 0x07, count: 32)
        let scalar = SecretSeal.toMontgomerySecret(seed)
        XCTAssertEqual(
            hex(scalar),
            "28ad39fefd7fa3e200a9c626eef599e61a2d055c48a8288a4e7e4c4bca392878"
        )
        XCTAssertEqual(Curve25519Map.edwardsSeedToMontgomery(seed), scalar)
    }

    // KAT 3 — OPEN-VECTOR. A blob sealed by the TS implementation, opened with
    // the Ed25519 seed 32×0x07, MUST decrypt to the known plaintext. Proves
    // our open path + HKDF salt/info + AES-GCM layout match TS byte-for-byte.
    func test_kat3_openVector_matchesTypescript() throws {
        let blob = bytes(
            "74aa63aba52da22d67512d5e885676ff38b9d2755431be2a99b8be1830c7d868" +
            "03ad4f38391735af5a7b8f3034d0eb3642ec6c0eee7021170672a7944416fdc5" +
            "9eb65deedf171f7b756780e30bddc38afe2188f37587937fdbbd55fe3cdb8a49" +
            "022ef3e6d8"
        )
        let seed = Data(repeating: 0x07, count: 32)
        let opened = try SecretSeal.openWithEd25519Seed(blob: blob, recipientEd25519Seed: seed)
        XCTAssertEqual(
            String(data: opened, encoding: .utf8),
            "flagship-acme-account-key-pem-test-vector"
        )
    }

    // KAT 4 — round-trip. Our seal to ea4a6c63… then our open with 0x07 seed
    // returns the plaintext, proving SEAL uses the same format as OPEN (which
    // KAT 3 pinned to TS).
    func test_kat4_seal_then_open_roundTrips() throws {
        let edPub = bytes("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")
        let seed = Data(repeating: 0x07, count: 32)
        let plaintext = Data("seal-to-box round-trip payload — 0123456789".utf8)
        let blob = try SecretSeal.sealForEd25519Recipient(
            plaintext: plaintext,
            recipientEd25519Pub: edPub
        )
        // ephPub(32) || nonce(12) || ct(+16 tag) — at least 44 + |pt|.
        XCTAssertEqual(blob.count, 44 + plaintext.count + 16)
        let back = try SecretSeal.openWithEd25519Seed(blob: blob, recipientEd25519Seed: seed)
        XCTAssertEqual(back, plaintext)
    }

    // The seed→Ed25519 pubkey relationship the vectors rely on: signing key
    // from the 0x07 seed has pubkey ea4a6c63…, the KAT-1/KAT-4 recipient.
    func test_seed07_derivesRecipientPubkey() throws {
        let seed = Data(repeating: 0x07, count: 32)
        let signing = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(
            hex(signing.publicKey.rawRepresentation),
            "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"
        )
    }

    // Empty plaintext is a valid seal (the box may seal a zero-length probe).
    func test_emptyPlaintext_roundTrips() throws {
        let edPub = bytes("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")
        let seed = Data(repeating: 0x07, count: 32)
        let blob = try SecretSeal.sealForEd25519Recipient(plaintext: Data(), recipientEd25519Pub: edPub)
        let back = try SecretSeal.openWithEd25519Seed(blob: blob, recipientEd25519Seed: seed)
        XCTAssertEqual(back, Data())
    }
}
