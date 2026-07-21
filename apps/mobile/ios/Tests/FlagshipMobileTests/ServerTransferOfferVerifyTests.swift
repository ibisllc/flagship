import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipAPI

/// Slice C — the acquirer-side SECURITY gate + the universal-link round-trip.
/// A deep-linked/scanned transfer offer is attacker-supplied, so `verifyOffer`
/// must accept a genuine giver-IRK signature and REJECT a forged / expired one.
final class ServerTransferOfferVerifyTests: XCTestCase {
    private let giver = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 11, count: 32))
    private let attacker = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 99, count: 32))
    private let host = "home.alice.flagship.services"

    private func makeOffer(issuedAt: Int64 = 1_000, ttlMs: Int64 = 900_000) -> ServerTransferFlow.OfferQR {
        let (_, qr) = try! ServerTransferFlow.buildOffer(
            serverDomain: host, username: "alice", irk: giver,
            issuedAt: issuedAt, ttlMs: ttlMs,
            nonce: Data(repeating: 0xab, count: 32), authNonce: Data(repeating: 0x01, count: 32)
        )
        return qr
    }

    // MARK: verifyOffer — valid / forged / expired

    func testVerifyOfferAcceptsGenuineOffer() throws {
        let qr = makeOffer(issuedAt: 1_000, ttlMs: 900_000)
        XCTAssertNoThrow(try ServerTransferFlow.verifyOffer(qr, now: 1_500))
    }

    func testVerifyOfferRejectsForgedSignature() {
        // Re-sign the SAME order under an attacker key — the signature is
        // well-formed but doesn't match the advertised giverIrkPub.
        let issuedAt: Int64 = 1_000, expiresAt: Int64 = 1_000 + 900_000
        let order = ServerTransferOfferOrder(serverDomain: host, transferNonce: String(repeating: "ab", count: 32), issuedAt: issuedAt, expiresAt: expiresAt)
        let forgedSig = try! order.sign(with: attacker)
        let forged = ServerTransferFlow.OfferQR(
            serverDomain: host, transferNonce: String(repeating: "ab", count: 32),
            giverIrkPub: HexUtil.encode(giver.publicKey.rawRepresentation),
            issuedAt: issuedAt, expiresAt: expiresAt,
            offerSignature: HexUtil.encode(forgedSig)
        )
        XCTAssertThrowsError(try ServerTransferFlow.verifyOffer(forged, now: 1_500)) { e in
            XCTAssertEqual(e as? ServerTransferFlow.TransferError, .badSignature)
        }
    }

    func testVerifyOfferRejectsTamperedDomain() {
        // Take a genuine offer but swap the serverDomain — the signature no
        // longer covers the presented bytes.
        let good = makeOffer()
        let tampered = ServerTransferFlow.OfferQR(
            serverDomain: "evil.mallory.flagship.services",
            transferNonce: good.transferNonce,
            giverIrkPub: good.giverIrkPub,
            issuedAt: good.issuedAt, expiresAt: good.expiresAt,
            offerSignature: good.offerSignature
        )
        XCTAssertThrowsError(try ServerTransferFlow.verifyOffer(tampered, now: 1_500)) { e in
            XCTAssertEqual(e as? ServerTransferFlow.TransferError, .badSignature)
        }
    }

    func testVerifyOfferRejectsExpiredOffer() {
        let qr = makeOffer(issuedAt: 1_000, ttlMs: 5_000) // expiresAt == 6_000
        XCTAssertThrowsError(try ServerTransferFlow.verifyOffer(qr, now: 10_000)) { e in
            XCTAssertEqual(e as? ServerTransferFlow.TransferError, .expired)
        }
    }

    func testVerifyOfferRejectsMalformedPubkey() {
        let good = makeOffer()
        let bad = ServerTransferFlow.OfferQR(
            serverDomain: good.serverDomain, transferNonce: good.transferNonce,
            giverIrkPub: "00", issuedAt: good.issuedAt, expiresAt: good.expiresAt,
            offerSignature: good.offerSignature
        )
        XCTAssertThrowsError(try ServerTransferFlow.verifyOffer(bad, now: 1_500)) { e in
            XCTAssertEqual(e as? ServerTransferFlow.TransferError, .malformedQR)
        }
    }

    // MARK: universal-link / custom-scheme round-trips

    func testUniversalLinkRoundTripsThroughDeepLink() throws {
        let qr = makeOffer()
        let link = try ServerTransferFlow.transferUniversalLink(qr, controlHost: Endpoints.controlHost)
        XCTAssertTrue(link.hasPrefix("https://\(Endpoints.controlHost)/transfer?o="))
        // The offer JSON rides the `o=` QUERY param, never the fragment.
        XCTAssertFalse(link.contains("#"))

        let parsed = DeepLink.parse(URL(string: link)!)
        guard case let .transferOffer(offerJSON) = parsed else {
            return XCTFail("expected .transferOffer, got \(String(describing: parsed))")
        }
        let reparsed = try ServerTransferFlow.parseQR(offerJSON)
        XCTAssertEqual(reparsed, qr)
    }

    func testCustomSchemeLinkRoundTripsThroughDeepLink() throws {
        let qr = makeOffer()
        let link = try ServerTransferFlow.transferCustomSchemeLink(qr)
        XCTAssertTrue(link.hasPrefix("flagship://transfer?o="))
        let parsed = DeepLink.parse(URL(string: link)!)
        guard case let .transferOffer(offerJSON) = parsed else {
            return XCTFail("expected .transferOffer, got \(String(describing: parsed))")
        }
        XCTAssertEqual(try ServerTransferFlow.parseScanned(link), qr)
        XCTAssertEqual(try ServerTransferFlow.parseQR(offerJSON), qr)
    }

    func testEncodeOfferParamIsUnpaddedBase64URL() throws {
        let qr = makeOffer()
        let param = try ServerTransferFlow.encodeOfferParam(qr)
        XCTAssertFalse(param.contains("="))
        XCTAssertFalse(param.contains("+"))
        XCTAssertFalse(param.contains("/"))
        XCTAssertEqual(ServerTransferFlow.decodeOfferParam(param), try ServerTransferFlow.encodeQR(qr))
    }

    func testParsedPastedTransferLinkResolves() {
        let qr = makeOffer()
        let link = try! ServerTransferFlow.transferCustomSchemeLink(qr)
        // Settings → Process URL funnels a pasted link through the same parser.
        guard case .transferOffer = DeepLink.parsePastedString("  \(link)  ") else {
            return XCTFail("pasted transfer link should resolve to .transferOffer")
        }
    }
}
