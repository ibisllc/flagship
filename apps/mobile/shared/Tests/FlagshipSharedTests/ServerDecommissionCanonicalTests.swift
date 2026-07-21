import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the Swift canonical bytes for the `server-decommission` envelope
/// (graceful replacement; docs/server-replacement-graceful-decommission.md §6)
/// to the EXACT cross-platform vector. The box re-derives these bytes
/// (`canonicalServerDecommission` in `packages/protocol/src/legacyEnvelopes.ts`)
/// to verify the owner-IRK signature, so any drift in the tag, `|` separator,
/// field order, the lowercasing, the boolean "1"/"0" encoding, or the number
/// stringification would break the eviction order.
///
/// The TS half lives in
/// `packages/protocol/tests/serverDecommissionVectors.test.ts`; the Kotlin half
/// in `ServerDecommissionVectorTest.kt`.
final class ServerDecommissionCanonicalTests: XCTestCase {
    private func str(_ d: Data) -> String { String(data: d, encoding: .utf8)! }
    private let stk = String(repeating: "aa", count: 32) // 64 'a' chars

    private let vectorCanonical =
        "flagship/server-decommission/v1|home.alice.flagship.services|"
        + String(repeating: "aa", count: 32)
        + "|1|wipe-after-handoff|7|deadbeef|1700"

    private func vector() -> ServerDecommissionOrder {
        ServerDecommissionOrder(
            podCanonical: "home.alice.flagship.services",
            retiredStkPubHex: stk,
            finalBackup: true,
            diskDisposition: "wipe-after-handoff",
            backupEpoch: 7,
            nonce: "deadbeef",
            issuedAt: 1700
        )
    }

    func testCanonicalBytesMatchPinnedVector() {
        XCTAssertEqual(str(vector().canonicalBytes()), vectorCanonical)
    }

    func testLowercasesPodAndStkAndNonce() {
        let o = ServerDecommissionOrder(
            podCanonical: "HOME.Alice.Flagship.Services",
            retiredStkPubHex: String(repeating: "AA", count: 32),
            finalBackup: true,
            diskDisposition: "wipe-after-handoff",
            backupEpoch: 7,
            nonce: "DEADBEEF",
            issuedAt: 1700
        )
        XCTAssertEqual(str(o.canonicalBytes()), vectorCanonical)
    }

    func testFinalBackupFalseEncodesAsZero() {
        let o = ServerDecommissionOrder(
            podCanonical: "home.alice.flagship.services",
            retiredStkPubHex: stk,
            finalBackup: false,
            diskDisposition: "wipe-after-handoff",
            backupEpoch: 0,
            nonce: "deadbeef",
            issuedAt: 1700
        )
        XCTAssertEqual(
            str(o.canonicalBytes()),
            "flagship/server-decommission/v1|home.alice.flagship.services|"
                + stk + "|0|wipe-after-handoff|0|deadbeef|1700"
        )
    }

    func testSignVerifyRoundTrip() {
        // Ed25519 private = 32 bytes all 0x07 (matches the TS vector seed).
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
        let o = vector()
        let sig = try! o.sign(with: key)
        // Verifies over the EXACT pinned canonical string.
        let expected = Data(vectorCanonical.utf8)
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: expected))
        XCTAssertTrue(o.verify(sig, with: key.publicKey))
    }

    func testStkBindingIsInTheBytes() {
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
        let a = vector()
        let b = ServerDecommissionOrder(
            podCanonical: "home.alice.flagship.services",
            retiredStkPubHex: String(repeating: "bb", count: 32),
            finalBackup: true,
            diskDisposition: "wipe-after-handoff",
            backupEpoch: 7,
            nonce: "deadbeef",
            issuedAt: 1700
        )
        let sigA = try! a.sign(with: key)
        // The order for instance A does NOT verify as the order for instance B.
        XCTAssertFalse(b.verify(sigA, with: key.publicKey))
    }
}
