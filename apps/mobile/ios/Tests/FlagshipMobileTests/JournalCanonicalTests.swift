import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the Swift canonical bytes for the journal-read envelope to the EXACT
/// string the daemon (`journalHttp.ts`) + webapp (`webappJournal.test.ts`)
/// re-derive to verify the Ed25519 signature. Any drift in the tag, the `|`
/// separator, field order, or the lines/issuedAt stringification would break
/// live journal reads.
final class JournalCanonicalTests: XCTestCase {
    private let server = "home.alice.flagship.services"

    private func str(_ d: Data) -> String { String(data: d, encoding: .utf8)! }

    private let nonce = String(repeating: "ab", count: 16)

    func testJournalCanonical() {
        let r = JournalRequest(serverId: server, unit: "flagship-daemon", lines: 200, nonce: nonce, issuedAt: 1700)
        XCTAssertEqual(
            str(r.canonicalBytes()),
            "flagship/journal-read/v2|home.alice.flagship.services|flagship-daemon|200|\(nonce)|1700"
        )
    }

    /// Each read is single-use (review 2026-10-25 #15): a fresh 32-hex nonce per request, and none signed malformed.
    func testJournalNonceIsFreshAndChecked() {
        let a = JournalRequest(serverId: server, unit: "flagship-daemon", lines: 1, issuedAt: 1)
        let b = JournalRequest(serverId: server, unit: "flagship-daemon", lines: 1, issuedAt: 1)
        XCTAssertTrue(JournalRequest.validNonce(a.nonce))
        XCTAssertNotEqual(a.nonce, b.nonce)
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
        for bad in ["", "AB" + String(repeating: "a", count: 30), "abcd", String(repeating: "a", count: 31) + "|"] {
            XCTAssertThrowsError(try JournalRequest(serverId: server, unit: "flagship-daemon", lines: 1, nonce: bad, issuedAt: 1).sign(with: key))
        }
    }

    func testJournalSignVerifyRoundTrip() {
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
        let r = JournalRequest(serverId: server, unit: "flagship-daemon", lines: 50, issuedAt: 1)
        let sig = try! r.sign(with: key)
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: r.canonicalBytes()))
    }

    /// Journal is standalone (not a PhoneOrder) — the wire `request` carries NO
    /// `type` field, matching the daemon's `parseJournalRequest` + the webapp.
    func testJournalEnvelopeWireShapeHasNoType() {
        let r = JournalRequest(serverId: server, unit: "flagship-daemon", lines: 100, nonce: nonce, issuedAt: 5)
        let env = r.envelope(signatureHex: "ab")
        let req = env["request"] as! [String: Any]
        XCTAssertNil(req["type"])
        XCTAssertEqual(req["serverId"] as? String, server)
        XCTAssertEqual(req["unit"] as? String, "flagship-daemon")
        XCTAssertEqual(req["lines"] as? Int64, 100)
        XCTAssertEqual(req["nonce"] as? String, nonce)
        XCTAssertEqual(req["issuedAt"] as? Int64, 5)
        XCTAssertEqual(env["signature"] as? String, "ab")
    }
}
