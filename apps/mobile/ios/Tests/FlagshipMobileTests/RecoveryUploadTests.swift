import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore
@testable import FlagshipAPI

/// Pins the wire shape of the signed `POST /api/recovery` body (record v2, N03). The canonical
/// bytes and signature are locked to the shared vectors in `RecoveryRecordV2Tests` (shared
/// package); this guards what the live Worker parses, so a drift fails here instead of as a 400.
final class RecoveryUploadTests: XCTestCase {

    func test_bodyShape_isClaimSignatureAndCiphertexts_noV1Fields() throws {
        let req = try makeRecoveryUpload(username: "demo1234", wrappedUmk: "Zm9v")
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any])
        XCTAssertEqual(Set(obj.keys), ["claim", "signature", "wrappedUmk"])
        XCTAssertNil(obj["request"])
        let claim = try XCTUnwrap(obj["claim"] as? [String: Any])
        XCTAssertEqual(Set(claim.keys), [
            "op", "username", "irkPubHex", "adminRootPubHex", "credentialIdHex", "wrappedUmkDigestHex", "adminRoot", "acmeKey",
            "fetchTokenHashHex", "prfSaltHashHex", "kdfVersion", "algVersion", "policy", "generation", "nonceHex",
            "priorDigestHex", "issuedAt",
        ])
        XCTAssertEqual(claim["priorDigestHex"] as? String, "genesis")
        XCTAssertEqual((claim["adminRoot"] as? [String: Any])?["change"] as? String, "none")
    }

    func test_escrowCiphertextsRideBesideTheClaimAndMatchItsDigests() throws {
        let admin = Data([4, 5]).base64EncodedString()
        let acme = Data([6]).base64EncodedString()
        let req = try makeRecoveryUpload(username: "demo1234", wrappedAdminRoot: admin, wrappedAcmeAccountKey: acme)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any])
        XCTAssertEqual(obj["wrappedAdminRoot"] as? String, admin)
        XCTAssertEqual(obj["wrappedAcmeAccountKey"] as? String, acme)
        XCTAssertNil(req.claim.ciphertextMismatch(wrappedUmk: req.wrappedUmk, wrappedAdminRoot: admin, wrappedAcmeAccountKey: acme))
    }

    func test_theSignatureCoversTheWholeClaim() throws {
        let key = Curve25519.Signing.PrivateKey()
        let claim = try makeRecoveryUpload(username: "demo1234").claim
        var tampered = claim
        tampered.fetchTokenHashHex = String(repeating: "11", count: 32)
        tampered.irkPubHex = key.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined()
        var signed = claim
        signed.irkPubHex = tampered.irkPubHex
        let good = try signed.sign(with: key)
        XCTAssertTrue(signed.verify(signatureHex: good, publicKey: key.publicKey))
        XCTAssertFalse(tampered.verify(signatureHex: good, publicKey: key.publicKey))
    }
}
