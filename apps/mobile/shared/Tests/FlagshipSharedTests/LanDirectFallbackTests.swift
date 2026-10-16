import XCTest
import CryptoKit
@testable import FlagshipAPI
import FlagshipCore

/// LAN-direct failure is a no-op (docs/lan-direct.md "Failure handling"):
/// a request never waits for a probe, and a LAN failure goes back to the relay.
final class LanDirectFallbackTests: XCTestCase {
    let box = "home.alice.flagship.services"
    let umk = Data(repeating: 3, count: 32)
    let pin = String(repeating: "cd", count: 32)
    let start: Int64 = 1_000_000

    private actor CountingProber: LanProber {
        var reachable: Set<String>
        var calls = 0
        init(_ r: Set<String>) { reachable = r }
        func probe(sniHost: String, address: String, port: Int, certSha256: String) async -> Bool {
            calls += 1
            return reachable.contains(address)
        }
    }

    private final class Lines: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [String] = []
        func add(_ s: String) { lock.lock(); all.append(s); lock.unlock() }
        func any(_ needle: String) -> Bool { lock.lock(); defer { lock.unlock() }; return all.contains { $0.contains(needle) } }
    }

    func envelope(_ eps: [LanHint.Endpoint]) -> LanHint.Envelope {
        let h = LanHint.Hint(serverDomain: box, certSha256: pin, endpoints: eps,
                             issuedAt: start, expiresAt: start + 3_600_000)
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: ServerKeys.deriveStkSeed(umkSeed: umk, serverId: box)!)
        let sig = try! key.signature(for: LanHint.canonical(h))
        return .init(hint: h, signatureHex: sig.map { String(format: "%02x", $0) }.joined())
    }
    var stkPub: Data { ServerKeys.deriveStkPub(umkSeed: umk, serverId: box)! }

    func testARequestNeverWaitsForTheProbe() async {
        let prober = CountingProber(["192.168.1.20"])
        let lines = Lines()
        let t = start
        let r = LanDirectRegistry(prober: prober, clock: { t }, log: { lines.add($0) })
        r.accept(box: box, envelope: envelope([.init(address: "192.168.1.20", port: 443)]), stkPub: stkPub, pinnedCertSha256: pin)
        XCTAssertNil(r.provenEndpoint(for: box), "the first request takes the relay")
        XCTAssertNil(r.provenEndpoint(for: box))
        await r.settleProbes()
        let calls = await prober.calls
        XCTAssertEqual(calls, 1, "one probe at a time per box")
        XCTAssertEqual(r.provenEndpoint(for: box)?.address, "192.168.1.20")
        XCTAssertTrue(lines.any("proved itself"))
    }

    func testAnAbsentBoxIsProbedOnceAndTheRelayStays() async {
        let prober = CountingProber([])
        let lines = Lines()
        let t = start
        let r = LanDirectRegistry(prober: prober, clock: { t }, log: { lines.add($0) })
        r.accept(box: box, envelope: envelope([.init(address: "192.168.1.20", port: 443)]), stkPub: stkPub, pinnedCertSha256: pin)
        _ = r.provenEndpoint(for: box)
        await r.settleProbes()
        XCTAssertNil(r.provenEndpoint(for: box))
        await r.settleProbes()
        let calls = await prober.calls
        XCTAssertEqual(calls, 1, "a failed probe is cached for this network")
        XCTAssertTrue(lines.any("using the relay"))
        XCTAssertNil(r.session(for: box))
    }

    func testAFailedLanRequestStopsLanUseUntilTheNetworkChanges() async {
        let lines = Lines()
        let t = start
        let r = LanDirectRegistry(prober: CountingProber(["10.0.0.7"]), clock: { t }, log: { lines.add($0) })
        r.accept(box: box, envelope: envelope([.init(address: "10.0.0.7", port: 443)]), stkPub: stkPub, pinnedCertSha256: pin)
        _ = r.provenEndpoint(for: box)
        await r.settleProbes()
        XCTAssertNotNil(r.provenEndpoint(for: box))
        r.markFailed(host: "photos.\(box)", why: "NSURLErrorDomain -1001")
        XCTAssertNil(r.provenEndpoint(for: box))
        XCTAssertTrue(lines.any("local route to photos.\(box) failed"))
        r.onNetworkChanged()
        _ = r.provenEndpoint(for: box)
        await r.settleProbes()
        XCTAssertNotNil(r.provenEndpoint(for: box))
    }

    func testWhatGoesAgainOverTheRelay() {
        // Never reached the box: any request.
        XCTAssertTrue(LanDirectRegistry.mayResendOverRelay(URLError(.cannotConnectToHost), method: "POST"))
        XCTAssertTrue(LanDirectRegistry.mayResendOverRelay(URLError(.serverCertificateUntrusted), method: "POST"))
        XCTAssertTrue(LanDirectRegistry.mayResendOverRelay(URLError(.notConnectedToInternet), method: "DELETE"))
        // The listener refused the CONNECT (or something else answered it).
        let proxy = NSError(domain: "kCFErrorDomainCFNetwork", code: 310)
        XCTAssertTrue(LanDirectRegistry.failedBeforeDelivery(proxy))
        XCTAssertTrue(LanDirectRegistry.mayResendOverRelay(proxy, method: "POST"))
        // Lost midway: only reads go again; a change could apply twice.
        XCTAssertTrue(LanDirectRegistry.mayResendOverRelay(URLError(.timedOut), method: "GET"))
        XCTAssertTrue(LanDirectRegistry.mayResendOverRelay(URLError(.networkConnectionLost), method: nil))
        XCTAssertFalse(LanDirectRegistry.mayResendOverRelay(URLError(.timedOut), method: "POST"))
        XCTAssertFalse(LanDirectRegistry.mayResendOverRelay(URLError(.networkConnectionLost), method: "PUT"))
    }
}
