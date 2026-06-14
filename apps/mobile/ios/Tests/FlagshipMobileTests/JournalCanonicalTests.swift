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

    func testJournalCanonical() {
        let r = JournalRequest(serverId: server, unit: "flagship-daemon", lines: 200, issuedAt: 1700)
        XCTAssertEqual(
            str(r.canonicalBytes()),
            "flagship/journal-read/v1|home.alice.flagship.services|flagship-daemon|200|1700"
        )
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
        let r = JournalRequest(serverId: server, unit: "flagship-daemon", lines: 100, issuedAt: 5)
        let env = r.envelope(signatureHex: "ab")
        let req = env["request"] as! [String: Any]
        XCTAssertNil(req["type"])
        XCTAssertEqual(req["serverId"] as? String, server)
        XCTAssertEqual(req["unit"] as? String, "flagship-daemon")
        XCTAssertEqual(req["lines"] as? Int64, 100)
        XCTAssertEqual(req["issuedAt"] as? Int64, 5)
        XCTAssertEqual(env["signature"] as? String, "ab")
    }
}
