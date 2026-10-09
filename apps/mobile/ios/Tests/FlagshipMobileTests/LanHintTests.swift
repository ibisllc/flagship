import XCTest
import CryptoKit
@testable import FlagshipAPI
import FlagshipCore

/// Mirrors packages/protocol/tests/lanHint.test.ts — same pinned vector.
final class LanHintTests: XCTestCase {
    let server = "abc5.harry1.flagship.services"
    let umk = Data(repeating: 7, count: 32)
    let cert = String(repeating: "ab", count: 32)
    let issued: Int64 = 1_791_500_000_000
    let canonicalString = "flagship/lan-hint/v1|abc5.harry1.flagship.services|"
        + "abababababababababababababababababababababababababababababababab|"
        + "192.168.1.20:443,[fd12:3456::7]:443|1791500000000|1791503600000"
    let sigHex = "9fc9b39958189204e86823a832b42257f3a2773d671a8292be0826c3a45e3cdb"
        + "b6c3f212dd159b73f86d5b9ad5815e8e024b3f9042c127133dfb30fdeb73e800"

    var stkPub: Data { ServerKeys.deriveStkPub(umkSeed: umk, serverId: server)! }
    var signer: Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: ServerKeys.deriveStkSeed(umkSeed: umk, serverId: server)!)
    }
    var hint: LanHint.Hint {
        LanHint.Hint(
            serverDomain: server, certSha256: cert,
            endpoints: [.init(address: "fd12:3456::7", port: 443), .init(address: "192.168.1.20", port: 443)],
            issuedAt: issued, expiresAt: issued + 3_600_000
        )
    }

    func reject(_ h: LanHint.Hint, sig: Data? = nil, now: Int64? = nil, domain: String? = nil, pin: String? = nil) -> String? {
        let s = sig ?? (try! signer.signature(for: LanHint.canonical(h)))
        return LanHint.reject(h, signature: s, stkPub: stkPub, serverDomain: domain ?? server,
                              certSha256: pin ?? cert, nowMs: now ?? issued + 1000)
    }

    func hint(_ eps: [LanHint.Endpoint], expires: Int64? = nil) -> LanHint.Hint {
        LanHint.Hint(serverDomain: server, certSha256: cert, endpoints: eps,
                     issuedAt: issued, expiresAt: expires ?? issued + 3_600_000)
    }

    func testCanonicalBytesMatchThePinnedString() {
        XCTAssertEqual(String(decoding: LanHint.canonical(hint), as: UTF8.self), canonicalString)
    }

    func testPinnedSignatureVerifies() {
        XCTAssertNil(reject(hint, sig: LanHint.hexDecode(sigHex)!))
    }

    func testRefusals() {
        let pinned = LanHint.hexDecode(sigHex)!
        XCTAssertEqual(reject(hint([.init(address: "192.168.1.99", port: 443)]), sig: pinned), "bad-signature")
        XCTAssertEqual(reject(hint, now: hint.expiresAt), "expired")
        XCTAssertEqual(reject(hint, now: issued - 10 * 60_000), "not-yet-valid")
        XCTAssertEqual(reject(hint, domain: "x.harry1.flagship.services"), "wrong-server")
        XCTAssertEqual(reject(hint, pin: String(repeating: "cd", count: 32)), "cert-mismatch")
        XCTAssertEqual(reject(hint([.init(address: "8.8.8.8", port: 443)])), "non-lan-endpoint")
        XCTAssertEqual(reject(hint(hint.endpoints, expires: issued + 25 * 3_600_000)), "ttl-too-long")
    }

    func testLanAddressFilter() {
        for a in ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.0.10", "fd00::1", "fc12:3456::1"] {
            XCTAssertTrue(LanHint.isLanAddress(a), a)
        }
        for a in ["172.15.0.1", "172.32.0.1", "8.8.8.8", "100.64.0.1", "127.0.0.1", "169.254.10.1", "0.0.0.0",
                  "224.0.0.1", "256.1.1.1", "::1", "fe80::1", "fc::1", "2001:db8::1", "::ffff:192.168.1.1",
                  "ff02::1", "", "localhost", "\u{FF11}0.0.0.1"] {
            XCTAssertFalse(LanHint.isLanAddress(a), a)
        }
    }
}

private actor FakeProber: LanProber {
    var reachable: Set<String>
    init(_ r: Set<String>) { reachable = r }
    func set(_ r: Set<String>) { reachable = r }
    func probe(sniHost: String, address: String, port: Int, certSha256: String) async -> Bool {
        reachable.contains(address)
    }
}

final class LanDirectRegistryTests: XCTestCase {
    let box = "home.alice.flagship.services"
    let umk = Data(repeating: 3, count: 32)
    let pin = String(repeating: "cd", count: 32)
    let start: Int64 = 1_000_000

    func envelope(_ eps: [LanHint.Endpoint], expires: Int64? = nil) -> LanHint.Envelope {
        let h = LanHint.Hint(serverDomain: box, certSha256: pin, endpoints: eps,
                             issuedAt: start, expiresAt: expires ?? start + 3_600_000)
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: ServerKeys.deriveStkSeed(umkSeed: umk, serverId: box)!)
        let sig = try! key.signature(for: LanHint.canonical(h))
        return .init(hint: h, signatureHex: sig.map { String(format: "%02x", $0) }.joined())
    }
    var stkPub: Data { ServerKeys.deriveStkPub(umkSeed: umk, serverId: box)! }

    func testRoutesOnlyAfterTheProbeProvesTheBox() async {
        let prober = FakeProber([])
        let t = start
        let r = LanDirectRegistry(prober: prober, clock: { t })
        XCTAssertNil(r.accept(box: box, envelope: envelope([.init(address: "192.168.1.20", port: 443)]),
                              stkPub: stkPub, pinnedCertSha256: pin))
        let first = await r.lanEndpoint(for: box)
        XCTAssertNil(first)
        await prober.set(["192.168.1.20"])
        let cached = await r.lanEndpoint(for: box)
        XCTAssertNil(cached, "a failed probe is cached for this network")
        r.onNetworkChanged()
        let after = await r.lanEndpoint(for: "photos.\(box)")
        XCTAssertEqual(after?.address, "192.168.1.20")
        let lookalike = await r.lanEndpoint(for: "x\(box)")
        XCTAssertNil(lookalike)
    }

    func testRefusedAndExpiredHintsNeverRoute() async {
        let prober = FakeProber(["10.0.0.7"])
        let t = start
        let r = LanDirectRegistry(prober: prober, clock: { t })
        XCTAssertEqual(r.accept(box: box, envelope: envelope([.init(address: "10.0.0.7", port: 443)]),
                                stkPub: Data(repeating: 1, count: 32), pinnedCertSha256: pin), "bad-signature")
        let refused = await r.lanEndpoint(for: box)
        XCTAssertNil(refused)

        let later = start + 30_000
        let r2 = LanDirectRegistry(prober: prober, clock: { later })
        _ = r2.accept(box: box, envelope: envelope([.init(address: "10.0.0.7", port: 443)], expires: start + 20_000),
                      stkPub: stkPub, pinnedCertSha256: pin)
        let expired = await r2.lanEndpoint(for: box)
        XCTAssertNil(expired)
    }

    func testMarkFailedStopsUsingTheLanRoute() async {
        let t = start
        let r = LanDirectRegistry(prober: FakeProber(["10.0.0.7"]), clock: { t })
        r.accept(box: box, envelope: envelope([.init(address: "10.0.0.7", port: 443)]), stkPub: stkPub, pinnedCertSha256: pin)
        let before = await r.lanEndpoint(for: box)
        XCTAssertNotNil(before)
        r.markFailed(host: box)
        let after = await r.lanEndpoint(for: box)
        XCTAssertNil(after)
    }

    func testOnlyPreDeliveryFailuresAreRetriedOverTheRelay() {
        XCTAssertTrue(LanDirectRegistry.failedBeforeDelivery(URLError(.cannotConnectToHost)))
        XCTAssertTrue(LanDirectRegistry.failedBeforeDelivery(URLError(.serverCertificateUntrusted)))
        XCTAssertFalse(LanDirectRegistry.failedBeforeDelivery(URLError(.timedOut)))
        XCTAssertFalse(LanDirectRegistry.failedBeforeDelivery(URLError(.networkConnectionLost)))
    }
}
