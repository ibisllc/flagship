import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipAPI

/// Pins the Swift canonical bytes for the `flagship/server-update/v1` order
/// (phone-ordered dual-signed in-place update; docs/server-update-mechanism.md)
/// to the EXACT cross-platform vector. The `.com` gate and the box's update
/// consumer both re-derive these bytes (`canonicalUpdateOrder` in
/// `packages/protocol/src/serverUpdate.ts`) to verify the admin-authority
/// signature, so any drift in the tag, `|` separator, field order (fields ride
/// VERBATIM — no lowercasing), or the number stringification would break the
/// order.
///
/// The TS half (source of truth, with the pinned signature) lives in
/// `packages/protocol/tests/serverUpdateVector.test.ts`; the Kotlin half in
/// `ServerUpdateVectorTest.kt`. CryptoKit's Ed25519 signing is RANDOMIZED, so
/// (as with the other Swift vector tests) we assert the TS-pinned deterministic
/// signature VERIFIES over our canonical bytes — which fails on any byte drift
/// — plus a sign/verify round-trip with the same 32×0x07 seed.
final class ServerUpdateCanonicalTests: XCTestCase {
    private func str(_ d: Data) -> String { String(data: d, encoding: .utf8)! }

    private let vectorCanonical =
        "flagship/server-update/v1|home.alice.flagship.services|"
        + "9f2c1ab3de4567890abcdef1234567890abcdef1|1234567890abcdef1234567890abcdef12345678|"
        + "00112233445566778899aabbccddeeff|1700"

    /// The TS-pinned signature under the 32×0x07 admin seed.
    private let pinnedSignature =
        "c9c0085c9e50a9d27a8e130045bf302e5ee350f519d07df66fc03e1e7345737d"
        + "e299ba92448b5a05315f1ae9183f42d40eae90e9f6f0f30a78de5e2ea8e1690d"

    private func vector() -> ServerUpdateOrder {
        ServerUpdateOrder(
            serverDomain: "home.alice.flagship.services",
            targetCommit: "9f2c1ab3de4567890abcdef1234567890abcdef1",
            fromCommit: "1234567890abcdef1234567890abcdef12345678",
            nonce: "00112233445566778899aabbccddeeff",
            issuedAt: 1700
        )
    }

    private func adminKey() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
    }

    func testCanonicalBytesMatchPinnedVector() throws {
        XCTAssertEqual(str(try vector().canonicalBytes()), vectorCanonical)
    }

    func testPinnedTsSignatureVerifiesOverOurCanonicalBytes() throws {
        // The deterministic TS signature verifies over the Swift-built bytes —
        // any canonical drift (tag, order, separator, stringification) fails this.
        let sig = Data(HexUtil.decode(pinnedSignature)!)
        XCTAssertTrue(vector().verify(sig, with: adminKey().publicKey))
        XCTAssertTrue(adminKey().publicKey.isValidSignature(sig, for: Data(vectorCanonical.utf8)))
    }

    func testSignVerifyRoundTripAndTamperRejection() throws {
        let key = adminKey()
        let o = vector()
        let sig = try o.sign(with: key)
        XCTAssertTrue(o.verify(sig, with: key.publicKey))

        // Tampered target commit / issuedAt / wrong key all fail.
        let tampered = ServerUpdateOrder(
            serverDomain: o.serverDomain, targetCommit: String(repeating: "d", count: 40),
            fromCommit: o.fromCommit, nonce: o.nonce, issuedAt: o.issuedAt
        )
        XCTAssertFalse(tampered.verify(sig, with: key.publicKey))
        let shifted = ServerUpdateOrder(
            serverDomain: o.serverDomain, targetCommit: o.targetCommit,
            fromCommit: o.fromCommit, nonce: o.nonce, issuedAt: 1701
        )
        XCTAssertFalse(shifted.verify(sig, with: key.publicKey))
        let other = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 8, count: 32))
        XCTAssertFalse(o.verify(sig, with: other.publicKey))
    }

    func testFieldGuardRejectsSeparatorAndControlChars() {
        let bad = ServerUpdateOrder(
            serverDomain: "home.alice.flagship.services", targetCommit: "a|b",
            fromCommit: "c", nonce: "d", issuedAt: 1
        )
        XCTAssertThrowsError(try bad.canonicalBytes())
        let ctl = ServerUpdateOrder(
            serverDomain: "home.alice.flagship.services", targetCommit: "ab",
            fromCommit: "a\nb", nonce: "d", issuedAt: 1
        )
        XCTAssertThrowsError(try ctl.canonicalBytes())
    }

    // MARK: - ServerUpdateFlow deposit builder

    func testBuildDepositSignsOrderWithOrderKeyAndAuthWithIrk() throws {
        let irk = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
        let adminRoot = adminKey()
        let body = try ServerUpdateFlow.buildDeposit(
            serverFqdn: "home.alice.flagship.services",
            username: "alice",
            targetCommit: "9f2c1ab3de4567890abcdef1234567890abcdef1",
            fromCommit: "1234567890abcdef1234567890abcdef12345678",
            irk: irk,
            orderKey: adminRoot,
            issuedAt: 1700,
            nonce: Data(repeating: 0x11, count: 32),
            authNonce: Data(repeating: 0x22, count: 32),
            depositNonce: Data(repeating: 0x33, count: 32)
        )
        XCTAssertEqual(body.deposit.serverDomain, "home.alice.flagship.services")
        XCTAssertEqual(body.deposit.requestNonceHex, String(repeating: "33", count: 32))
        XCTAssertEqual(body.order.targetCommit, "9f2c1ab3de4567890abcdef1234567890abcdef1")
        XCTAssertEqual(body.order.fromCommit, "1234567890abcdef1234567890abcdef12345678")
        XCTAssertEqual(body.order.issuedAt, 1700)

        // The ORDER signature verifies under the ADMIN root, not the IRK.
        let order = ServerUpdateOrder(
            serverDomain: body.order.serverDomain,
            targetCommit: body.order.targetCommit,
            fromCommit: body.order.fromCommit,
            nonce: body.order.nonce,
            issuedAt: body.order.issuedAt
        )
        let sig = Data(HexUtil.decode(body.signature)!)
        XCTAssertTrue(order.verify(sig, with: adminRoot.publicKey))
        XCTAssertFalse(order.verify(sig, with: irk.publicKey))

        // The mailbox AUTH stays IRK-bound (phoneIrkPub = the IRK pub).
        XCTAssertEqual(body.auth.phoneIrkPub, HexUtil.encode(irk.publicKey.rawRepresentation))
        // No admin root (legacy): the order signs with the IRK.
        let legacy = try ServerUpdateFlow.buildDeposit(
            serverFqdn: "home.alice.flagship.services",
            username: "alice",
            targetCommit: "9f2c1ab3de4567890abcdef1234567890abcdef1",
            fromCommit: "1234567890abcdef1234567890abcdef12345678",
            irk: irk,
            issuedAt: 1700
        )
        let legacySig = Data(HexUtil.decode(legacy.signature)!)
        let legacyOrder = ServerUpdateOrder(
            serverDomain: legacy.order.serverDomain,
            targetCommit: legacy.order.targetCommit,
            fromCommit: legacy.order.fromCommit,
            nonce: legacy.order.nonce,
            issuedAt: legacy.order.issuedAt
        )
        XCTAssertTrue(legacyOrder.verify(legacySig, with: irk.publicKey))
    }

    func testBuildDepositRejectsMalformedCommits() {
        let irk = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
        XCTAssertThrowsError(try ServerUpdateFlow.buildDeposit(
            serverFqdn: "home.alice.flagship.services", username: "alice",
            targetCommit: "deadbeef", fromCommit: String(repeating: "12", count: 20),
            irk: irk, issuedAt: 1700
        ))
        XCTAssertThrowsError(try ServerUpdateFlow.buildDeposit(
            serverFqdn: "home.alice.flagship.services", username: "alice",
            targetCommit: String(repeating: "9f", count: 20), fromCommit: "",
            irk: irk, issuedAt: 1700
        ))
    }
}
