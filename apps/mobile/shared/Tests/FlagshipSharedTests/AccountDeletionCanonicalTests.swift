import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the Swift canonical bytes for the `account-self-delete` +
/// `servers-self-delete` envelopes to the EXACT cross-platform vector. `.com`
/// re-derives these bytes (`canonicalAccountSelfDelete` /
/// `canonicalServersSelfDelete` in `packages/protocol/src/legacyEnvelopes.ts`)
/// to verify the owner-IRK signature, so any drift in the tag, `|` separator,
/// field order, or the username lowercasing / issuedAt stringification would
/// break account deletion.
///
/// The TS half lives in
/// `packages/protocol/tests/accountDeletionVectors.test.ts`; the Kotlin half in
/// `AccountDeletionVectorTest.kt`.
final class AccountDeletionCanonicalTests: XCTestCase {
    private func str(_ d: Data) -> String { String(data: d, encoding: .utf8)! }

    func testAccountSelfDeleteCanonicalBytes() {
        let o = AccountSelfDeleteOrder(username: "alice", issuedAt: 1700)
        XCTAssertEqual(
            str(o.canonicalBytes()),
            "flagship/account-self-delete/v1|alice|1700"
        )
    }

    func testAccountSelfDeleteLowercasesUsername() {
        let o = AccountSelfDeleteOrder(username: "Alice", issuedAt: 42)
        XCTAssertEqual(
            str(o.canonicalBytes()),
            "flagship/account-self-delete/v1|alice|42"
        )
    }

    func testServersSelfDeleteCanonicalBytes() {
        let o = ServersSelfDeleteOrder(username: "alice", issuedAt: 1700)
        XCTAssertEqual(
            str(o.canonicalBytes()),
            "flagship/servers-self-delete/v1|alice|1700"
        )
    }

    func testSignVerifyRoundTrip() {
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
        let acct = AccountSelfDeleteOrder(username: "bob", issuedAt: 5)
        let asig = try! acct.sign(with: key)
        XCTAssertTrue(key.publicKey.isValidSignature(asig, for: acct.canonicalBytes()))

        let servers = ServersSelfDeleteOrder(username: "bob", issuedAt: 5)
        let ssig = try! servers.sign(with: key)
        XCTAssertTrue(key.publicKey.isValidSignature(ssig, for: servers.canonicalBytes()))

        // A captured account-self-delete sig must NOT verify as servers-self-delete.
        XCTAssertFalse(key.publicKey.isValidSignature(asig, for: servers.canonicalBytes()))
    }

    func testWireRequestShape() {
        let o = AccountSelfDeleteOrder(username: "Alice", issuedAt: 9)
        let req = o.request()
        XCTAssertEqual(req["username"] as? String, "alice")
        XCTAssertEqual(req["issuedAt"] as? Int64, 9)
    }
}
