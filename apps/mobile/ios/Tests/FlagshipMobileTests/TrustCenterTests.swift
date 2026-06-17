import XCTest
import CryptoKit
@testable import FlagshipCore

/// The app-side maintainer-trust gate: `TrustCenter` (verdict + failing-cert
/// registry + override) and the `TrustException` canonical bytes the override
/// signs.
@MainActor
final class TrustCenterTests: XCTestCase {

    static let caPub = "bb5c672482b0dcca91a21a4ed63b15afde8aa1378da72cd01b349589d6e7dd6a"
    static let caPub2 = "aa5c672482b0dcca91a21a4ed63b15afde8aa1378da72cd01b349589d6e7dd6a"
    // Pinned: sha256hex(utf8(caPub)) — cross-checked against the TrustException
    // node computation and the Android test.
    static let certHash = "f78690df9cb15b62a8e4fe6e9c5647e7d222c515f882774abbe7cea200569a42"

    private func failure(_ caPub: String = caPub,
                         _ cls: TrustException.CertClass = .control) -> TrustFailure {
        TrustFailure(certClass: cls,
                     certHash: TrustException.certHash(forCaPubkey: caPub),
                     caPubkey: caPub)
    }

    // MARK: - certHash + slug + label shapes

    func testCertHashMatchesPinned() {
        XCTAssertEqual(TrustException.certHash(forCaPubkey: Self.caPub), Self.certHash)
    }

    func testSlugIsFirst8Hex() {
        XCTAssertEqual(failure().slug, String(Self.certHash.prefix(8)))
        XCTAssertEqual(failure().slug, "f78690df")
    }

    func testLabelShapes() {
        XCTAssertEqual(failure(Self.caPub, .control).label,
                       "Control server certificate expired · f78690df")
        XCTAssertEqual(failure(Self.caPub, .relay).label,
                       "Relay certificate expired · f78690df")
    }

    // MARK: - Verdict + isServerTrusted

    func testUnknownIsTrustedByDefault() {
        let c = TrustCenter()
        XCTAssertEqual(c.verdict, .unknown)
        XCTAssertTrue(c.isServerTrusted) // no verdict ⇒ never halt
        XCTAssertTrue(c.sliverFailures.isEmpty)
    }

    func testTrustedLetsTrafficThrough() {
        let c = TrustCenter()
        c.markTrusted()
        XCTAssertEqual(c.verdict, .trusted)
        XCTAssertTrue(c.isServerTrusted)
        XCTAssertTrue(c.sliverFailures.isEmpty)
    }

    func testUntrustedHaltsAndShowsOneLine() {
        let c = TrustCenter()
        c.markUntrusted([failure()])
        XCTAssertEqual(c.verdict, .untrusted)
        XCTAssertFalse(c.isServerTrusted)
        XCTAssertEqual(c.sliverFailures.count, 1)
        XCTAssertEqual(c.sliverFailures.first?.label,
                       "Control server certificate expired · f78690df")
    }

    func testNoVerdictLeavesUntrustedHalting() {
        let c = TrustCenter()
        c.markUntrusted([failure()])
        c.markNoVerdict() // a later network error must NOT un-halt
        XCTAssertFalse(c.isServerTrusted)
        XCTAssertEqual(c.verdict, .untrusted)
    }

    // MARK: - Line dedup

    func testDuplicateFailuresDedup() {
        let c = TrustCenter()
        c.markUntrusted([failure(), failure(), failure()])
        XCTAssertEqual(c.sliverFailures.count, 1)
    }

    func testControlAndRelayBothShow() {
        let c = TrustCenter()
        c.markUntrusted([failure(Self.caPub, .control), failure(Self.caPub2, .relay)])
        XCTAssertEqual(c.sliverFailures.count, 2)
    }

    func testSameCertHashDifferentClassAreDistinctLines() {
        let c = TrustCenter()
        // Same caPub ⇒ same certHash, but control + relay are different ids.
        c.markUntrusted([failure(Self.caPub, .control), failure(Self.caPub, .relay)])
        XCTAssertEqual(c.sliverFailures.count, 2)
    }

    // MARK: - Override

    func testOverrideUnhaltsButLinePersists() {
        let c = TrustCenter()
        let f = failure()
        c.markUntrusted([f])
        XCTAssertFalse(c.isServerTrusted)

        c.recordOverride(certHash: f.certHash)
        XCTAssertTrue(c.isServerTrusted)            // traffic resumes
        XCTAssertEqual(c.sliverFailures.count, 1)   // line PERSISTS
        XCTAssertFalse(c.isBlocking(certHash: f.certHash))
    }

    func testPartialOverrideStillHalts() {
        let c = TrustCenter()
        c.markUntrusted([failure(Self.caPub, .control), failure(Self.caPub2, .relay)])
        c.recordOverride(certHash: TrustException.certHash(forCaPubkey: Self.caPub))
        // One cert still un-overridden ⇒ still halting.
        XCTAssertFalse(c.isServerTrusted)
        c.recordOverride(certHash: TrustException.certHash(forCaPubkey: Self.caPub2))
        XCTAssertTrue(c.isServerTrusted)
    }

    func testReturningToTrustedClearsLinesAndOverrides() {
        let c = TrustCenter()
        let f = failure()
        c.markUntrusted([f])
        c.recordOverride(certHash: f.certHash)
        c.markTrusted()
        XCTAssertTrue(c.sliverFailures.isEmpty)
        XCTAssertEqual(c.verdict, .trusted)
    }

    // MARK: - TrustException canonical bytes (pinned cross-platform vector)

    func testTrustExceptionCanonicalBytes() {
        let ex = TrustException(
            certClass: .control,
            certHash: Self.certHash,
            grantedAt: 1_779_235_200_000,
            grantedByDevicePub: "cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc"
        )
        let expected =
            "flagship/trust-exception/v1|control|\(Self.certHash)|1779235200000|" +
            "cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc"
        XCTAssertEqual(String(data: ex.canonicalBytes(), encoding: .utf8), expected)
    }

    func testTrustExceptionSignsAndVerifies() throws {
        let key = Curve25519.Signing.PrivateKey()
        let ex = TrustException(
            certClass: .relay, certHash: Self.certHash, grantedAt: 1,
            grantedByDevicePub: HexUtil.encode(key.publicKey.rawRepresentation)
        )
        let sig = try ex.sign(with: key)
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: ex.canonicalBytes()))
    }
}
