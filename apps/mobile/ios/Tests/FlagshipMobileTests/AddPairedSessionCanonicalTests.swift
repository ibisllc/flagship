import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the Swift canonical bytes for the `add-paired-session` PhoneOrder to
/// the EXACT cross-platform vector. The box's `/api/orders-from-user`
/// re-derives these bytes (`canonicalPhoneOrder` in
/// `packages/protocol/src/orders.ts`) to verify the Ed25519 signature, and the
/// webapp signs the identical shape (`apps/web/public/webapp/lib/podPair.js`),
/// so any drift in the tag, the `|` separator, field order, or the issuedAt
/// stringification would break live pairing on every surface.
///
/// The TS half of this pin lives in
/// `packages/protocol/tests/addPairedSessionVector.test.ts`.
final class AddPairedSessionCanonicalTests: XCTestCase {
    private let server = "home.alice.flagship.services"

    private func str(_ d: Data) -> String { String(data: d, encoding: .utf8)! }

    func testCanonicalBytes() {
        let o = AddPairedSessionOrder(serverId: server, token: "deadbeef", issuedAt: 1700)
        XCTAssertEqual(
            str(o.canonicalBytes()),
            "flagship/order/add-paired-session/v2|home.alice.flagship.services|deadbeef|1700"
        )
    }

    func testSignVerifyRoundTrip() {
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
        let o = AddPairedSessionOrder(serverId: server, token: "abc123", issuedAt: 42)
        let sig = try! o.sign(with: key)
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: o.canonicalBytes()))
    }

    func testEnvelopeWireShape() {
        let o = AddPairedSessionOrder(serverId: server, token: "tok", issuedAt: 5)
        let env = o.envelope(signatureHex: "ab")
        let req = env["request"] as! [String: Any]
        XCTAssertEqual(req["type"] as? String, "add-paired-session")
        XCTAssertEqual(req["serverId"] as? String, server)
        XCTAssertEqual(req["token"] as? String, "tok")
        XCTAssertNil(req["label"])
        XCTAssertEqual(req["issuedAt"] as? Int64, 5)
        XCTAssertEqual(env["signature"] as? String, "ab")
    }

    func testFreshTokenIs32BytesHex() {
        let t = AddPairedSessionOrder.freshToken()
        XCTAssertEqual(t.count, 64) // 32 bytes → 64 hex chars
        XCTAssertNotNil(HexUtil.decode(t))
        XCTAssertNotEqual(t, AddPairedSessionOrder.freshToken())
    }

    func testIssuedAtIsCommitted() {
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 3, count: 32))
        let a = AddPairedSessionOrder(serverId: server, token: "t", issuedAt: 1)
        let b = AddPairedSessionOrder(serverId: server, token: "t", issuedAt: 2)
        let sig = try! a.sign(with: key)
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: a.canonicalBytes()))
        XCTAssertFalse(key.publicKey.isValidSignature(sig, for: b.canonicalBytes()))
    }
}
