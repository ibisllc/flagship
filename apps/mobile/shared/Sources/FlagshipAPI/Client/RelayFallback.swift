import Foundation
import CryptoKit
#if canImport(Network)
import Network
#endif

// A box's name that won't resolve is not a box that is down (docs/relay-addresses.md).
//
// When the phone cannot look up `<server>.<user>.flagship.services` (a home router's
// cached "no such name"), the request is sent to the relay's address directly, with the
// box's name still used for SNI, hostname checks and the certificate pin. Where the
// relay is comes from `.com` (`GET /api/services/endpoints`, over ordinary TLS), and
// each address is tested first: a handshake under a known box's name that ends in the
// box's own pinned certificate shows the relay is up and forwarding for it. The
// compiled-in seed is only the last resort. Nothing here is trusted with the box: a
// wrong address can only fail to connect, and a failed attempt reads as the unresolved
// name it was before, never as a TLS or trust error.

/// The relay's addresses (Fly dedicated pair, the same as SERVICES_PASSTHROUGH_IPV4/6
/// in apps/com/wrangler.toml). The last resort, for the prod apex only.
public enum RelayAddresses {
    public static let prod: [String] = ["149.248.216.86", "2a09:8280:1::110:d2b6:0"]
}

public enum RelayAddressRules {
    public static let maxAddresses = 8

    /// An IP literal (never a hostname, so parsing it cannot cause a lookup) that is a
    /// public unicast address, or nil: not the phone, the local network, a shared range
    /// or multicast.
    public static func parse(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.contains("%") else { return nil }
        #if canImport(Network)
        if let v4 = IPv4Address(t) {
            let b = [UInt8](v4.rawValue)
            guard b.count == 4 else { return nil }
            let (a, c) = (Int(b[0]), Int(b[1]))
            let local = a == 0 || a == 10 || a == 127 || (a == 100 && (c & 0xc0) == 0x40) || (a == 169 && c == 254)
                || (a == 172 && (c & 0xf0) == 0x10) || (a == 192 && c == 168) || a >= 224
            return local ? nil : "\(b[0]).\(b[1]).\(b[2]).\(b[3])"
        }
        if let v6 = IPv6Address(t) {
            let b = [UInt8](v6.rawValue)
            guard b.count == 16, (b[0] & 0xe0) == 0x20 else { return nil }
            return v6.debugDescription
        }
        #endif
        return nil
    }

    /// The same address, whichever way it is written (for comparing and de-duplicating).
    public static func key(_ text: String) -> Data? {
        #if canImport(Network)
        if let v4 = IPv4Address(text) { return v4.rawValue }
        if let v6 = IPv6Address(text) { return v6.rawValue }
        #endif
        return nil
    }

    /// The recommended addresses in a `/api/services/endpoints` body: IPv4 then IPv6, public ones only.
    public static func fromEndpoints(_ body: Data) -> [String] {
        guard let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return [] }
        var out: [String] = []
        var seen = Set<Data>()
        for field in ["passthroughIPv4", "passthroughIPv6"] {
            guard let text = o[field] as? String, let a = parse(text), let k = key(a), seen.insert(k).inserted else { continue }
            out.append(a)
        }
        return Array(out.prefix(maxAddresses))
    }
}

public final class RelayAddressRegistry: @unchecked Sendable {
    public static let shared = RelayAddressRegistry()
    public static let storeKey = "flagship.relayAddresses.v1"
    public static let goodMs: Int64 = 10 * 60_000
    public static let badMs: Int64 = 2 * 60_000
    public static let pollMs: Int64 = 24 * 3_600_000

    private let defaults: UserDefaults
    private let clock: @Sendable () -> Int64
    private let prober: LanProber
    private let lock = NSLock()
    private var tested: [Data: (ok: Bool, at: Int64)] = [:]
    private var fetchBody: (@Sendable () async -> Data?)?
    private var pinTarget: (@Sendable () -> (host: String, pin: String)?)?
    private var lastFetch: Int64 = 0

    #if canImport(Network)
    public init(defaults: UserDefaults = .standard,
                clock: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                prober: LanProber = TlsPinProber(timeout: 2.5)) {
        self.defaults = defaults
        self.clock = clock
        self.prober = prober
    }
    #else
    public init(defaults: UserDefaults = .standard,
                clock: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                prober: LanProber) {
        self.defaults = defaults
        self.clock = clock
        self.prober = prober
    }
    #endif

    /// App-layer glue: how to read `.com`'s answer, and a known box to test addresses with.
    public func configure(fetchBody: @escaping @Sendable () async -> Data?,
                          pinTarget: @escaping @Sendable () -> (host: String, pin: String)?) {
        lock.lock()
        self.fetchBody = fetchBody
        self.pinTarget = pinTarget
        lock.unlock()
    }

    /// The last good answer, or empty (a corrupt store is an empty one).
    public func stored() -> [String] {
        guard let data = defaults.data(forKey: Self.storeKey),
              let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let list = o["addresses"] as? [String] else { return [] }
        return list.compactMap(RelayAddressRules.parse)
    }

    /// What to try when DNS fails: what `.com` last recommended, then `seed`. Never throws.
    public func addresses(seed: [String]) -> [String] {
        var seen = Set<Data>()
        return (stored() + seed).filter { a in RelayAddressRules.key(a).map { seen.insert($0).inserted } ?? false }
    }

    /// One anonymous GET; a usable answer replaces the stored one, anything else leaves it.
    @discardableResult
    public func refresh() async -> Bool {
        let fetch = locked { () -> (@Sendable () async -> Data?)? in lastFetch = clock(); return fetchBody }
        guard let fetch, let body = await fetch() else { return false }
        let found = RelayAddressRules.fromEndpoints(body)
        guard !found.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: ["addresses": found, "at": clock()]) else { return false }
        defaults.set(data, forKey: Self.storeKey)
        return true
    }

    /// Fetch about daily; call at launch and on return to the foreground.
    public func startIfDue() {
        guard locked({ clock() - lastFetch >= Self.pollMs }) else { return }
        Task.detached { [self] in
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            await refresh()
        }
    }

    /// The candidates (then `seed`) that pass the test right now, best first: a handshake under a
    /// known box's name that ends in its pinned certificate. Empty when no box is known to test
    /// with or none pass. Results are kept for `goodMs` (passed) or `badMs` (failed).
    public func proven(seed: [String]) async -> [String] {
        guard let target = locked({ pinTarget })?() else { return [] }
        let candidates = addresses(seed: seed)
        let now = clock()
        let stale = candidates.filter { a in
            guard let k = RelayAddressRules.key(a), let t = locked({ tested[k] }) else { return true }
            return now - t.at >= (t.ok ? Self.goodMs : Self.badMs)
        }
        await withTaskGroup(of: (Data, Bool).self) { group in
            for a in stale {
                guard let k = RelayAddressRules.key(a) else { continue }
                group.addTask { [prober] in (k, await prober.probe(sniHost: target.host, address: a, port: 443, certSha256: target.pin)) }
            }
            for await (k, ok) in group { locked { tested[k] = (ok, now) } }
        }
        return candidates.filter { a in RelayAddressRules.key(a).flatMap { k in locked { tested[k]?.ok } } == true }
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

/// The CONNECT line a client sends a proxy: `CONNECT host:port HTTP/1.1`.
public enum RelayConnectRequest {
    public static let maxHeaderBytes = 8192

    /// The target of a complete CONNECT request, nil while the headers are unfinished,
    /// and `.refused` for anything else.
    public enum Parsed: Equatable, Sendable {
        case incomplete
        case refused
        case target(host: String, port: Int, rest: Data)
    }

    public static func parse(_ data: Data) -> Parsed {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else {
            return data.count > maxHeaderBytes ? .refused : .incomplete
        }
        guard let head = String(data: data[..<end.lowerBound], encoding: .utf8),
              let line = head.split(separator: "\r\n", omittingEmptySubsequences: false).first else { return .refused }
        let parts = line.split(separator: " ")
        guard parts.count == 3, parts[0] == "CONNECT", parts[2].hasPrefix("HTTP/1."),
              let colon = parts[1].lastIndex(of: ":"),
              let port = Int(parts[1][parts[1].index(after: colon)...]), (1...65535).contains(port) else { return .refused }
        let host = String(parts[1][..<colon]).trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        guard !host.isEmpty else { return .refused }
        return .target(host: host, port: port, rest: Data(data[end.upperBound...]))
    }
}

#if canImport(Network)
/// A proxy on the phone's own loopback that gives URLSession a way to reach a box by a chosen
/// address: it accepts `CONNECT <box>:443`, opens a TCP connection to the first relay address
/// that answers, and passes the bytes through. TLS stays between URLSession and the box (SNI,
/// hostname check and the pin all run on the box's name), so this sees only ciphertext. It
/// serves names under the data apex and nothing else.
public final class RelayForwarder: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "flagship.relay-forwarder")
    private let addresses: @Sendable () -> [String]
    private let apex: String
    private let connectTimeout: TimeInterval
    private let upstreamPort: Int
    private let lock = NSLock()
    private var alive = true
    public let port: UInt16

    public var isAlive: Bool { lock.lock(); defer { lock.unlock() }; return alive }

    /// Starts listening on 127.0.0.1; nil if it cannot (the system took the listener away).
    public static func start(apex: String, connectTimeout: TimeInterval = 3, upstreamPort: Int = 443,
                             addresses: @escaping @Sendable () -> [String]) async -> RelayForwarder? {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        guard let listener = try? NWListener(using: params) else { return nil }
        let queue = DispatchQueue(label: "flagship.relay-forwarder.start")
        let port: UInt16? = await withCheckedContinuation { (cont: CheckedContinuation<UInt16?, Never>) in
            let once = PortOnce(cont)
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: once.resume(listener.port?.rawValue)
                case .failed, .cancelled: once.resume(nil)
                default: break
                }
            }
            listener.newConnectionHandler = { _ in }
            listener.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 2) { once.resume(nil) }
        }
        guard let port else { listener.cancel(); return nil }
        let f = RelayForwarder(listener: listener, port: port, apex: apex, connectTimeout: connectTimeout, upstreamPort: upstreamPort, addresses: addresses)
        listener.newConnectionHandler = { [weak f] conn in f?.accept(conn) }
        listener.stateUpdateHandler = { [weak f] state in
            if case .failed = state { f?.stop() }
            if case .cancelled = state { f?.stop() }
        }
        return f
    }

    private init(listener: NWListener, port: UInt16, apex: String, connectTimeout: TimeInterval, upstreamPort: Int, addresses: @escaping @Sendable () -> [String]) {
        self.listener = listener
        self.port = port
        self.apex = apex.lowercased()
        self.connectTimeout = connectTimeout
        self.upstreamPort = upstreamPort
        self.addresses = addresses
    }

    public func stop() {
        lock.lock()
        alive = false
        lock.unlock()
        listener.cancel()
    }

    private func accept(_ client: NWConnection) {
        client.start(queue: queue)
        readHead(client, buffer: Data())
    }

    private func readHead(_ client: NWConnection, buffer: Data) {
        client.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [self] data, _, _, error in
            guard error == nil, let data else { return client.cancel() }
            let all = buffer + data
            switch RelayConnectRequest.parse(all) {
            case .incomplete:
                readHead(client, buffer: all)
            case .refused:
                reply(client, "HTTP/1.1 400 Bad Request\r\n\r\n")
            case let .target(host, port, rest):
                guard port == 443, host.hasSuffix(".\(apex)") else { return reply(client, "HTTP/1.1 403 Forbidden\r\n\r\n") }
                connectUpstream(client, port: upstreamPort, candidates: addresses(), rest: rest)
            }
        }
    }

    private func reply(_ client: NWConnection, _ text: String) {
        client.send(content: Data(text.utf8), completion: .contentProcessed { _ in client.cancel() })
    }

    private func connectUpstream(_ client: NWConnection, port: Int, candidates: [String], rest: Data) {
        guard let address = candidates.first, let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
            return reply(client, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
        }
        let upstream = NWConnection(host: NWEndpoint.Host(address), port: nwPort, using: .tcp)
        let once = PortOnce2()
        upstream.stateUpdateHandler = { [self] state in
            switch state {
            case .ready:
                guard once.first() else { return }
                client.send(content: Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8), completion: .contentProcessed { [self] err in
                    guard err == nil else { upstream.cancel(); return client.cancel() }
                    if !rest.isEmpty { upstream.send(content: rest, completion: .contentProcessed { _ in }) }
                    pump(from: client, to: upstream)
                    pump(from: upstream, to: client)
                })
            case .failed, .waiting, .cancelled:
                guard once.first() else { return }
                upstream.cancel()
                connectUpstream(client, port: port, candidates: Array(candidates.dropFirst()), rest: rest)
            default:
                break
            }
        }
        upstream.start(queue: queue)
        queue.asyncAfter(deadline: .now() + connectTimeout) {
            guard once.first() else { return }
            upstream.cancel()
            self.connectUpstream(client, port: port, candidates: Array(candidates.dropFirst()), rest: rest)
        }
    }

    private func pump(from: NWConnection, to: NWConnection) {
        from.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, isComplete, error in
            if let data, !data.isEmpty {
                to.send(content: data, completion: .contentProcessed { err in
                    if err != nil { from.cancel(); to.cancel() } else if !isComplete && error == nil { self.pump(from: from, to: to) }
                })
            }
            if error != nil {
                from.cancel(); to.cancel()
            } else if isComplete {
                to.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .idempotent)
            } else if data == nil || data!.isEmpty {
                pump(from: from, to: to)
            }
        }
    }
}

private final class PortOnce: @unchecked Sendable {
    private var cont: CheckedContinuation<UInt16?, Never>?
    private let lock = NSLock()
    init(_ c: CheckedContinuation<UInt16?, Never>) { cont = c }
    func resume(_ v: UInt16?) {
        lock.lock()
        let c = cont
        cont = nil
        lock.unlock()
        c?.resume(returning: v)
    }
}

private final class PortOnce2: @unchecked Sendable {
    private var used = false
    private let lock = NSLock()
    func first() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if used { return false }
        used = true
        return true
    }
}

/// The relay route for a box name DNS could not answer: a session that reaches the box through
/// the relay addresses (tested ones first), pinned the same as every box session. A hint, so
/// any failure of it is the caller's cue to treat the name as unresolved.
public final class RelayRoute: @unchecked Sendable {
    public static let shared = RelayRoute()

    private let registry: RelayAddressRegistry
    private let apex: @Sendable () -> String
    private let lock = NSLock()
    private var forwarder: RelayForwarder?
    private var current: [String] = []
    private var session: URLSession?
    private var pinFor: (@Sendable (String) -> String?)?

    public init(registry: RelayAddressRegistry = .shared, apex: @escaping @Sendable () -> String = { Endpoints.dataApex }) {
        self.registry = registry
        self.apex = apex
    }

    public func configure(pinFor: @escaping @Sendable (String) -> String?) {
        lock.lock()
        self.pinFor = pinFor
        lock.unlock()
    }

    /// Prod apex only, like the seed: a gym run's relay is not in the built-in list.
    public func eligible(host: String) -> Bool {
        let a = apex().lowercased()
        let h = host.lowercased()
        return a == Endpoints.prodDataApex && h.hasSuffix(".\(a)") && h != "relay-fallback.\(a)"
    }

    /// A session through the relay for `host`, or nil when none is possible.
    public func session(for host: String) async -> URLSession? {
        guard eligible(host: host) else { return nil }
        let tested = await registry.proven(seed: RelayAddresses.prod)
        let order = tested.isEmpty ? registry.addresses(seed: RelayAddresses.prod) : tested
        guard !order.isEmpty, lock.withLock({ pinFor != nil }) else { return nil }
        let live: RelayForwarder? = lock.withLock { current = order; return forwarder.flatMap { $0.isAlive ? $0 : nil } }
        let f: RelayForwarder
        if let live {
            f = live
        } else {
            guard let started = await RelayForwarder.start(apex: apex(), addresses: { [weak self] in self?.lock.withLock { self?.current ?? [] } ?? [] }) else { return nil }
            lock.withLock { forwarder = started; session = nil }
            f = started
        }
        return lock.withLock { () -> URLSession? in
            if let session { return session }
            guard let pinFor else { return nil }
            let cfg = URLSessionConfiguration.default
            cfg.proxyConfigurations = [
                ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: f.port) ?? .any), tlsOptions: nil),
            ]
            let s = URLSession(configuration: cfg, delegate: BoxCertPinningDelegate(pinFor: pinFor), delegateQueue: nil)
            session = s
            return s
        }
    }
}
#endif

/// The one anonymous GET to `.com` for the relay's addresses: nothing in it, no cookies, no
/// redirects followed, a small answer or none.
public enum RelayAddressFetcher {
    public static let path = "/api/services/endpoints"

    private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    public static func fetch(base: URL = Endpoints.controlBaseUrl) async -> Data? {
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        c.httpCookieStorage = nil
        c.urlCredentialStorage = nil
        c.urlCache = nil
        c.timeoutIntervalForRequest = 20
        c.waitsForConnectivity = false
        let session = URLSession(configuration: c, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) ?? URLComponents()
        comps.path = path
        comps.query = nil
        guard let url = comps.url else { return nil }
        var req = URLRequest(url: url)
        req.httpShouldHandleCookies = false
        req.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, resp) = try? await session.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200, data.count <= 100_000 else { return nil }
        return data
    }
}
