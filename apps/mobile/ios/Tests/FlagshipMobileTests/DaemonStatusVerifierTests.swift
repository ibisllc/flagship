import XCTest
import FlagshipAPI
@testable import FlagshipCore

/// FlagshipCore.DaemonStatus + ServerKeys against the PINNED cross-platform
/// vector from packages/protocol/tests/daemonStatus.test.ts (UMK 07×32,
/// serverId abc5.harry1.flagship.services, STK pub 0a1eaaad…0d47). The TS
/// implementation is the byte-level contract; these constants are copied
/// verbatim — regenerate only on a deliberate v2 of the format.
final class DaemonStatusVerifierTests: XCTestCase {
    static let umkSeedHex = String(repeating: "07", count: 32)
    static let stkPubHex =
        "0a1eaaad1e4f57435b95e2339654618e121b2b84d3ac595c64f73520fde90d47"

    static let report = DaemonStatusReport(
        serverDomain: "abc5.harry1.flagship.services",
        certSha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        certValidUntil: 1_800_000_000_000,
        certIssuer: "C=US, O=Let's Encrypt, CN=YR1",
        // Deliberately unsorted — canonical bytes sort.
        appsServed: [
            "wiki.abc5.harry1.flagship.services",
            "abc5.harry1.flagship.services"
        ],
        nonce: "00112233445566778899aabbccddeeff",
        issuedAt: 1_700_000_000_000
    )

    static let canonical =
        "flagship/daemon-status/v1|abc5.harry1.flagship.services|" +
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08|" +
        "1800000000000|C=US, O=Let's Encrypt, CN=YR1|" +
        "abc5.harry1.flagship.services,wiki.abc5.harry1.flagship.services|" +
        "00112233445566778899aabbccddeeff|1700000000000"

    static let sigHex =
        "367b6e23c4f6bcc5f7ea0d082c3f411a439642af775be6c12517f9563f722870" +
        "64d207b9b3af42a92b0a0f8b2ea7d35b10616bc9d73d95d960b12ba1c72c6005"

    static let nullReport = DaemonStatusReport(
        serverDomain: report.serverDomain,
        certSha256: nil,
        certValidUntil: nil,
        certIssuer: nil,
        appsServed: [],
        nonce: report.nonce,
        issuedAt: report.issuedAt
    )

    static let nullCanonical =
        "flagship/daemon-status/v1|abc5.harry1.flagship.services|||||" +
        "00112233445566778899aabbccddeeff|1700000000000"

    static let nullSigHex =
        "890c1bcf92399d2560b6a326844a5b66cd934ee724d02722f7e141e01ba55517" +
        "212934a9bde72128aaf21f496a06bec2aed802fb84a5cc67d3e2536e6b782308"

    var umkSeed: Data { HexUtil.decode(Self.umkSeedHex)! }
    var stkPub: Data { HexUtil.decode(Self.stkPubHex)! }

    // MARK: - Key derivation (ServerKeys mirror)

    func testPhoneSideStkDerivationReproducesPinnedPubkey() {
        let pub = ServerKeys.deriveStkPub(umkSeed: umkSeed, serverId: Self.report.serverDomain)
        XCTAssertEqual(pub.map { HexUtil.encode($0) }, Self.stkPubHex)
    }

    func testStkDerivationRejectsBadSeedLength() {
        XCTAssertNil(ServerKeys.deriveStkPub(umkSeed: Data([7, 7, 7]), serverId: "x"))
        XCTAssertNil(ServerKeys.deriveSwk(umkSeed: Data(), serverId: "x"))
    }

    // MARK: - Canonical bytes

    func testCanonicalBytesMatchPinnedString() {
        XCTAssertEqual(
            String(data: DaemonStatus.canonicalBytes(Self.report), encoding: .utf8),
            Self.canonical
        )
    }

    func testNullFieldsEncodeAsEmptySegments() {
        XCTAssertEqual(
            String(data: DaemonStatus.canonicalBytes(Self.nullReport), encoding: .utf8),
            Self.nullCanonical
        )
    }

    // MARK: - Signature accept

    func testPinnedSignatureVerifiesUnderPinnedStkPub() {
        XCTAssertTrue(DaemonStatus.verify(Self.report, signatureHex: Self.sigHex, stkPub: stkPub))
        XCTAssertTrue(DaemonStatus.verify(Self.nullReport, signatureHex: Self.nullSigHex, stkPub: stkPub))
    }

    func testAppsOrderDoesNotAffectVerification() {
        let reordered = DaemonStatusReport(
            serverDomain: Self.report.serverDomain,
            certSha256: Self.report.certSha256,
            certValidUntil: Self.report.certValidUntil,
            certIssuer: Self.report.certIssuer,
            appsServed: Self.report.appsServed.reversed(),
            nonce: Self.report.nonce,
            issuedAt: Self.report.issuedAt
        )
        XCTAssertTrue(DaemonStatus.verify(reordered, signatureHex: Self.sigHex, stkPub: stkPub))
    }

    // MARK: - Tamper reject (every signed field)

    func testRejectsMutationOfEachSignedField() {
        let r = Self.report
        let mutations: [DaemonStatusReport] = [
            .init(serverDomain: "evil.harry1.flagship.services", certSha256: r.certSha256,
                  certValidUntil: r.certValidUntil, certIssuer: r.certIssuer,
                  appsServed: r.appsServed, nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, certSha256: String(repeating: "ab", count: 32),
                  certValidUntil: r.certValidUntil, certIssuer: r.certIssuer,
                  appsServed: r.appsServed, nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, certSha256: nil,
                  certValidUntil: r.certValidUntil, certIssuer: r.certIssuer,
                  appsServed: r.appsServed, nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, certSha256: r.certSha256,
                  certValidUntil: 1_800_000_000_001, certIssuer: r.certIssuer,
                  appsServed: r.appsServed, nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, certSha256: r.certSha256,
                  certValidUntil: nil, certIssuer: r.certIssuer,
                  appsServed: r.appsServed, nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, certSha256: r.certSha256,
                  certValidUntil: r.certValidUntil, certIssuer: "C=US, O=Evil CA, CN=X1",
                  appsServed: r.appsServed, nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, certSha256: r.certSha256,
                  certValidUntil: r.certValidUntil, certIssuer: nil,
                  appsServed: r.appsServed, nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, certSha256: r.certSha256,
                  certValidUntil: r.certValidUntil, certIssuer: r.certIssuer,
                  appsServed: ["abc5.harry1.flagship.services"], nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, certSha256: r.certSha256,
                  certValidUntil: r.certValidUntil, certIssuer: r.certIssuer,
                  appsServed: [], nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, certSha256: r.certSha256,
                  certValidUntil: r.certValidUntil, certIssuer: r.certIssuer,
                  appsServed: r.appsServed, nonce: "ff112233445566778899aabbccddeeff", issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, certSha256: r.certSha256,
                  certValidUntil: r.certValidUntil, certIssuer: r.certIssuer,
                  appsServed: r.appsServed, nonce: r.nonce, issuedAt: 1_700_000_000_001)
        ]
        for (i, mutated) in mutations.enumerated() {
            XCTAssertFalse(
                DaemonStatus.verify(mutated, signatureHex: Self.sigHex, stkPub: stkPub),
                "mutation \(i) should fail verification"
            )
        }
    }

    func testRejectsSignatureFromDifferentKey() {
        // STK derived from a DIFFERENT UMK (08×32) cannot satisfy the
        // pinned pubkey — and the pinned signature fails under ITS pubkey
        // only if swapped; here we check the pinned sig against the wrong key.
        let otherSeed = HexUtil.decode(String(repeating: "08", count: 32))!
        let otherPub = ServerKeys.deriveStkPub(umkSeed: otherSeed, serverId: Self.report.serverDomain)!
        XCTAssertNotEqual(HexUtil.encode(otherPub), Self.stkPubHex)
        XCTAssertFalse(DaemonStatus.verify(Self.report, signatureHex: Self.sigHex, stkPub: otherPub))
    }

    func testVerifyNeverThrowsOnMalformedInputs() {
        XCTAssertFalse(DaemonStatus.verify(Self.report, signature: Data([1, 2, 3]), stkPub: Data([4, 5])))
        XCTAssertFalse(DaemonStatus.verify(Self.report, signatureHex: "zz", stkPub: stkPub))
        XCTAssertFalse(DaemonStatus.verify(Self.report, signatureHex: "", stkPub: Data()))
    }
}
