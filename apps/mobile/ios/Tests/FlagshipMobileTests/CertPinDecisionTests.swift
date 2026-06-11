import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// The pure box-pinning accept/refuse decision (FlagshipAPI.CertPinDecision)
/// — the logic behind BoxCertPinningDelegate, testable without a SecTrust.
/// HARD-FAIL semantics (locked): a host with a pin is refused unless the
/// served leaf cert's DER SHA-256 equals it; a host with no pin keeps the
/// default trust result.
final class CertPinDecisionTests: XCTestCase {
    let pin = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    let other = String(repeating: "ab", count: 32)

    func testNoPinLeavesDefaultResultStanding() {
        XCTAssertEqual(
            CertPinDecision.verdict(host: "flagshipserver.com", leafDerSha256Hex: other, pinFor: { _ in nil }),
            .noPin
        )
        // Even an unreadable leaf is fine when nothing is pinned.
        XCTAssertEqual(
            CertPinDecision.verdict(host: "x.example", leafDerSha256Hex: nil, pinFor: { _ in nil }),
            .noPin
        )
    }

    func testMatchingLeafAccepts() {
        XCTAssertEqual(
            CertPinDecision.verdict(host: "abc5.harry1.flagship.services", leafDerSha256Hex: pin, pinFor: { _ in self.pin }),
            .match
        )
    }

    func testMatchIsCaseInsensitive() {
        XCTAssertEqual(
            CertPinDecision.verdict(host: "abc5.harry1.flagship.services", leafDerSha256Hex: pin.uppercased(), pinFor: { _ in self.pin }),
            .match
        )
    }

    func testMismatchedLeafHardFails() {
        XCTAssertEqual(
            CertPinDecision.verdict(host: "abc5.harry1.flagship.services", leafDerSha256Hex: other, pinFor: { _ in self.pin }),
            .mismatch
        )
    }

    func testUnreadableLeafOnPinnedHostHardFails() {
        // A pinned box is HTTPS with a readable leaf by construction —
        // failure to read it must not become a bypass.
        XCTAssertEqual(
            CertPinDecision.verdict(host: "abc5.harry1.flagship.services", leafDerSha256Hex: nil, pinFor: { _ in self.pin }),
            .mismatch
        )
    }

    func testDecisionConsultsRegistryWithTheChallengeHost() {
        // End-to-end with a real registry: the service-subdomain lookup
        // resolves to the box pin, exactly as the URLSession delegate will
        // consult it.
        let reg = CertPinRegistry(persistingIn: nil)
        let stkPub = HexUtil.decode(DaemonStatusVerifierTests.stkPubHex)!
        reg.registerBoxStk(domain: DaemonStatusVerifierTests.report.serverDomain, stkPub: stkPub)
        reg.update(
            pods: [PodDirectoryEntry(
                serverDomain: DaemonStatusVerifierTests.report.serverDomain,
                identityPubKey: String(repeating: "00", count: 32),
                signedStatus: SignedDaemonStatus(
                    report: DaemonStatusVerifierTests.report,
                    signatureHex: DaemonStatusVerifierTests.sigHex
                )
            )],
            nowMs: DaemonStatusVerifierTests.report.issuedAt + 1
        )
        let lookup: (String) -> String? = { reg.pinFor(host: $0) }
        XCTAssertEqual(
            CertPinDecision.verdict(
                host: "wiki.abc5.harry1.flagship.services",
                leafDerSha256Hex: pin,
                pinFor: lookup
            ),
            .match
        )
        XCTAssertEqual(
            CertPinDecision.verdict(
                host: "wiki.abc5.harry1.flagship.services",
                leafDerSha256Hex: other,
                pinFor: lookup
            ),
            .mismatch
        )
        XCTAssertEqual(
            CertPinDecision.verdict(host: "flagshipserver.com", leafDerSha256Hex: other, pinFor: lookup),
            .noPin
        )
    }
}

/// UX-A — the mismatch sink that lets a client recognise a hard-fail pin
/// mismatch (which surfaces as a generic transport cancellation) and report
/// the distinct "someone may be intercepting" error.
final class CertPinMismatchSinkTests: XCTestCase {
    func testRecordedMismatchIsConsumedOnceWithinWindow() {
        let sink = CertPinMismatchSink()
        sink.record(host: "abc5.harry1.flagship.services", nowMs: 1_000)
        // Fresh: claimable.
        XCTAssertTrue(sink.consumeRecentMismatch(host: "abc5.harry1.flagship.services", nowMs: 1_500))
        // Consumed: a second read finds nothing (can't bleed into a later
        // unrelated failure).
        XCTAssertFalse(sink.consumeRecentMismatch(host: "abc5.harry1.flagship.services", nowMs: 1_600))
    }

    func testStaleMismatchIsNotClaimed() {
        let sink = CertPinMismatchSink()
        sink.record(host: "abc5.harry1.flagship.services", nowMs: 1_000)
        let tooLate = 1_000 + CertPinMismatchSink.freshnessMs + 1
        XCTAssertFalse(sink.consumeRecentMismatch(host: "abc5.harry1.flagship.services", nowMs: tooLate))
    }

    func testNormalisesHostCaseAndTrailingDot() {
        let sink = CertPinMismatchSink()
        sink.record(host: "ABC5.harry1.flagship.services.", nowMs: 1_000)
        XCTAssertTrue(sink.consumeRecentMismatch(host: "abc5.harry1.flagship.services", nowMs: 1_100))
    }

    func testUnrelatedHostNeverClaims() {
        let sink = CertPinMismatchSink()
        sink.record(host: "abc5.harry1.flagship.services", nowMs: 1_000)
        XCTAssertFalse(sink.consumeRecentMismatch(host: "other.harry1.flagship.services", nowMs: 1_100))
    }
}

/// UX-A/UX-B — ScreensClientError plain-language presentation. No surface
/// should ever show a raw status code or a server-supplied message string.
final class ScreensClientErrorPlainLanguageTests: XCTestCase {
    func testHttpNeverLeaksStatusCodeOrServerMessage() {
        let err = ScreensClientError.http(status: 503, message: "upstream connect error 111")
        let shown = err.errorDescription ?? ""
        XCTAssertFalse(shown.contains("503"))
        XCTAssertFalse(shown.lowercased().contains("upstream"))
        XCTAssertFalse(shown.contains("HTTP"))
        XCTAssertTrue(shown.lowercased().contains("temporarily unavailable"))
    }

    func testStatusBuckets() {
        XCTAssertTrue(ScreensClientError.plainLanguage(forStatus: 500).lowercased().contains("temporarily unavailable"))
        XCTAssertTrue(ScreensClientError.plainLanguage(forStatus: 404).lowercased().contains("couldn't find"))
        XCTAssertTrue(ScreensClientError.plainLanguage(forStatus: 429).lowercased().contains("busy"))
        XCTAssertTrue(ScreensClientError.plainLanguage(forStatus: 401).lowercased().contains("signed in"))
        XCTAssertTrue(ScreensClientError.plainLanguage(forStatus: 400).lowercased().contains("connection"))
        XCTAssertTrue(ScreensClientError.plainLanguage(forStatus: 0).lowercased().contains("connection"))
    }

    func testCertPinMismatchReadsAsInterceptionWarning() {
        let err = ScreensClientError.certPinMismatch(host: "abc5.harry1.flagship.services")
        let shown = err.errorDescription ?? ""
        XCTAssertTrue(shown.lowercased().contains("intercept"))
        XCTAssertTrue(shown.lowercased().contains("certificate"))
        // No raw host / jargon leak.
        XCTAssertFalse(shown.contains("HTTP"))
    }

    func testUserFacingFallsBackForRawErrors() {
        struct Raw: Error {}
        // A non-ScreensClientError collapses to a single honest message —
        // never Apple's developer-facing localizedDescription.
        let shown = ScreensClientError.userFacing(Raw())
        XCTAssertTrue(shown.lowercased().contains("couldn't reach"))
        // A ScreensClientError routes through its plain-language description.
        let pinShown = ScreensClientError.userFacing(
            ScreensClientError.certPinMismatch(host: "x.y.flagship.services")
        )
        XCTAssertTrue(pinShown.lowercased().contains("intercept"))
    }
}
