import XCTest
import FlagshipAPI
@testable import FlagshipCore

/// CertPinRegistry — the /pods → pin reconciliation. Uses the pinned
/// cross-platform daemon-status vector (see DaemonStatusVerifierTests);
/// every registry here is in-memory (`persistingIn: nil`).
final class CertPinRegistryTests: XCTestCase {
    let domain = DaemonStatusVerifierTests.report.serverDomain
    let pinHex = DaemonStatusVerifierTests.report.certSha256!
    var umkSeed: Data { HexUtil.decode(DaemonStatusVerifierTests.umkSeedHex)! }
    /// 1 s after the report was issued — comfortably fresh.
    var now: Int64 { DaemonStatusVerifierTests.report.issuedAt + 1_000 }

    func makePod(
        serverDomain: String? = nil,
        report: DaemonStatusReport = DaemonStatusVerifierTests.report,
        signatureHex: String = DaemonStatusVerifierTests.sigHex,
        revokedAt: Int64? = nil,
        signedStatus: Bool = true
    ) -> PodDirectoryEntry {
        PodDirectoryEntry(
            serverDomain: serverDomain ?? domain,
            identityPubKey: String(repeating: "00", count: 32), // the UNTRUSTED echo
            revokedAt: revokedAt,
            signedStatus: signedStatus
                ? SignedDaemonStatus(report: report, signatureHex: signatureHex)
                : nil
        )
    }

    // MARK: - Install + lookup

    func testVerifiedSignedStatusInstallsPin() {
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: now)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)
    }

    func testServiceHostUnderTheBoxSharesThePin() {
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: now)
        // <service>.<server>.<user> rides the box's wildcard cert.
        XCTAssertEqual(reg.pinFor(host: "wiki.\(domain)"), pinHex)
        XCTAssertEqual(reg.pinFor(host: "a.b.\(domain)"), pinHex)
    }

    func testLookupNormalizesCaseAndTrailingDot() {
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: now)
        XCTAssertEqual(reg.pinFor(host: domain.uppercased() + "."), pinHex)
    }

    func testUnrelatedHostsHaveNoPin() {
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: now)
        XCTAssertNil(reg.pinFor(host: "flagshipserver.com"))
        XCTAssertNil(reg.pinFor(host: "other.harry1.flagship.services"))
        // Suffix match must not fire on a partial label.
        XCTAssertNil(reg.pinFor(host: "evil-" + domain))
    }

    // MARK: - The STK-pub cache (iOS biometric twist)

    func testNoCachedStkPubMeansNoPin() {
        let reg = CertPinRegistry(persistingIn: nil)
        // Seedless update with an empty cache: nothing to verify against.
        reg.update(pods: [makePod()], nowMs: now)
        XCTAssertNil(reg.pinFor(host: domain))
    }

    func testRegisteredStkPubEnablesSeedlessUpdate() {
        let reg = CertPinRegistry(persistingIn: nil)
        let stkPub = HexUtil.decode(DaemonStatusVerifierTests.stkPubHex)!
        reg.registerBoxStk(domain: domain, stkPub: stkPub)
        reg.update(pods: [makePod()], nowMs: now)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)
    }

    func testWrongSeedLengthInstallsNothing() {
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(pods: [makePod()], umkSeed: Data([7, 7]), nowMs: now)
        XCTAssertNil(reg.pinFor(host: domain))
    }

    // MARK: - Refusals (each one ⇒ no pin, never a crash)

    func testBadSignatureInstallsNothing() {
        let reg = CertPinRegistry(persistingIn: nil)
        let badSig = String(repeating: "ab", count: 64)
        reg.update(pods: [makePod(signatureHex: badSig)], umkSeed: umkSeed, nowMs: now)
        XCTAssertNil(reg.pinFor(host: domain))
    }

    func testReportForAnotherBoxDoesNotPinThisPod() {
        let reg = CertPinRegistry(persistingIn: nil)
        // A VALID signed report for abc5… attached to a different pod must
        // not pin that pod's domain.
        let other = "other.harry1.flagship.services"
        reg.update(pods: [makePod(serverDomain: other)], umkSeed: umkSeed, nowMs: now)
        XCTAssertNil(reg.pinFor(host: other))
        XCTAssertNil(reg.pinFor(host: domain))
    }

    func testStaleReportInstallsNothing() {
        let reg = CertPinRegistry(persistingIn: nil)
        let issuedAt = DaemonStatusVerifierTests.report.issuedAt
        let justStale = issuedAt + DaemonStatus.maxReportAgeMs + 1
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: justStale)
        XCTAssertNil(reg.pinFor(host: domain))
        // Exactly at the bound is still fresh.
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: issuedAt + DaemonStatus.maxReportAgeMs)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)
    }

    func testRevokedPodInstallsNothing() {
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(pods: [makePod(revokedAt: 1)], umkSeed: umkSeed, nowMs: now)
        XCTAssertNil(reg.pinFor(host: domain))
    }

    func testNullCertVariantInstallsNothing() {
        // The null variant verifies (it's genuinely signed) but carries no
        // fingerprint — liveness-only report, nothing to pin.
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(
            pods: [makePod(
                report: DaemonStatusVerifierTests.nullReport,
                signatureHex: DaemonStatusVerifierTests.nullSigHex
            )],
            umkSeed: umkSeed,
            nowMs: now
        )
        XCTAssertNil(reg.pinFor(host: domain))
    }

    // MARK: - Reconciliation semantics

    func testPodWithoutSignedStatusClearsItsPreviousPin() {
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: now)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)
        // Next refresh: the relay dropped (or the box renewed and the new
        // report hasn't landed) — fall back to default validation, never
        // hard-fail on the old pin.
        reg.update(pods: [makePod(signedStatus: false)], nowMs: now)
        XCTAssertNil(reg.pinFor(host: domain))
    }

    func testClearDropsPinsAndStkPubs() {
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: now)
        reg.clear()
        XCTAssertNil(reg.pinFor(host: domain))
        // The STK-pub cache went with it: a seedless re-update can't re-pin.
        reg.update(pods: [makePod()], nowMs: now)
        XCTAssertNil(reg.pinFor(host: domain))
    }

    func testMockStyleEntriesInstallNothing() {
        // Demo/mock directories never fabricate signedStatus (the memberwise
        // default is nil) — processing them must leave the registry empty.
        let reg = CertPinRegistry(persistingIn: nil)
        let mockEntry = PodDirectoryEntry(
            serverDomain: "home.demo.flagship.services",
            identityPubKey: String(repeating: "11", count: 32)
        )
        reg.update(pods: [mockEntry], umkSeed: umkSeed, nowMs: now)
        XCTAssertNil(reg.pinFor(host: "home.demo.flagship.services"))
    }
}

/// The `/pods` wire decoding of `signedStatus` — lenient by design.
final class PodSignedStatusDecodingTests: XCTestCase {
    func decodeEntry(_ json: String) throws -> PodDirectoryEntry {
        try JSONDecoder().decode(PodDirectoryEntry.self, from: Data(json.utf8))
    }

    func testDecodesSignedStatusNextToCurrentCert() throws {
        let json = """
        {
          "serverDomain": "abc5.harry1.flagship.services",
          "identityPubKey": "\(DaemonStatusVerifierTests.stkPubHex)",
          "lastReported": 1700000000000,
          "currentCert": { "sha256": "\(DaemonStatusVerifierTests.report.certSha256!)" },
          "signedStatus": {
            "report": {
              "serverDomain": "abc5.harry1.flagship.services",
              "certSha256": "\(DaemonStatusVerifierTests.report.certSha256!)",
              "certValidUntil": 1800000000000,
              "certIssuer": "C=US, O=Let's Encrypt, CN=YR1",
              "appsServed": ["wiki.abc5.harry1.flagship.services", "abc5.harry1.flagship.services"],
              "nonce": "00112233445566778899aabbccddeeff",
              "issuedAt": 1700000000000
            },
            "signatureHex": "\(DaemonStatusVerifierTests.sigHex)"
          }
        }
        """
        let entry = try decodeEntry(json)
        XCTAssertEqual(entry.signedStatus?.report, DaemonStatusVerifierTests.report)
        XCTAssertEqual(entry.signedStatus?.signatureHex, DaemonStatusVerifierTests.sigHex)
        XCTAssertTrue(entry.hasCert)
    }

    func testNullCertFieldsDecodeAsNils() throws {
        let json = """
        {
          "serverDomain": "abc5.harry1.flagship.services",
          "identityPubKey": "\(DaemonStatusVerifierTests.stkPubHex)",
          "signedStatus": {
            "report": {
              "serverDomain": "abc5.harry1.flagship.services",
              "certSha256": null,
              "certValidUntil": null,
              "certIssuer": null,
              "appsServed": [],
              "nonce": "00112233445566778899aabbccddeeff",
              "issuedAt": 1700000000000
            },
            "signatureHex": "\(DaemonStatusVerifierTests.nullSigHex)"
          }
        }
        """
        let entry = try decodeEntry(json)
        XCTAssertEqual(entry.signedStatus?.report, DaemonStatusVerifierTests.nullReport)
    }

    func testAbsentOrNullSignedStatusDecodesAsNil() throws {
        let absent = try decodeEntry("""
        { "serverDomain": "a.b.flagship.services", "identityPubKey": "00" }
        """)
        XCTAssertNil(absent.signedStatus)
        let null = try decodeEntry("""
        { "serverDomain": "a.b.flagship.services", "identityPubKey": "00", "signedStatus": null }
        """)
        XCTAssertNil(null.signedStatus)
    }

    func testGarbledSignedStatusDoesNotFailTheListDecode() throws {
        // A partial / wrong-shaped relay yields signedStatus == nil (⇒ no
        // pin), never a decode failure that would blank the server list.
        let garbled = try decodeEntry("""
        {
          "serverDomain": "a.b.flagship.services",
          "identityPubKey": "00",
          "signedStatus": { "report": { "serverDomain": 7 }, "signatureHex": 42 }
        }
        """)
        XCTAssertNil(garbled.signedStatus)
    }

    func testSignedStatusRoundTripsThroughEncode() throws {
        let entry = PodDirectoryEntry(
            serverDomain: "abc5.harry1.flagship.services",
            identityPubKey: DaemonStatusVerifierTests.stkPubHex,
            signedStatus: SignedDaemonStatus(
                report: DaemonStatusVerifierTests.report,
                signatureHex: DaemonStatusVerifierTests.sigHex
            )
        )
        let data = try JSONEncoder().encode(entry)
        let decoded = try JSONDecoder().decode(PodDirectoryEntry.self, from: data)
        XCTAssertEqual(decoded.signedStatus, entry.signedStatus)
    }
}
