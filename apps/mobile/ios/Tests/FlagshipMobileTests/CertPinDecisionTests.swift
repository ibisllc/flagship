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
