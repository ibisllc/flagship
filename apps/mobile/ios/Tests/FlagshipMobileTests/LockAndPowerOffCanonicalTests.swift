import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the Swift canonical bytes for the lock/power-off + dead-man envelopes
/// to the EXACT cross-platform vectors in
/// `packages/protocol/tests/lockAndPowerOff.test.ts`. The daemon re-derives
/// these bytes to verify the Ed25519 signature, so any drift in the tag, the
/// `|` separator, field order, the enabled `0|1` flag, or the nonce-hex /
/// issuedAt stringification would break live power-offs + affirmations.
///
/// The repo enforces TS↔Swift byte-identity for canonical bytes; these are
/// the Swift half of that pin.
final class LockAndPowerOffCanonicalTests: XCTestCase {
    private let server = "home.alice.flagship.services"

    private func str(_ d: Data) -> String { String(data: d, encoding: .utf8)! }

    // MARK: power-off PhoneOrder

    func testPowerOffCanonicalOff() {
        let o = PowerOffOrder(serverId: server, mode: .off, issuedAt: 1700)
        XCTAssertEqual(str(o.canonicalBytes()), "flagship/order/power-off/v1|home.alice.flagship.services|off|1700")
    }

    func testPowerOffCanonicalRestart() {
        let o = PowerOffOrder(serverId: server, mode: .restart, issuedAt: 42)
        XCTAssertEqual(str(o.canonicalBytes()), "flagship/order/power-off/v1|home.alice.flagship.services|restart|42")
    }

    func testPowerOffSignVerifyRoundTrip() {
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
        for mode in PowerMode.allCases {
            let o = PowerOffOrder(serverId: server, mode: mode, issuedAt: 1)
            let sig = try! o.sign(with: key)
            XCTAssertTrue(key.publicKey.isValidSignature(sig, for: o.canonicalBytes()))
        }
    }

    func testPowerOffEnvelopeWireShape() {
        let o = PowerOffOrder(serverId: server, mode: .off, issuedAt: 5)
        let env = o.envelope(signatureHex: "ab")
        let req = env["request"] as! [String: Any]
        XCTAssertEqual(req["type"] as? String, "power-off")
        XCTAssertEqual(req["serverId"] as? String, server)
        XCTAssertEqual(req["mode"] as? String, "off")
        XCTAssertEqual(req["issuedAt"] as? Int64, 5)
        XCTAssertEqual(env["signature"] as? String, "ab")
    }
}
