import XCTest
import CryptoKit
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
        XCTAssertEqual(reg.verifiedReport(for: domain), DaemonStatusVerifierTests.report)
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

    // SEC-1 — keep-last-known-good. A still-listed box whose new report does
    // not verify (dropped / tampered by a MITM on the `.com` path / stale /
    // missing) must RETAIN its pin. Otherwise the pin silently downgrades to
    // default TLS validation, which a CA-valid rogue cert (exactly the
    // adversary pinning defends against) passes.

    func testMissingSignedStatusRetainsPreviousPin() {
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: now)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)
        // The relay dropped `signedStatus` (or the box renewed and the new
        // report hasn't landed) — the pod is STILL LISTED, so keep the pin.
        reg.update(pods: [makePod(signedStatus: false)], nowMs: now)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)
    }

    func testTamperedSignatureRetainsPreviousPin() {
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: now)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)
        // A MITM on the `.com` path flips the cert fingerprint and re-signs
        // with a key we don't trust → the report no longer verifies under the
        // cached STK pub. The old, genuinely-verified pin must survive.
        let badSig = String(repeating: "ab", count: 64)
        reg.update(pods: [makePod(signatureHex: badSig)], umkSeed: umkSeed, nowMs: now)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)
    }

    func testStaleReportRetainsPreviousPin() {
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: now)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)
        // A replayed-but-stale report on a still-listed box keeps the pin.
        let justStale = DaemonStatusVerifierTests.report.issuedAt
            + DaemonStatus.maxReportAgeMs + 1
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: justStale)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)
    }

    /// A genuine renewal report for `domain`, signed under the SAME STK the
    /// pinned vector uses (derived from the test UMK seed) but carrying a NEW
    /// fingerprint + a fresh `issuedAt`. Self-signed so the vector stays
    /// honest without a precomputed constant.
    private func renewedSignedPod(newPin: String, issuedAt: Int64)
        -> (pod: PodDirectoryEntry, report: DaemonStatusReport)
    {
        let report = DaemonStatusReport(
            serverDomain: domain,
            certSha256: newPin,
            certValidUntil: 1_900_000_000_000,
            certIssuer: "C=US, O=Let's Encrypt, CN=YR1",
            appsServed: DaemonStatusVerifierTests.report.appsServed,
            nonce: "ffeeddccbbaa99887766554433221100",
            issuedAt: issuedAt
        )
        let stkSeed = ServerKeys.deriveStkSeed(umkSeed: umkSeed, serverId: domain)!
        let priv = try! Curve25519.Signing.PrivateKey(rawRepresentation: stkSeed)
        let sig = try! priv.signature(for: DaemonStatus.canonicalBytes(report))
        let pod = makePod(report: report, signatureHex: HexUtil.encode(sig))
        return (pod, report)
    }

    func testNewVerifiedReportReplacesThePin() {
        // Case 2 — a legit cert renewal: the box re-mints, its daemon signs a
        // fresh report carrying the NEW fingerprint, and that supersedes.
        //
        // This is ALSO the server-migration cutover re-pin
        // (docs/server-migration.md phase 6): the migrated box keeps the SAME
        // serverDomain ⇒ same SWK ⇒ same SWK-derived status STK, mints its own
        // A′ cert, and its first verified daemon-status report replaces the old
        // box's fingerprint automatically — no manual re-pin step exists or is
        // needed. Unverified reports still never clear/replace (the retain
        // tests below).
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: now)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)

        let newPin = String(repeating: "5c", count: 32)
        XCTAssertNotEqual(newPin, pinHex)
        let renewed = renewedSignedPod(newPin: newPin, issuedAt: now)
        reg.update(pods: [renewed.pod], umkSeed: umkSeed, nowMs: renewed.report.issuedAt + 1_000)
        XCTAssertEqual(reg.pinFor(host: domain), newPin)

        // Migration framing of the same reconcile: yet another box behind the
        // same name (same STK — the migrated hardware), a fresh verified report
        // with ITS new cert ⇒ the pin follows again; a subsequent unverifiable
        // refresh does NOT downgrade it.
        let migratedPin = String(repeating: "6d", count: 32)
        let migrated = renewedSignedPod(newPin: migratedPin, issuedAt: now + 2_000)
        reg.update(pods: [migrated.pod], umkSeed: umkSeed, nowMs: now + 3_000)
        XCTAssertEqual(reg.pinFor(host: domain), migratedPin)
        reg.update(pods: [makePod(signedStatus: false)], nowMs: now + 4_000)
        XCTAssertEqual(reg.pinFor(host: domain), migratedPin)
    }

    func testAbsentPodIsUnpinned() {
        // Case 1 — a box released / decommissioned drops off `/pods`. Its pin
        // is pruned so a stale pin can't strand a hard-fail on a freed name.
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: now)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)
        reg.update(pods: [], nowMs: now)
        XCTAssertNil(reg.pinFor(host: domain))
        XCTAssertNil(reg.verifiedReport(for: domain))
    }

    func testRevokedPodDropsAnExistingPin() {
        // A revoked pod is an EXPLICIT identity-retirement signal — drop the
        // pin (unlike a transient verify failure, which is retained).
        let reg = CertPinRegistry(persistingIn: nil)
        reg.update(pods: [makePod()], umkSeed: umkSeed, nowMs: now)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)
        reg.update(pods: [makePod(revokedAt: 1)], umkSeed: umkSeed, nowMs: now)
        XCTAssertNil(reg.pinFor(host: domain))
    }

    func testKeepLastGoodIsScopedToTheStillListedBox() {
        // A second box absent from the refresh is pruned even while the first
        // box (present, now unverifiable) keeps its pin — case 1 and case 3
        // applied independently in one reconcile.
        let reg = CertPinRegistry(persistingIn: nil)
        let other = "other.harry1.flagship.services"

        // Genuinely pin both boxes from verified reports: `domain` via the
        // pinned vector, `other` via a self-signed report under its own STK.
        let otherPin = String(repeating: "a3", count: 32)
        let otherReport = DaemonStatusReport(
            serverDomain: other, certSha256: otherPin,
            certValidUntil: 1_900_000_000_000, certIssuer: "C=US, O=Let's Encrypt, CN=YR1",
            appsServed: [other], nonce: "00ff00ff00ff00ff00ff00ff00ff00ff", issuedAt: now
        )
        let otherSeed = ServerKeys.deriveStkSeed(umkSeed: umkSeed, serverId: other)!
        let otherSig = try! Curve25519.Signing.PrivateKey(rawRepresentation: otherSeed)
            .signature(for: DaemonStatus.canonicalBytes(otherReport))
        let otherPod = makePod(
            serverDomain: other, report: otherReport, signatureHex: HexUtil.encode(otherSig)
        )
        reg.update(pods: [makePod(), otherPod], umkSeed: umkSeed, nowMs: now + 1_000)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)
        XCTAssertEqual(reg.pinFor(host: other), otherPin)

        // Refresh lists ONLY the first box, now with a dropped report → it
        // keeps its pin (case 3); `other` (absent) is pruned (case 1).
        reg.update(pods: [makePod(signedStatus: false)], nowMs: now)
        XCTAssertEqual(reg.pinFor(host: domain), pinHex)
        XCTAssertNil(reg.pinFor(host: other))
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
