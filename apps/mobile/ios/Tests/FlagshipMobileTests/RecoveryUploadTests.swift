import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore
@testable import FlagshipAPI

/// Locks the iOS `RecoveryUpload` canonical-bytes + signer to the TS
/// `signUploadRecoveryRecord` impl, and pins the wire shape of the signed
/// `POST /api/recovery` body. If either drifts, the live Worker rejects the
/// upload with a 403 (bad signature) or 400 (malformed body), so these are
/// the byte-for-byte regression guards.
final class RecoveryUploadTests: XCTestCase {

    // The known-answer vector. IRK seed = 32 bytes 0x03.
    private let irkSeed = Data(repeating: 0x03, count: 32)
    private let expectedIrkPubHex =
        "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1"
    private let username = "demo1234"
    private let credentialIdHex = "aabbccddeeff00112233445566778899"
    private let wrappedUmkHashHex = String(repeating: "1", count: 64)
    private let issuedAt: Int64 = 1_700_000_000_000
    private let expectedCanonical =
        "flagship/upload-recovery-record/v1|demo1234|aabbccddeeff00112233445566778899|1111111111111111111111111111111111111111111111111111111111111111|1700000000000"
    private let expectedSignatureHex =
        "07d47f6e502c2d8e44bd1f4966715e06e56e73b474c2ef47bee357d306b533de44f321eeeb3549b56d780566d8ef9658e0e8bded588f8e7e5ac2168da23bef0a"

    /// Sanity: the seed yields the documented IRK pubkey. If CryptoKit ever
    /// changed how it derives a public key from a raw scalar this would catch
    /// it before the signature assertion.
    func test_kat_irkSeedProducesExpectedPubKey() throws {
        let irk = try Curve25519.Signing.PrivateKey(rawRepresentation: irkSeed)
        XCTAssertEqual(HexUtil.encode(irk.publicKey.rawRepresentation), expectedIrkPubHex)
    }

    func test_kat_canonicalBytesMatchTsImpl() {
        let canonical = RecoveryUpload.canonical(
            username: username,
            credentialIdHex: credentialIdHex,
            wrappedUmkHashHex: wrappedUmkHashHex,
            issuedAt: issuedAt
        )
        XCTAssertEqual(String(data: canonical, encoding: .utf8), expectedCanonical)
    }

    /// CryptoKit's `Curve25519.Signing` is RANDOMIZED (hedged) — the same
    /// message signs to different bytes each call, so byte-equality with a
    /// deterministic (noble/libsodium) signature is impossible. The real
    /// cross-platform lock (same convention as `WatchDelegateKeyTests`):
    ///   (1) our canonical bytes are byte-identical to TS — PROVEN by
    ///       verifying the deterministic TS KAT signature against them;
    ///   (2) our own signer's output round-trips through verify.
    func test_kat_canonicalVerifiesUnderTsSignature() throws {
        let irk = try Curve25519.Signing.PrivateKey(rawRepresentation: irkSeed)
        let canonical = RecoveryUpload.canonical(
            username: username,
            credentialIdHex: credentialIdHex,
            wrappedUmkHashHex: wrappedUmkHashHex,
            issuedAt: issuedAt
        )
        // (1) The deterministic TS signature verifies against OUR canonical
        // bytes ⇒ byte-for-byte canonical parity with the TS signer.
        let pub = try Curve25519.Signing.PublicKey(
            rawRepresentation: Self.hexToData(expectedIrkPubHex)
        )
        XCTAssertTrue(
            pub.isValidSignature(Self.hexToData(expectedSignatureHex), for: canonical),
            "TS KAT signature must verify against the iOS canonical bytes"
        )
        // (2) Our signer (randomized) produces a signature that verifies.
        let sigHex = try RecoveryUpload.sign(
            username: username,
            credentialIdHex: credentialIdHex,
            wrappedUmkHashHex: wrappedUmkHashHex,
            issuedAt: issuedAt,
            irk: irk
        )
        XCTAssertTrue(irk.publicKey.isValidSignature(Self.hexToData(sigHex), for: canonical))
    }

    private static func hexToData(_ hex: String) -> Data {
        var data = Data(capacity: hex.count / 2)
        var idx = hex.startIndex
        while idx < hex.endIndex {
            let next = hex.index(idx, offsetBy: 2)
            data.append(UInt8(hex[idx..<next], radix: 16)!)
            idx = next
        }
        return data
    }

    /// The wire body the live client POSTs must serialize to exactly
    /// `{ request: { username, credentialId, wrappedUmk, issuedAt }, signature }`
    /// — and crucially must NOT carry the old flat/split fields
    /// (`nonceBase64`, `wrappedUmkBase64`).
    func test_registerBodyShape_isSignedNestedAndDropsOldFields() throws {
        let req = RecoveryUploadRequest(
            request: .init(
                username: username,
                credentialId: credentialIdHex,
                wrappedUmk: "Zm9v",
                issuedAt: issuedAt
            ),
            signature: expectedSignatureHex
        )
        let data = try JSONEncoder().encode(req)
        let obj = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        // Top-level: request + signature, and NO leaked flat fields.
        XCTAssertNotNil(obj["signature"])
        XCTAssertEqual(obj["signature"] as? String, expectedSignatureHex)
        XCTAssertNil(obj["nonceBase64"])
        XCTAssertNil(obj["wrappedUmkBase64"])
        XCTAssertNil(obj["wrappedUmk"]) // it lives under `request`, not top-level

        let inner = try XCTUnwrap(obj["request"] as? [String: Any])
        XCTAssertEqual(inner["username"] as? String, username)
        XCTAssertEqual(inner["credentialId"] as? String, credentialIdHex)
        XCTAssertEqual(inner["wrappedUmk"] as? String, "Zm9v")
        XCTAssertEqual((inner["issuedAt"] as? NSNumber)?.int64Value, issuedAt)
        // The single-blob migration: no nonce field anywhere in the body.
        XCTAssertNil(inner["nonceBase64"])
        XCTAssertNil(inner["wrappedUmkBase64"])
        // wrappedAcmeAccountKey is optional and omitted here.
        XCTAssertNil(inner["wrappedAcmeAccountKey"])
    }

    /// When the #28 escrowed ACME account key is present it rides INSIDE
    /// `request` (the Worker reads `r.wrappedAcmeAccountKey`), not top-level.
    func test_registerBodyShape_acmeKeyRidesInsideRequest() throws {
        let req = RecoveryUploadRequest(
            request: .init(
                username: username,
                credentialId: credentialIdHex,
                wrappedUmk: "Zm9v",
                issuedAt: issuedAt,
                wrappedAcmeAccountKey: "QUNNRQ=="
            ),
            signature: "00"
        )
        let data = try JSONEncoder().encode(req)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(obj["wrappedAcmeAccountKey"])
        let inner = try XCTUnwrap(obj["request"] as? [String: Any])
        XCTAssertEqual(inner["wrappedAcmeAccountKey"] as? String, "QUNNRQ==")
    }

    /// The hash helper feeds the canonical the SHA-256 of the DECODED
    /// ciphertext bytes (what the Worker recomputes from the wire blob),
    /// lowercase hex.
    func test_wrappedUmkHashHex_matchesSha256OfBytes() {
        let bytes = Data([0xde, 0xad, 0xbe, 0xef])
        let expected = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(RecoveryUpload.wrappedUmkHashHex(bytes), expected)
    }

    /// Task #4 — the passphrase-gate hashes ride INSIDE `request`
    /// (`r.fetchTokenHash` / `r.prfSaltHash`), beside the credentialId, and
    /// are absent from the top level. The Worker reads them accept-if-present.
    func test_registerBodyShape_fetchAndPrfSaltHashesRideInsideRequest() throws {
        let fth = String(repeating: "a", count: 64)
        let psh = String(repeating: "b", count: 64)
        let req = RecoveryUploadRequest(
            request: .init(
                username: username,
                credentialId: credentialIdHex,
                wrappedUmk: "Zm9v",
                issuedAt: issuedAt,
                fetchTokenHash: fth,
                prfSaltHash: psh
            ),
            signature: "00"
        )
        let data = try JSONEncoder().encode(req)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        // Not leaked to the top level.
        XCTAssertNil(obj["fetchTokenHash"])
        XCTAssertNil(obj["prfSaltHash"])
        let inner = try XCTUnwrap(obj["request"] as? [String: Any])
        XCTAssertEqual(inner["fetchTokenHash"] as? String, fth)
        XCTAssertEqual(inner["prfSaltHash"] as? String, psh)
    }

    /// When omitted (legacy callers), the optional hash fields don't appear
    /// in the encoded body at all — preserving the pre-#4 wire shape.
    func test_registerBodyShape_hashesOmittedWhenNil() throws {
        let req = RecoveryUploadRequest(
            request: .init(
                username: username,
                credentialId: credentialIdHex,
                wrappedUmk: "Zm9v",
                issuedAt: issuedAt
            ),
            signature: "00"
        )
        let data = try JSONEncoder().encode(req)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let inner = try XCTUnwrap(obj["request"] as? [String: Any])
        XCTAssertNil(inner["fetchTokenHash"])
        XCTAssertNil(inner["prfSaltHash"])
    }
}
