import XCTest
import CryptoKit
import FlagshipAPI
@testable import FlagshipCore

/// Per-cert RELAY-trust aggregation (`RelayTrustAggregator`) — the Layer-3
/// client half of maintainer-trust enforcement. Each box signs a
/// `flagship/box-trust-status/v1` verdict with its STK; the aggregator
/// re-verifies EACH under the pod's `identityPubKey` and folds the untrusted
/// ones BY `failingCertHash` across all pods — one entry per DISTINCT faulty
/// relay authority. Signing here uses REAL CryptoKit Ed25519 (the box's STK
/// path), so the verify is genuine, not mocked.
final class RelayTrustAggregatorTests: XCTestCase {
    static let certA = String(repeating: "aa", count: 32) // 64-hex authority A
    static let certB = String(repeating: "bb", count: 32) // authority B

    /// Build a `/pods` entry whose `trustStatus` is genuinely STK-signed over
    /// the canonical bytes (so it verifies), unless `tamper` corrupts the sig.
    private func signedPod(
        _ serverDomain: String,
        verdict: RelayVerdict,
        failingCertHash: String?,
        covering: String? = nil,
        tamper: Bool = false
    ) -> PodDirectoryEntry {
        let key = Curve25519.Signing.PrivateKey()
        let stkHex = HexUtil.encode(key.publicKey.rawRepresentation)
        let report = BoxTrustStatusReport(
            serverDomain: serverDomain,
            relayVerdict: verdict,
            lockedDown: false,
            failingCertHash: failingCertHash,
            coveringExceptionCertHash: covering,
            nonce: "00",
            issuedAt: 1
        )
        let sig = try! key.signature(for: BoxTrustStatus.canonicalBytes(report))
        let sigHex = tamper ? String(repeating: "00", count: 64) : HexUtil.encode(sig)
        return PodDirectoryEntry(
            serverDomain: serverDomain,
            identityPubKey: stkHex,
            trustStatus: SignedBoxTrustStatus(report: report, signatureHex: sigHex)
        )
    }

    func testTwoPodsSameCertHashAggregateToOneEntrySpanningBothServers() {
        let pods = [
            signedPod("a.harry1.flagship.services", verdict: .untrusted, failingCertHash: Self.certA),
            signedPod("b.harry1.flagship.services", verdict: .untrusted, failingCertHash: Self.certA),
        ]
        let out = RelayTrustAggregator.aggregate(pods: pods)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].certHash, Self.certA)
        XCTAssertEqual(out[0].serverCount, 2)
        XCTAssertEqual(out[0].servers, ["a.harry1.flagship.services", "b.harry1.flagship.services"])
        XCTAssertFalse(out[0].overridden)
        XCTAssertEqual(out[0].label, "Relay certificate expired · aaaaaaaa")
    }

    func testDistinctCertHashesProduceDistinctEntries() {
        let pods = [
            signedPod("a.x", verdict: .untrusted, failingCertHash: Self.certA),
            signedPod("b.x", verdict: .untrusted, failingCertHash: Self.certB),
        ]
        let out = RelayTrustAggregator.aggregate(pods: pods)
        XCTAssertEqual(out.map(\.certHash), [Self.certA, Self.certB])
    }

    func testCoveringExceptionCertHashOnTheWireMarksTheEntryOverridden() {
        // A covered box keeps reporting `untrusted` for the cert but ALSO names
        // it as covered — the standing override marker is that relayed field.
        let pods = [
            signedPod("a.x", verdict: .untrusted, failingCertHash: Self.certA, covering: Self.certA),
        ]
        let out = RelayTrustAggregator.aggregate(pods: pods)
        XCTAssertEqual(out.count, 1)
        XCTAssertTrue(out[0].overridden)
    }

    func testUnverifiableSignatureIsDropped() {
        let pods = [
            signedPod("a.x", verdict: .untrusted, failingCertHash: Self.certA, tamper: true),
        ]
        XCTAssertTrue(RelayTrustAggregator.aggregate(pods: pods).isEmpty)
    }

    func testTrustedAndUnknownVerdictsAndMissingTrustStatusAreIgnored() {
        let pods = [
            signedPod("a.x", verdict: .trusted, failingCertHash: nil),
            signedPod("b.x", verdict: .unknown, failingCertHash: nil),
            PodDirectoryEntry(serverDomain: "c.x", identityPubKey: String(repeating: "cc", count: 32)),
        ]
        XCTAssertTrue(RelayTrustAggregator.aggregate(pods: pods).isEmpty)
    }
}
