import XCTest
@testable import FlagshipBuilderCore

/// Coverage for the live-countdown expiry helper added in this session.
final class VerifyResultExpiryTests: XCTestCase {
    private func makeResult(expiresAtISO: String?) -> VerifyResult {
        VerifyResult(
            ok: true,
            serverDomain: "home.harry.flagship.services",
            username: "harry",
            serverName: "home",
            expiresAt: expiresAtISO,
            installerGitRef: "main",
            signatureValid: true,
        )
    }

    func testExpiresAtDateParsesISO8601WithFraction() {
        let r = makeResult(expiresAtISO: "2026-05-21T20:00:00.000Z")
        XCTAssertNotNil(r.expiresAtDate)
    }

    func testExpiresAtDateParsesISO8601WithoutFraction() {
        let r = makeResult(expiresAtISO: "2026-05-21T20:00:00Z")
        XCTAssertNotNil(r.expiresAtDate)
    }

    func testExpiresAtDateNilWhenMissing() {
        XCTAssertNil(makeResult(expiresAtISO: nil).expiresAtDate)
    }

    private func relative(_ secondsFromExpiry: TimeInterval, isoString: String = "2026-05-21T20:00:00.000Z") -> (VerifyResult, Date) {
        let r = makeResult(expiresAtISO: isoString)
        let exp = r.expiresAtDate!
        let now = exp.addingTimeInterval(-secondsFromExpiry)
        return (r, now)
    }

    func testExpiryLabelShowsFutureInHours() {
        let (r, now) = relative(5 * 3600 + 47 * 60) // 5h 47m to expiry
        XCTAssertEqual(r.expiryLabel(now: now), "expires in 5h 47m")
    }

    func testExpiryLabelShowsFutureInMinutes() {
        let (r, now) = relative(30 * 60)
        XCTAssertEqual(r.expiryLabel(now: now), "expires in 30m")
    }

    func testExpiryLabelShowsExpired() {
        let (r, now) = relative(-3 * 60) // 3m past expiry
        XCTAssertEqual(r.expiryLabel(now: now), "expired 3m ago")
    }

    func testExpiryLabelShowsSecondsWhenUnderMinute() {
        let (r, now) = relative(30)
        XCTAssertEqual(r.expiryLabel(now: now), "expires in 30s")
    }
}
