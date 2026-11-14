import XCTest
import CryptoKit
@testable import FlagshipAPI

/// Direct access on the phone (docs/direct-access-and-domains.md): a public endpoint is dialed only
/// inside an owner order that verifies under the account's key, after the same pinned probe as LAN.
final class DirectAccessRegistryTests: XCTestCase {
    let box = "home.alice.flagship.services"
    let pin = String(repeating: "cd", count: 32)
    let now: Int64 = 1_790_000_000_000
    let stk = Curve25519.Signing.PrivateKey()
    let admin = Curve25519.Signing.PrivateKey()

    private actor Prober: LanProber {
        let reachable: Set<String>
        var probed: [String] = []
        init(_ r: Set<String>) { reachable = r }
        func probe(sniHost: String, address: String, port: Int, certSha256: String) async -> Bool {
            probed.append(address)
            return reachable.contains(address)
        }
    }

    private var order: DirectAccess.Order {
        DirectAccess.Order(serverDomain: box, enabled: true, addresses: ["81.2.69.142"], prefixes: ["2a02:8010:6400::/48"], port: 443, issuedAt: now)
    }

    private func envelope(lan: [String], direct: [String], orderKey: Curve25519.Signing.PrivateKey?) throws -> DirectAccess.HintV2Envelope {
        let h = DirectAccess.HintV2(
            serverDomain: box, certSha256: pin,
            lan: lan.map { .init(address: $0, port: 443) }, direct: direct.map { .init(address: $0, port: 443) },
            orderSha256: direct.isEmpty ? "" : DirectAccess.orderSha256(order), issuedAt: now, expiresAt: now + 3_600_000
        )
        let sig = try stk.signature(for: DirectAccess.canonical(h)).map { String(format: "%02x", $0) }.joined()
        let signed = try orderKey.map { DirectAccess.SignedOrder(order: order, signatureHex: try DirectAccess.sign(order, key: $0)) }
        return .init(hint: h, signatureHex: sig, directAccess: signed)
    }

    func testAVerifiedOrderLetsThePhoneProveAndUseThePublicEndpoint() async throws {
        let prober = Prober(["81.2.69.142"])
        let t = now
        let r = LanDirectRegistry(prober: prober, clock: { t }, log: { _ in })
        let why = r.accept(box: box, envelope: try envelope(lan: ["192.168.1.20"], direct: ["81.2.69.142"], orderKey: admin),
                           stkPub: stk.publicKey.rawRepresentation, pinnedCertSha256: pin, authorityPubs: [admin.publicKey.rawRepresentation])
        XCTAssertNil(why)
        XCTAssertNil(r.provenEndpoint(for: "app.\(box)"), "no request waits for a probe")
        await r.settleProbes()
        XCTAssertEqual(r.provenEndpoint(for: "app.\(box)")?.address, "81.2.69.142")
        let probed = await prober.probed
        XCTAssertEqual(probed, ["192.168.1.20", "81.2.69.142"], "LAN first, then the public endpoint")
    }

    func testAnOrderTheAccountDidNotSignLeavesOnlyTheLanPart() async throws {
        let prober = Prober(["81.2.69.142"])
        let t = now
        let r = LanDirectRegistry(prober: prober, clock: { t }, log: { _ in })
        let forger = Curve25519.Signing.PrivateKey()
        XCTAssertNil(r.accept(box: box, envelope: try envelope(lan: ["192.168.1.20"], direct: ["81.2.69.142"], orderKey: forger),
                              stkPub: stk.publicKey.rawRepresentation, pinnedCertSha256: pin, authorityPubs: [admin.publicKey.rawRepresentation]))
        _ = r.provenEndpoint(for: box)
        await r.settleProbes()
        XCTAssertNil(r.provenEndpoint(for: box))
        let probed = await prober.probed
        XCTAssertEqual(probed, ["192.168.1.20"], "the public address is never dialed")
    }

    func testNoAuthorityKeyMeansNoPublicEndpoint() async throws {
        let prober = Prober(["81.2.69.142"])
        let t = now
        let r = LanDirectRegistry(prober: prober, clock: { t }, log: { _ in })
        XCTAssertEqual(r.accept(box: box, envelope: try envelope(lan: [], direct: ["81.2.69.142"], orderKey: admin),
                                stkPub: stk.publicKey.rawRepresentation, pinnedCertSha256: pin, authorityPubs: []),
                       "direct-without-order")
        XCTAssertNil(r.provenEndpoint(for: box))
    }

    func testAnotherBoxsHintIsRefused() throws {
        let r = LanDirectRegistry(prober: Prober([]), clock: { [now] in now }, log: { _ in })
        let other = Curve25519.Signing.PrivateKey()
        XCTAssertEqual(r.accept(box: box, envelope: try envelope(lan: ["192.168.1.20"], direct: ["81.2.69.142"], orderKey: admin),
                                stkPub: other.publicKey.rawRepresentation, pinnedCertSha256: pin, authorityPubs: [admin.publicKey.rawRepresentation]),
                       "bad-signature")
    }
}
