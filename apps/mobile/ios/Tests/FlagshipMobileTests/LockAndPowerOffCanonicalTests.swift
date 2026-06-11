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

    // MARK: SetDeadManPolicy

    func testPolicyCanonical() {
        let p = DeadManPolicy(
            serverId: server, enabled: true,
            windowMs: 24 * 3600_000, graceMs: 6 * 3600_000,
            lockoutMode: .off, issuedAt: 1000
        )
        XCTAssertEqual(
            str(p.canonicalBytes()),
            "flagship/set-deadman-policy/v1|home.alice.flagship.services|1|86400000|21600000|off|1000"
        )
    }

    func testPolicyDisabledFlag() {
        let p = DeadManPolicy(
            serverId: server, enabled: false,
            windowMs: 60000, graceMs: 0, lockoutMode: .restart, issuedAt: 1
        )
        XCTAssertEqual(
            str(p.canonicalBytes()),
            "flagship/set-deadman-policy/v1|home.alice.flagship.services|0|60000|0|restart|1"
        )
    }

    func testPolicyEnvelopeWireShape() {
        let p = DeadManPolicy(serverId: server, enabled: true, windowMs: 1, graceMs: 2, lockoutMode: .restart, issuedAt: 3)
        let env = p.envelope(signatureHex: "cd")
        let req = env["request"] as! [String: Any]
        XCTAssertEqual(req["serverId"] as? String, server)
        XCTAssertEqual(req["enabled"] as? Bool, true)
        XCTAssertEqual(req["windowMs"] as? Int64, 1)
        XCTAssertEqual(req["graceMs"] as? Int64, 2)
        XCTAssertEqual(req["lockoutMode"] as? String, "restart")
        XCTAssertEqual(req["issuedAt"] as? Int64, 3)
    }

    // MARK: DeadManAffirmation

    func testAffirmCanonical() {
        let a = DeadManAffirmation(serverId: server, nonce: Data(repeating: 0xab, count: 16), issuedAt: 2000)
        let nonceHex = String(repeating: "ab", count: 16)
        XCTAssertEqual(
            str(a.canonicalBytes()),
            "flagship/deadman-affirm/v1|home.alice.flagship.services|\(nonceHex)|2000"
        )
    }

    func testAffirmEnvelopeWireShapeNonceIsHex() {
        let a = DeadManAffirmation(serverId: server, nonce: Data(repeating: 0xab, count: 16), issuedAt: 2000)
        let env = a.envelope(signatureHex: "ef")
        let req = env["request"] as! [String: Any]
        // Daemon's parseAffirm reads `nonce` as a hex STRING.
        XCTAssertEqual(req["nonce"] as? String, String(repeating: "ab", count: 16))
        XCTAssertEqual(req["serverId"] as? String, server)
        XCTAssertEqual(req["issuedAt"] as? Int64, 2000)
    }

    func testFreshNonceIs16Bytes() {
        XCTAssertEqual(DeadManAffirmation.freshNonce().count, 16)
        XCTAssertNotEqual(DeadManAffirmation.freshNonce(), DeadManAffirmation.freshNonce())
    }
}
