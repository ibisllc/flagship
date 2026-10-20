import XCTest
import Network
@testable import FlagshipAPI

/// The relay addresses `.com` recommends (docs/relay-addresses.md): which are kept, that
/// each is tested against a known box before it is relied on, and the loopback proxy that
/// lets URLSession reach a box by a chosen address with TLS still ending on the box.
final class RelayFallbackTests: XCTestCase {
    // MARK: shared vectors (apps/mobile/test-vectors/relay-addresses.json)

    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<10 {
            let f = dir.appendingPathComponent("apps/mobile/test-vectors/relay-addresses.json")
            if let data = try? Data(contentsOf: f) { return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]) }
            dir.deleteLastPathComponent()
        }
        throw XCTSkip("relay-addresses.json not found above \(#filePath)")
    }

    func test_everySharedVectorGivesTheSameAddresses() throws {
        let list = try XCTUnwrap(try vectors()["endpoints"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(list.count, 10)
        for v in list {
            let body = try JSONSerialization.data(withJSONObject: try XCTUnwrap(v["body"]))
            let want = (v["expect"] as? [String] ?? []).compactMap(RelayAddressRules.key)
            let got = RelayAddressRules.fromEndpoints(body).compactMap(RelayAddressRules.key)
            XCTAssertEqual(got, want, v["name"] as? String ?? "")
        }
        for junk in try XCTUnwrap(try vectors()["notJson"] as? [String]) {
            XCTAssertEqual(RelayAddressRules.fromEndpoints(Data(junk.utf8)), [], junk)
        }
    }

    // MARK: the registry

    private final class Prober: LanProber, @unchecked Sendable {
        let passes: Set<String>
        private let lock = NSLock()
        private var asked: [String] = []
        init(passes: Set<String>) { self.passes = passes }
        var calls: [String] { lock.lock(); defer { lock.unlock() }; return asked }
        func probe(sniHost: String, address: String, port: Int, certSha256: String) async -> Bool {
            lock.lock(); asked.append("\(address)|\(sniHost)|\(port)|\(certSha256)"); lock.unlock()
            return passes.contains(address)
        }
    }

    private final class Clock: @unchecked Sendable { var now: Int64 = 1_000 }

    /// Answers the relay echo: itself by default, or whatever `says` maps an address to (nil = no answer).
    private struct Echoes: RelayEcho {
        var says: @Sendable (String) -> String? = { $0 }
        func reachedAt(address: String) async -> String? { says(address) }
    }

    private func registry(_ prober: Prober, clock: Clock = Clock(), body: String? = nil, target: Bool = true, echo: Echoes = Echoes()) -> RelayAddressRegistry {
        let r = RelayAddressRegistry(defaults: UserDefaults(suiteName: "relay-\(UUID().uuidString)")!, clock: { clock.now }, prober: prober, echo: echo)
        r.configure(
            fetchBody: { body.map { Data($0.utf8) } },
            pinTarget: { target ? (host: "home.alice.flagship.services", pin: String(repeating: "ab", count: 32)) : nil }
        )
        return r
    }

    private let seed = RelayAddresses.prod
    private let endpoints = #"{"version":1,"passthroughIPv4":"203.0.113.7","passthroughIPv6":"2001:db8::7"}"#

    // A recommendation is kept, but only used once it has passed the test: the untested
    // last resort is the compiled-in seed alone.
    func test_aRecommendationIsKeptButNeverUsedUntested() async {
        let r = registry(Prober(passes: []), body: endpoints)
        XCTAssertEqual(r.addresses(seed: seed), seed)
        let kept = await r.refresh()
        XCTAssertTrue(kept)
        XCTAssertEqual(r.stored(), ["203.0.113.7", "2001:db8::7"])
        XCTAssertEqual(r.addresses(seed: seed), seed)
    }

    func test_aFailedFetchOrJunkChangesNothing() async {
        let good = registry(Prober(passes: []), body: endpoints)
        _ = await good.refresh()
        let before = good.stored()
        good.configure(fetchBody: { Data("not json".utf8) }, pinTarget: { nil })
        let junk = await good.refresh()
        XCTAssertFalse(junk)
        good.configure(fetchBody: { nil }, pinTarget: { nil })
        let none = await good.refresh()
        XCTAssertFalse(none)
        XCTAssertEqual(good.stored(), before)
    }

    func test_onlyAddressesThatPassTheTestAreProven() async {
        let prober = Prober(passes: ["203.0.113.7"])
        let r = registry(prober, body: endpoints)
        _ = await r.refresh()
        let proven = await r.proven(seed: seed)
        XCTAssertEqual(proven, ["203.0.113.7"])
        XCTAssertTrue(prober.calls.contains("203.0.113.7|home.alice.flagship.services|443|\(String(repeating: "ab", count: 32))"))
    }

    // The echo: an address `.com` recommended must say it is itself. A forwarder in front of
    // the relay passes the pinned handshake, but its echo names the relay behind it.
    func test_aForwarderThatPassesTheHandshakeButEchoesAnotherAddressIsDropped() async {
        let r = registry(Prober(passes: Set(["203.0.113.7"] + seed)), body: endpoints,
                         echo: Echoes(says: { $0 == "203.0.113.7" ? RelayAddresses.prod[0] : $0 }))
        _ = await r.refresh()
        let proven = await r.proven(seed: seed)
        XCTAssertEqual(proven, seed)
    }

    func test_anAddressWithNoEchoIsDroppedButTheSeedNeedsNone() async {
        let r = registry(Prober(passes: Set(["203.0.113.7"] + seed)), body: endpoints, echo: Echoes(says: { _ in nil }))
        _ = await r.refresh()
        let proven = await r.proven(seed: seed)
        XCTAssertEqual(proven, seed)
    }

    func test_anAddressThatEchoesItselfIsProvenWhicheverWayItIsWritten() async {
        let r = registry(Prober(passes: ["2001:db8::7"]), body: #"{"passthroughIPv6":"2001:db8::7"}"#,
                         echo: Echoes(says: { _ in "2001:0db8:0000:0000:0000:0000:0000:0007" }))
        _ = await r.refresh()
        let proven = await r.proven(seed: seed)
        XCTAssertEqual(proven, ["2001:db8::7"])
    }

    func test_anEchoReplyIsReadStrictly() {
        func reply(_ json: String) -> Data { Data("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n\(json)".utf8) }
        XCTAssertEqual(RelayAddressRules.parseEchoReply(reply(#"{"relay":"flagship.services","reachedAt":"149.248.216.86"}"#)), "149.248.216.86")
        XCTAssertNil(RelayAddressRules.parseEchoReply(reply(#"{"reachedAt":null}"#)))
        XCTAssertNil(RelayAddressRules.parseEchoReply(reply(#"{"reachedAt":"10.0.0.7"}"#)))
        XCTAssertNil(RelayAddressRules.parseEchoReply(reply(#"{"reachedAt":"relay.example.com"}"#)))
        XCTAssertNil(RelayAddressRules.parseEchoReply(Data("garbage".utf8)))
    }

    func test_withNoKnownBoxNothingIsProvenAndNothingIsProbed() async {
        let prober = Prober(passes: Set(seed))
        let r = registry(prober, target: false)
        let proven = await r.proven(seed: seed)
        XCTAssertEqual(proven, [])
        XCTAssertEqual(prober.calls, [])
    }

    func test_aResultIsKeptForAWhileThenTestedAgain() async {
        let clock = Clock()
        let prober = Prober(passes: Set(seed))
        let r = registry(prober, clock: clock)
        _ = await r.proven(seed: seed)
        _ = await r.proven(seed: seed)
        XCTAssertEqual(prober.calls.count, seed.count)
        clock.now += RelayAddressRegistry.goodMs + 1
        _ = await r.proven(seed: seed)
        XCTAssertEqual(prober.calls.count, seed.count * 2)
    }

    func test_aFailedTestIsRetriedSoonerThanAPassedOne() async {
        let clock = Clock()
        let prober = Prober(passes: [])
        let r = registry(prober, clock: clock)
        let none = await r.proven(seed: seed)
        XCTAssertEqual(none, [])
        clock.now += RelayAddressRegistry.badMs + 1
        _ = await r.proven(seed: seed)
        XCTAssertEqual(prober.calls.count, seed.count * 2)
    }

    func test_theRelayRouteIsForTheProdApexOnly() {
        let prod = RelayRoute(registry: registry(Prober(passes: [])), apex: { "flagship.services" })
        XCTAssertTrue(prod.eligible(host: "home.alice.flagship.services"))
        XCTAssertFalse(prod.eligible(host: "relay-fallback.flagship.services"))
        XCTAssertFalse(prod.eligible(host: "flagship.services"))
        XCTAssertFalse(prod.eligible(host: "example.com"))
        XCTAssertFalse(prod.eligible(host: "home.alice.notflagship.services"))
        let gym = RelayRoute(registry: registry(Prober(passes: [])), apex: { "gym.flagship.services" })
        XCTAssertFalse(gym.eligible(host: "home.alice.gym.flagship.services"))
    }

    // MARK: the CONNECT line

    func test_aConnectRequestIsReadAndAnythingElseIsRefused() {
        let ok = Data("CONNECT home.alice.flagship.services:443 HTTP/1.1\r\nHost: home.alice.flagship.services:443\r\n\r\n".utf8)
        XCTAssertEqual(RelayConnectRequest.parse(ok), .target(host: "home.alice.flagship.services", port: 443, rest: Data()))
        XCTAssertEqual(RelayConnectRequest.parse(Data("CONNECT a:443 HTTP/1.1\r\n".utf8)), .incomplete)
        for bad in ["GET / HTTP/1.1\r\n\r\n", "CONNECT a HTTP/1.1\r\n\r\n", "CONNECT a:0 HTTP/1.1\r\n\r\n", "CONNECT :443 HTTP/1.1\r\n\r\n", "CONNECT a:443 SPDY/3\r\n\r\n"] {
            XCTAssertEqual(RelayConnectRequest.parse(Data(bad.utf8)), .refused, bad)
        }
        XCTAssertEqual(RelayConnectRequest.parse(Data(repeating: 65, count: RelayConnectRequest.maxHeaderBytes + 1)), .refused)
        let extra = Data("CONNECT a.b:443 HTTP/1.1\r\n\r\nhello".utf8)
        XCTAssertEqual(RelayConnectRequest.parse(extra), .target(host: "a.b", port: 443, rest: Data("hello".utf8)))
    }

    // MARK: the loopback proxy, over real sockets

    private final class Echo: @unchecked Sendable {
        let listener: NWListener
        let port: UInt16
        init() throws {
            let p = NWParameters.tcp
            p.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
            listener = try NWListener(using: p)
            let q = DispatchQueue(label: "echo")
            let ready = DispatchSemaphore(value: 0)
            listener.newConnectionHandler = { c in
                c.start(queue: q)
                @Sendable func loop() {
                    c.receive(minimumIncompleteLength: 1, maximumLength: 4096) { d, _, done, e in
                        if let d, !d.isEmpty { c.send(content: d, completion: .contentProcessed { _ in }) }
                        if e == nil && !done { loop() } else { c.cancel() }
                    }
                }
                loop()
            }
            listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
            listener.start(queue: q)
            _ = ready.wait(timeout: .now() + 3)
            port = listener.port?.rawValue ?? 0
        }
    }

    /// Sends `request` to the proxy and returns everything it answers until `until` is seen.
    private func talk(to proxy: UInt16, send: [String], until: String) async -> String {
        let conn = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: proxy)!, using: .tcp)
        let q = DispatchQueue(label: "client")
        let box = Collected()
        return await withCheckedContinuation { (cont: CheckedContinuation<String, Never>) in
            let done = Once()
            let finish: @Sendable () -> Void = { if done.first() { conn.cancel(); cont.resume(returning: box.text) } }
            conn.stateUpdateHandler = { state in
                if case .ready = state {
                    var queue = send
                    @Sendable func sendNext() {
                        guard !queue.isEmpty else { return }
                        let part = queue.removeFirst()
                        conn.send(content: Data(part.utf8), completion: .contentProcessed { _ in })
                    }
                    sendNext()
                    @Sendable func read() {
                        conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { d, _, complete, e in
                            if let d { box.append(String(decoding: d, as: UTF8.self)) }
                            if box.text.contains(until) || e != nil || complete { return finish() }
                            if box.text.hasPrefix("HTTP/1.1 200"), !queue.isEmpty { sendNext() }
                            read()
                        }
                    }
                    read()
                } else if case .failed = state { finish() }
            }
            conn.start(queue: q)
            q.asyncAfter(deadline: .now() + 5) { finish() }
        }
    }

    private final class Collected: @unchecked Sendable {
        private let lock = NSLock()
        private var s = ""
        var text: String { lock.lock(); defer { lock.unlock() }; return s }
        func append(_ t: String) { lock.lock(); s += t; lock.unlock() }
    }

    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var used = false
        func first() -> Bool { lock.lock(); defer { lock.unlock() }; if used { return false }; used = true; return true }
    }

    func test_theProxyPassesBytesBothWaysToTheFirstAddressThatAnswers() async throws {
        let echo = try Echo()
        let started = await LoopbackAddressShim.start(apex: "flagship.services", connectTimeout: 1, upstreamPort: Int(echo.port)) { ["127.0.0.1"] }
        let proxy = try XCTUnwrap(started)
        defer { proxy.stop(); echo.listener.cancel() }
        let out = await talk(to: proxy.port, send: ["CONNECT home.alice.flagship.services:443 HTTP/1.1\r\n\r\n", "ping-through"], until: "ping-through")
        XCTAssertTrue(out.hasPrefix("HTTP/1.1 200 Connection Established\r\n\r\n"), out)
        XCTAssertTrue(out.hasSuffix("ping-through"), out)
    }

    func test_theProxyServesOnlyNamesUnderTheApexAndAnswersBadGatewayWhenNothingAnswers() async throws {
        let started = await LoopbackAddressShim.start(apex: "flagship.services", connectTimeout: 1, upstreamPort: 9) { [] }
        let proxy = try XCTUnwrap(started)
        defer { proxy.stop() }
        let other = await talk(to: proxy.port, send: ["CONNECT example.com:443 HTTP/1.1\r\n\r\n"], until: "\r\n\r\n")
        XCTAssertTrue(other.hasPrefix("HTTP/1.1 403"), other)
        let none = await talk(to: proxy.port, send: ["CONNECT home.alice.flagship.services:443 HTTP/1.1\r\n\r\n"], until: "\r\n\r\n")
        XCTAssertTrue(none.hasPrefix("HTTP/1.1 502"), none)
    }

    // MARK: the proxy's limits and lifecycle

    func test_aClientThatNeverFinishesItsRequestIsClosed() async throws {
        let started = await LoopbackAddressShim.start(apex: "flagship.services", connectTimeout: 1, upstreamPort: 9) { [] }
        let proxy = try XCTUnwrap(started)
        defer { proxy.stop() }
        let conn = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: proxy.port)!, using: .tcp)
        let closed = XCTestExpectation(description: "closed by the proxy")
        conn.stateUpdateHandler = { state in
            if case .ready = state {
                conn.send(content: Data("CONNECT home.alice".utf8), completion: .contentProcessed { _ in })
                conn.receive(minimumIncompleteLength: 1, maximumLength: 1) { _, _, _, _ in closed.fulfill() }
            }
        }
        conn.start(queue: DispatchQueue(label: "slow-client"))
        await fulfillment(of: [closed], timeout: LoopbackAddressShim.headDeadline + 3)
        conn.cancel()
    }

    func test_clientsPastTheCapAreRefusedAndTheCountComesBackDown() async throws {
        let started = await LoopbackAddressShim.start(apex: "flagship.services", connectTimeout: 1, upstreamPort: 9) { [] }
        let proxy = try XCTUnwrap(started)
        defer { proxy.stop() }
        var held: [NWConnection] = []
        for _ in 0..<LoopbackAddressShim.maxClients {
            let c = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: proxy.port)!, using: .tcp)
            c.start(queue: DispatchQueue(label: "holder"))
            held.append(c)
        }
        try await Task.sleep(nanoseconds: 800_000_000)
        XCTAssertLessThanOrEqual(proxy.clientCount, LoopbackAddressShim.maxClients)
        let over = await talk(to: proxy.port, send: ["CONNECT home.alice.flagship.services:443 HTTP/1.1\r\n\r\n"], until: "\r\n\r\n")
        XCTAssertFalse(over.hasPrefix("HTTP/1.1 502"), "a client past the cap must not be served: \(over)")
        held.forEach { $0.cancel() }
        try await Task.sleep(nanoseconds: 800_000_000)
        XCTAssertEqual(proxy.clientCount, 0)
    }

    func test_suspendingStopsTheListenerAndTheNextNeedStartsANewOne() async throws {
        let route = RelayRoute(registry: registry(Prober(passes: Set(seed))), apex: { "flagship.services" })
        route.configure(pinFor: { _ in String(repeating: "ab", count: 32) })
        let first = await route.session(for: "home.alice.flagship.services")
        XCTAssertNotNil(first)
        let port1 = try XCTUnwrap(route.forwarderPort)
        route.suspend()
        XCTAssertNil(route.forwarderPort)
        // The old session is invalid: a caller that kept it fails instead of meeting a stranger on that port.
        let stale = try? await first?.data(from: URL(string: "https://home.alice.flagship.services/")!)
        XCTAssertNil(stale)
        let second = await route.session(for: "home.alice.flagship.services")
        XCTAssertNotNil(second)
        XCTAssertNotNil(route.forwarderPort)
        _ = port1
        route.suspend()
    }

    func test_theDiagnosticsLogKeepsTheRealReasonAndStaysSmall() {
        let log = DiagnosticsLog()
        for i in 0..<(DiagnosticsLog.capacity + 5) { log.record(code: DiagnosticCode.relayRouteUnverified, host: "h\(i)", detail: "net-dropped") }
        XCTAssertEqual(log.recent().count, DiagnosticsLog.capacity)
        XCTAssertEqual(log.recent().first?.host, "h5")
        XCTAssertTrue(log.text().contains("relay-route-unverified h54 net-dropped"))
        XCTAssertEqual(DiagnosticCode.of(URLError(.cannotFindHost)), "net-name-lookup")
        XCTAssertEqual(DiagnosticCode.of(URLError(.serverCertificateUntrusted)), "tls-failed")
        XCTAssertEqual(DiagnosticCode.of(ScreensClientError.certPinMismatch(host: "h")), "tls-pin-mismatch")
        XCTAssertEqual(DiagnosticCode.of(ScreensClientError.http(status: 503, message: "")), "http-503")
    }
}
