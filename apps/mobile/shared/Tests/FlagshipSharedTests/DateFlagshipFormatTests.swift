import XCTest
@testable import FlagshipCore

final class DateFlagshipFormatTests: XCTestCase {
    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }
    private let enUS = Locale(identifier: "en_US")
    // 2024-07-04 12:00:00 UTC
    private let now = Date(timeIntervalSince1970: 1_720_094_400)

    private func fmt(_ date: Date, includeTime: Bool = false) -> String {
        date.flagshipFormatted(now: now, includeTime: includeTime, calendar: utc, locale: enUS)
    }

    func testJustNow() {
        XCTAssertEqual(fmt(now.addingTimeInterval(-30)), "just now")
        XCTAssertEqual(fmt(now.addingTimeInterval(-59)), "just now")
    }

    func testMinutesAgo() {
        XCTAssertEqual(fmt(now.addingTimeInterval(-5 * 60)), "5m ago")
        XCTAssertEqual(fmt(now.addingTimeInterval(-59 * 60)), "59m ago")
    }

    func testHoursAgo() {
        XCTAssertEqual(fmt(now.addingTimeInterval(-3 * 3600)), "3h ago")
        XCTAssertEqual(fmt(now.addingTimeInterval(-23 * 3600)), "23h ago")
    }

    func testSameYearAbsolute() {
        // 40 days earlier — same calendar year, no year in the string.
        let s = fmt(now.addingTimeInterval(-40 * 86400))
        XCTAssertTrue(s.contains("May"), s)
        XCTAssertFalse(s.contains("2024"), s)
    }

    func testOlderIncludesYear() {
        let s = fmt(now.addingTimeInterval(-400 * 86400))
        XCTAssertTrue(s.contains("2023"), s)
    }

    func testIncludeTimeSameYear() {
        // Two hours before "now" is > 24h? No — use a fixed same-year past date.
        let s = fmt(now.addingTimeInterval(-40 * 86400), includeTime: true)
        XCTAssertTrue(s.contains("May"), s)
        XCTAssertTrue(s.contains(":"), s)
    }

    func testEpochMsConvenience() {
        let ms = Int64((now.timeIntervalSince1970 - 300) * 1000)
        XCTAssertEqual(Date.flagshipFormatted(epochMs: ms, now: now), "5m ago")
    }
}
