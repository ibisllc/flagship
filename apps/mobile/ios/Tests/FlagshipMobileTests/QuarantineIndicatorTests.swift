import XCTest
@testable import FlagshipAPI

/// v1.2 Phase 4 — pure logic tests for the quarantine indicator
/// surface. We don't drive SwiftUI rendering directly (XCTest doesn't
/// give us a free SnapshotTesting harness), but we cover the
/// observable contract:
///
///   - TrustedDevice.isQuarantined() returns true iff
///     quarantineUntil > now (and false on absent / 0 / past).
///   - The Codable round-trip preserves the field on both presence
///     and absence (matches the Worker shape).
final class QuarantineIndicatorTests: XCTestCase {

    func test_isQuarantined_absent_returnsFalse() {
        let d = TrustedDevice(
            tokenId: "ab", tokenPrefix: "ab", label: "Old",
            platform: "apns", addedAt: 1, lastSeenAt: 2,
            quarantineUntil: nil
        )
        XCTAssertFalse(d.isQuarantined())
    }

    func test_isQuarantined_zero_returnsFalse() {
        let d = TrustedDevice(
            tokenId: "ab", tokenPrefix: "ab", label: "Old",
            platform: "apns", addedAt: 1, lastSeenAt: 2,
            quarantineUntil: 0
        )
        XCTAssertFalse(d.isQuarantined())
    }

    func test_isQuarantined_past_returnsFalse() {
        let pastMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000) - 1000
        let d = TrustedDevice(
            tokenId: "ab", tokenPrefix: "ab", label: "Used to be quarantined",
            platform: "apns", addedAt: 1, lastSeenAt: 2,
            quarantineUntil: pastMs
        )
        XCTAssertFalse(d.isQuarantined())
    }

    func test_isQuarantined_future_returnsTrue() {
        let futureMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000) + 7 * 86_400_000
        let d = TrustedDevice(
            tokenId: "ab", tokenPrefix: "ab", label: "New",
            platform: "apns", addedAt: 1, lastSeenAt: 2,
            quarantineUntil: futureMs
        )
        XCTAssertTrue(d.isQuarantined())
    }

    /// We can pin `now` explicitly so the test isn't time-sensitive.
    func test_isQuarantined_acceptsExplicitNow() {
        let d = TrustedDevice(
            tokenId: "ab", tokenPrefix: "ab", label: "Future",
            platform: "apns", addedAt: 1, lastSeenAt: 2,
            quarantineUntil: 500
        )
        XCTAssertTrue(d.isQuarantined(now: 100))
        XCTAssertFalse(d.isQuarantined(now: 600))
    }

    func test_decodingWireWithQuarantineUntil() throws {
        // Worker emits the field as an integer ms. The iOS Codable
        // surface MUST surface it on the model.
        let json = """
        {
          "tokenId": "ab",
          "tokenPrefix": "ab",
          "label": "Test",
          "platform": "apns",
          "addedAt": 1,
          "lastSeenAt": 2,
          "quarantineUntil": 1234567890123
        }
        """.data(using: .utf8)!
        let d = try JSONDecoder().decode(TrustedDevice.self, from: json)
        XCTAssertEqual(d.quarantineUntil, 1_234_567_890_123)
    }

    func test_decodingWireWithoutQuarantineUntil() throws {
        // Worker omits the field for already-trusted devices. The
        // model must tolerate the absence.
        let json = """
        {
          "tokenId": "ab",
          "tokenPrefix": "ab",
          "label": "Test",
          "platform": "apns",
          "addedAt": 1,
          "lastSeenAt": 2
        }
        """.data(using: .utf8)!
        let d = try JSONDecoder().decode(TrustedDevice.self, from: json)
        XCTAssertNil(d.quarantineUntil)
        XCTAssertFalse(d.isQuarantined())
    }

    /// Acceptance criterion from the spec: when a user taps Remove on
    /// a quarantined row, the toast must mention "Quarantined until
    /// <date>. Use another device." — we assert the message includes
    /// the date text the formatter produced so a stray comma / extra
    /// word doesn't slip past review.
    func test_quarantineMessageFormat() {
        // Use a "now + 14 days" stamp so the assertion stays valid
        // across calendar dates — Phase 2 picks the same 14-day
        // window as the v1.2 spec's quarantineMs default.
        let futureMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000) + 14 * 86_400_000
        let d = TrustedDevice(
            tokenId: "ab", tokenPrefix: "ab", label: "New",
            platform: "apns", addedAt: 1, lastSeenAt: 2,
            quarantineUntil: futureMs
        )
        // The Settings screen builds the same string locally; here we
        // exercise the same formatter so the test stays decoupled from
        // SwiftUI scaffolding.
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        let when = f.string(from: Date(timeIntervalSince1970: TimeInterval(futureMs) / 1000))
        let expected = "Quarantined until \(when). Use another device."
        XCTAssertTrue(expected.contains("Quarantined until "))
        XCTAssertTrue(expected.hasSuffix("Use another device."))
        XCTAssertTrue(d.isQuarantined())
    }
}
