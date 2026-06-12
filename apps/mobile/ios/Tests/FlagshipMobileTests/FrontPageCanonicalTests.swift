import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the Swift canonical bytes for the `set-front-page` PhoneOrder to the
/// EXACT cross-platform vector in `packages/protocol/tests/setFrontPage.test.ts`
/// (also asserted by the webapp + Android mirrors). The daemon re-derives
/// these bytes to verify the Ed25519 signature, so any drift in the tag, the
/// `|` separator, field order, or the issuedAt stringification would break
/// live front-page assignment.
final class FrontPageCanonicalTests: XCTestCase {
    private let server = "home.alice.flagship.services"

    private func str(_ d: Data) -> String { String(data: d, encoding: .utf8)! }

    func testCanonicalAssign() {
        let o = SetFrontPageOrder(serverId: server, label: "photos", issuedAt: 1700)
        XCTAssertEqual(
            str(o.canonicalBytes()),
            "flagship/order/set-front-page/v1|home.alice.flagship.services|photos|1700"
        )
    }

    func testCanonicalClearIsEmptyField() {
        let o = SetFrontPageOrder(serverId: server, label: "", issuedAt: 42)
        XCTAssertEqual(
            str(o.canonicalBytes()),
            "flagship/order/set-front-page/v1|home.alice.flagship.services||42"
        )
    }

    func testSignVerifyRoundTrip() {
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
        let o = SetFrontPageOrder(serverId: server, label: "blog", issuedAt: 1)
        let sig = try! o.sign(with: key)
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: o.canonicalBytes()))
    }

    /// The TS suite's pinned signature (seed-7 key, photos, 1700) must verify
    /// against the bytes THIS mirror builds — proving cross-language identity
    /// even though CryptoKit's own signatures are randomized.
    func testTsPinnedVectorVerifies() {
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
        let o = SetFrontPageOrder(serverId: server, label: "photos", issuedAt: 1700)
        let tsSig = Data(HexUtil.decode(
            "bc57770c09c3f54d9acdb628bd4767142ea035d944c88e7de340c10df84a67b9"
                + "aa62800fdb597624a3f49ccec222d2c46ff64eadaa80111964946240a2fc9405")!)
        XCTAssertTrue(key.publicKey.isValidSignature(tsSig, for: o.canonicalBytes()))
    }

    func testEnvelopeWireShape() {
        let o = SetFrontPageOrder(serverId: server, label: "photos", issuedAt: 5)
        let env = o.envelope(signatureHex: "ab")
        let req = env["request"] as! [String: Any]
        XCTAssertEqual(req["type"] as? String, "set-front-page")
        XCTAssertEqual(req["serverId"] as? String, server)
        XCTAssertEqual(req["label"] as? String, "photos")
        XCTAssertEqual(req["issuedAt"] as? Int64, 5)
        XCTAssertEqual(env["signature"] as? String, "ab")
    }
}
