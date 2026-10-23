import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// SECURITY-HARDENING-PLAN.md 7.1: a request to a box this phone knows is never allowed to fall
/// back to ordinary web trust when no verified pin exists.
final class KnownBoxPinTests: XCTestCase {
    let domain = "home.alice.flagship.services"
    let pin = String(repeating: "ab", count: 32)

    func testKnownBoxWithoutAPinIsBlocked() {
        XCTAssertEqual(
            CertPinDecision.verdict(host: domain, leafDerSha256Hex: pin, pinFor: { _ in nil }, isKnownBox: { _ in true }),
            .blocked
        )
        // An unreadable leaf makes no difference: there is no pin to compare with.
        XCTAssertEqual(
            CertPinDecision.verdict(host: domain, leafDerSha256Hex: nil, pinFor: { _ in nil }, isKnownBox: { _ in true }),
            .blocked
        )
    }

    func testAHostThatIsNotABoxKeepsOrdinaryTrust() {
        XCTAssertEqual(
            CertPinDecision.verdict(host: "flagshipserver.com", leafDerSha256Hex: pin, pinFor: { _ in nil }, isKnownBox: { _ in false }),
            .noPin
        )
    }

    func testAPinStillDecidesWhenThereIsOne() {
        XCTAssertEqual(CertPinDecision.verdict(host: domain, leafDerSha256Hex: pin, pinFor: { _ in self.pin }, isKnownBox: { _ in true }), .match)
        XCTAssertEqual(CertPinDecision.verdict(host: domain, leafDerSha256Hex: String(repeating: "cd", count: 32), pinFor: { _ in self.pin }, isKnownBox: { _ in true }), .mismatch)
    }

    func testRegistryKnowsABoxAndEverythingUnderItsWildcard() {
        let reg = CertPinRegistry(persistingIn: nil)
        XCTAssertFalse(reg.isKnownBox(host: domain))
        reg.registerBoxStk(domain: domain, stkPub: Data(repeating: 7, count: 32))
        XCTAssertTrue(reg.isKnownBox(host: domain))
        XCTAssertTrue(reg.isKnownBox(host: "Chess.\(domain)."))
        XCTAssertFalse(reg.isKnownBox(host: "evil\(domain)"))
        XCTAssertFalse(reg.isKnownBox(host: "alice.flagship.services"))
        XCTAssertFalse(reg.isKnownBox(host: "flagshipserver.com"))
    }

    func testEnrollmentIsOneNamedHostForAShortTime() {
        let reg = CertPinRegistry(persistingIn: nil)
        reg.registerBoxStk(domain: domain, stkPub: Data(repeating: 7, count: 32))
        reg.allowUnpinnedEnrollment(host: domain, forSeconds: 60)
        XCTAssertFalse(reg.isKnownBox(host: domain), "inside the window the exchange may proceed")
        reg.allowUnpinnedEnrollment(host: domain, forSeconds: -1)
        XCTAssertTrue(reg.isKnownBox(host: domain), "a window that has passed no longer applies")
        // Another box is not covered.
        reg.registerBoxStk(domain: "home2.alice.flagship.services", stkPub: Data(repeating: 8, count: 32))
        reg.allowUnpinnedEnrollment(host: domain, forSeconds: 60)
        XCTAssertTrue(reg.isKnownBox(host: "home2.alice.flagship.services"))
    }

    func testTheMissingPinIsReportedSoTheAppRefreshesInsteadOfShowingAGenericError() {
        let sink = CertPinMismatchSink()
        sink.recordMissingPin(host: domain, nowMs: 1_000)
        XCTAssertTrue(sink.consumeRecentMissingPin(host: domain, nowMs: 2_000))
        XCTAssertFalse(sink.consumeRecentMissingPin(host: domain, nowMs: 2_100), "consumed once")
        sink.recordMissingPin(host: domain, nowMs: 1_000)
        XCTAssertFalse(sink.consumeRecentMissingPin(host: domain, nowMs: 100_000), "stale entries do not bleed into later failures")
    }
}
