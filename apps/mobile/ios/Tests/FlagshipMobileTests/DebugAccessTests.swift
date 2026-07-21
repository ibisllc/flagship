import XCTest
import CryptoKit
@testable import FlagshipCore

/// debug-access grant — iOS signs byte-identically to TS + Kotlin (pinned
/// vector matches packages/protocol/tests/debugAccess.test.ts).
final class DebugAccessTests: XCTestCase {
    private let grant = DebugAccess.Grant(
        serverDomain: "home.alice.flagship.services",
        sshAuthorizedKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILEXAMPLE phone",
        issuedAt: 1700)

    func test_canonicalBytes() {
        XCTAssertEqual(
            String(data: DebugAccess.canonicalBytes(grant), encoding: .utf8),
            "flagship/debug-access/v1|home.alice.flagship.services|ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILEXAMPLE phone|1700")
    }

    // The cross-platform contract is canonical-bytes + key parity (any
    // platform's sig verifies anywhere) — NOT a pinned sig hex, since
    // CryptoKit Ed25519 signing is non-deterministic (hedged).
    private let pinnedSig =
        "818ed03fb15414fe647aecd466524d8069df53f245dfe6dff7ab78da15ab976e922a39595e5e34ebdb4cec1e628efba0a4cc1cbd1efb1684234a8b8d4e21aa05"
    private let pinnedPubHex = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"

    func test_seedToPubkeyParity() throws {
        let irk = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
        XCTAssertEqual(irk.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined(), pinnedPubHex)
    }

    func test_pinnedCrossPlatformSignatureVerifies() {
        let pub = Data((0..<32).map { i in UInt8(pinnedPubHex[pinnedPubHex.index(pinnedPubHex.startIndex, offsetBy: i*2)..<pinnedPubHex.index(pinnedPubHex.startIndex, offsetBy: i*2+2)], radix: 16)! })
        XCTAssertTrue(DebugAccess.verify(grant, signatureHex: pinnedSig, irkPub: pub))
    }

    func test_signVerifyRoundTrip() throws {
        let irk = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
        let sig = try DebugAccess.sign(grant, irk: irk)
        XCTAssertTrue(DebugAccess.verify(grant, signatureHex: sig, irkPub: irk.publicKey.rawRepresentation))
    }

    func test_rejectsWrongKey() throws {
        let irk = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
        let sig = try DebugAccess.sign(grant, irk: irk)
        let wrong = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 8, count: 32))
        XCTAssertFalse(DebugAccess.verify(grant, signatureHex: sig, irkPub: wrong.publicKey.rawRepresentation))
    }
}
