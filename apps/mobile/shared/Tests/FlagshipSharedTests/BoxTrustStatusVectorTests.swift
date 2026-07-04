import XCTest
import CryptoKit
import FlagshipAPI
@testable import FlagshipCore

/// Pins the Swift `BoxTrustStatus` verifier to the EXACT cross-platform vector
/// in `packages/protocol/tests/boxTrustStatus.test.ts`:
///   UMK seed = 32×0x07, serverId "abc5.harry1.flagship.services"
///   STK pub  = 0a1eaaad…0d47 (the phone-side deriveSTK(deriveSWK(...)) path)
///
/// The daemon signs this per-box relay-trust verdict with its STK; a phone
/// re-verifies it against the locally-derived STK pub, so any drift in the
/// tag, `|` separator, field order, or lockedDown/verdict stringification
/// would break the per-server trust warning.
final class BoxTrustStatusVectorTests: XCTestCase {
    static let umkSeedHex = String(repeating: "07", count: 32)
    static let stkPubHex =
        "0a1eaaad1e4f57435b95e2339654618e121b2b84d3ac595c64f73520fde90d47"

    static let report = BoxTrustStatusReport(
        serverDomain: "abc5.harry1.flagship.services",
        relayVerdict: .untrusted,
        lockedDown: true,
        failingCertHash:
            "1e2d3c4b5a69788796a5b4c3d2e1f00918273645546372819a0b1c2d3e4f5061",
        coveringExceptionCertHash:
            "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
        nonce: "00112233445566778899aabbccddeeff",
        issuedAt: 1_700_000_000_000
    )

    static let canonical =
        "flagship/box-trust-status/v1|abc5.harry1.flagship.services|untrusted|1|" +
        "1e2d3c4b5a69788796a5b4c3d2e1f00918273645546372819a0b1c2d3e4f5061|" +
        "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899|" +
        "00112233445566778899aabbccddeeff|1700000000000"

    static let sigHex =
        "85ad9b3fb100c7ab8ca3600ac8970a3a66fd2c5ee0ebf363573dac5b70b420ab9" +
        "3a7cace49c5fb153c8549933820893aaad3a5a24a47f6aa3be01babbdd6f502"

    static let trustedReport = BoxTrustStatusReport(
        serverDomain: "abc5.harry1.flagship.services",
        relayVerdict: .trusted,
        lockedDown: false,
        failingCertHash: nil,
        coveringExceptionCertHash: nil,
        nonce: "00112233445566778899aabbccddeeff",
        issuedAt: 1_700_000_000_000
    )

    static let trustedCanonical =
        "flagship/box-trust-status/v1|abc5.harry1.flagship.services|trusted|0|||" +
        "00112233445566778899aabbccddeeff|1700000000000"

    static let trustedSigHex =
        "e674e0c3e329092e11afe5dd9faab14a82edfc4c5063d01eb3f9b6693bc966fb4" +
        "7015b3258b88b03b4b61c82442a017b5b94a8384a7396eb3539f6db3f053807"

    var umkSeed: Data { HexUtil.decode(Self.umkSeedHex)! }
    var stkPub: Data { HexUtil.decode(Self.stkPubHex)! }

    func testPhoneSideStkDerivationReproducesPinnedPubkey() {
        let pub = ServerKeys.deriveStkPub(umkSeed: umkSeed, serverId: Self.report.serverDomain)
        XCTAssertEqual(pub.map { HexUtil.encode($0) }, Self.stkPubHex)
    }

    func testCanonicalBytesMatchPinnedString() {
        XCTAssertEqual(
            String(data: BoxTrustStatus.canonicalBytes(Self.report), encoding: .utf8),
            Self.canonical
        )
    }

    func testTrustedHealthyEncodesOptionalFieldsAsEmptySegments() {
        XCTAssertEqual(
            String(data: BoxTrustStatus.canonicalBytes(Self.trustedReport), encoding: .utf8),
            Self.trustedCanonical
        )
    }

    func testPinnedSignatureVerifiesUnderPinnedStkPub() {
        XCTAssertTrue(BoxTrustStatus.verify(Self.report, signatureHex: Self.sigHex, stkPub: stkPub))
        XCTAssertTrue(BoxTrustStatus.verify(Self.trustedReport, signatureHex: Self.trustedSigHex, stkPub: stkPub))
    }

    func testRejectsMutationOfEachSignedField() {
        let r = Self.report
        let mutations: [BoxTrustStatusReport] = [
            .init(serverDomain: "evil.harry1.flagship.services", relayVerdict: r.relayVerdict,
                  lockedDown: r.lockedDown, failingCertHash: r.failingCertHash,
                  coveringExceptionCertHash: r.coveringExceptionCertHash, nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, relayVerdict: .trusted,
                  lockedDown: r.lockedDown, failingCertHash: r.failingCertHash,
                  coveringExceptionCertHash: r.coveringExceptionCertHash, nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, relayVerdict: .unknown,
                  lockedDown: r.lockedDown, failingCertHash: r.failingCertHash,
                  coveringExceptionCertHash: r.coveringExceptionCertHash, nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, relayVerdict: r.relayVerdict,
                  lockedDown: false, failingCertHash: r.failingCertHash,
                  coveringExceptionCertHash: r.coveringExceptionCertHash, nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, relayVerdict: r.relayVerdict,
                  lockedDown: r.lockedDown, failingCertHash: String(repeating: "ab", count: 32),
                  coveringExceptionCertHash: r.coveringExceptionCertHash, nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, relayVerdict: r.relayVerdict,
                  lockedDown: r.lockedDown, failingCertHash: nil,
                  coveringExceptionCertHash: r.coveringExceptionCertHash, nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, relayVerdict: r.relayVerdict,
                  lockedDown: r.lockedDown, failingCertHash: r.failingCertHash,
                  coveringExceptionCertHash: String(repeating: "cd", count: 32), nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, relayVerdict: r.relayVerdict,
                  lockedDown: r.lockedDown, failingCertHash: r.failingCertHash,
                  coveringExceptionCertHash: nil, nonce: r.nonce, issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, relayVerdict: r.relayVerdict,
                  lockedDown: r.lockedDown, failingCertHash: r.failingCertHash,
                  coveringExceptionCertHash: r.coveringExceptionCertHash,
                  nonce: "ff112233445566778899aabbccddeeff", issuedAt: r.issuedAt),
            .init(serverDomain: r.serverDomain, relayVerdict: r.relayVerdict,
                  lockedDown: r.lockedDown, failingCertHash: r.failingCertHash,
                  coveringExceptionCertHash: r.coveringExceptionCertHash, nonce: r.nonce, issuedAt: 1_700_000_000_001)
        ]
        for (i, mutated) in mutations.enumerated() {
            XCTAssertFalse(
                BoxTrustStatus.verify(mutated, signatureHex: Self.sigHex, stkPub: stkPub),
                "mutation \(i) should fail verification"
            )
        }
    }

    func testVerifyNeverThrowsOnMalformedInputs() {
        XCTAssertFalse(BoxTrustStatus.verify(Self.report, signature: Data([1, 2, 3]), stkPub: Data([4, 5])))
        XCTAssertFalse(BoxTrustStatus.verify(Self.report, signatureHex: "zz", stkPub: stkPub))
    }
}
