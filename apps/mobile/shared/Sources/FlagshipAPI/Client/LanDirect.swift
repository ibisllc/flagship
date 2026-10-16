import Foundation
import CryptoKit
import os
#if canImport(Network)
import Network
#endif

/// LAN-direct (docs/lan-direct.md): reach a box over the local network instead
/// of the `.services` relay when the phone is next to it.
///
/// URLSession can't resolve one host to a chosen address, so the LAN route is a
/// separate session that uses the box's LAN listener as an HTTP CONNECT proxy:
/// the URL, SNI and certificate validation all stay on the real hostname, and
/// the same pinning delegate enforces the box fingerprint.
///
/// A hint is only ever used after a probe proves the box is really there on
/// THIS network — a TLS handshake to the endpoint with SNI = the box host whose
/// leaf matches the pin. Probes are cached per network and dropped on any path
/// change.
///
/// Failure is a no-op: probes run in the background (a request never waits
/// for one), and a request that fails on the LAN route stops LAN use on this
/// network and, when it can't apply a change twice, goes again over the relay.
public protocol LanProber: Sendable {
    func probe(sniHost: String, address: String, port: Int, certSha256: String) async -> Bool
}

#if canImport(Network)
public struct TlsPinProber: LanProber {
    public let timeout: TimeInterval
    public init(timeout: TimeInterval = 1.5) { self.timeout = timeout }

    public func probe(sniHost: String, address: String, port: Int, certSha256: String) async -> Bool {
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else { return false }
        let tls = NWProtocolTLS.Options()
        let queue = DispatchQueue(label: "flagship.lan-probe")
        sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, sniHost)
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trustRef, complete in
            let trust = sec_trust_copy_ref(trustRef).takeRetainedValue()
            guard SecTrustEvaluateWithError(trust, nil),
                  let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
            else { return complete(false) }
            let der = SecCertificateCopyData(leaf) as Data
            let hex = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
            complete(hex == certSha256)
        }, queue)
        let conn = NWConnection(host: NWEndpoint.Host(address), port: nwPort, using: NWParameters(tls: tls))
        let result = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            let once = ResumeOnce(cont)
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready: once.resume(true)
                case .failed, .waiting, .cancelled: once.resume(false)
                default: break
                }
            }
            conn.start(queue: queue)
            queue.asyncAfter(deadline: .now() + timeout) { once.resume(false) }
        }
        conn.cancel()
        return result
    }
}

private final class ResumeOnce: @unchecked Sendable {
    private var cont: CheckedContinuation<Bool, Never>?
    private let lock = NSLock()
    init(_ c: CheckedContinuation<Bool, Never>) { cont = c }
    func resume(_ v: Bool) {
        lock.lock()
        let c = cont
        cont = nil
        lock.unlock()
        c?.resume(returning: v)
    }
}
#endif

public final class LanDirectRegistry: @unchecked Sendable {
    #if canImport(Network)
    public static let shared = LanDirectRegistry(prober: TlsPinProber())
    #endif
    public static let probeTtlMs: Int64 = 5 * 60_000
    public static let refreshIntervalMs: Int64 = 10 * 60_000

    private struct Entry {
        let endpoints: [LanHint.Endpoint]
        let certSha256: String
        let expiresAt: Int64
    }

    private let prober: LanProber
    private let clock: @Sendable () -> Int64
    private let log: @Sendable (String) -> Void
    private let lock = NSLock()
    private var hints: [String: Entry] = [:]
    private var probes: [String: (ok: Bool, at: Int64)] = [:]
    private var probing: Set<String> = []
    private var probeTasks: [String: Task<Void, Never>] = [:]
    private var sessions: [String: URLSession] = [:]
    private var lastRefresh: [String: Int64] = [:]
    private var pinFor: (@Sendable (String) -> String?)?
    private var stkPubFor: (@Sendable (String) -> Data?)?
    private var activeBox: (@Sendable () async -> String?)?
    private var fetchHint: (@Sendable () async -> LanHint.Envelope?)?
    #if canImport(Network)
    private var monitor: NWPathMonitor?
    #endif

    /// Every critical section goes through this synchronous helper, so async
    /// methods never hold the lock across a suspension point.
    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    public init(
        prober: LanProber,
        clock: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        log: @escaping @Sendable (String) -> Void = LanDirectRegistry.systemLog
    ) {
        self.prober = prober
        self.clock = clock
        self.log = log
    }

    public static let systemLog: @Sendable (String) -> Void = { message in
        lanDirectLogger.info("\(message, privacy: .public)")
    }

    /// App-layer glue: where pins and box STKs come from, which box is active,
    /// and how to fetch its hint. Also starts watching for network changes.
    public func configure(
        pinFor: @escaping @Sendable (String) -> String?,
        stkPubFor: @escaping @Sendable (String) -> Data?,
        activeBox: @escaping @Sendable () async -> String?,
        fetchHint: @escaping @Sendable () async -> LanHint.Envelope?
    ) {
        lock.lock()
        self.pinFor = pinFor
        self.stkPubFor = stkPubFor
        self.activeBox = activeBox
        self.fetchHint = fetchHint
        lock.unlock()
        #if canImport(Network)
        guard monitor == nil else { return }
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] _ in self?.onNetworkChanged() }
        m.start(queue: DispatchQueue(label: "flagship.lan-path"))
        monitor = m
        #endif
    }

    /// Verify and keep a hint for `box`. Returns why it was refused, or nil.
    @discardableResult
    public func accept(box: String, envelope: LanHint.Envelope, stkPub: Data, pinnedCertSha256: String) -> String? {
        guard let sig = LanHint.hexDecode(envelope.signatureHex) else {
            forget(box: box)
            return "bad-signature"
        }
        let why = LanHint.reject(
            envelope.hint, signature: sig, stkPub: stkPub,
            serverDomain: box, certSha256: pinnedCertSha256, nowMs: clock()
        )
        if why == nil {
            lock.lock()
            hints[box.lowercased()] = Entry(
                endpoints: envelope.hint.endpoints,
                certSha256: envelope.hint.certSha256,
                expiresAt: envelope.hint.expiresAt
            )
            lock.unlock()
        } else {
            forget(box: box)
            log("refused \(box)'s LAN hint (\(why!)); staying on the relay")
        }
        return why
    }

    public func forget(box: String) {
        let b = box.lowercased()
        lock.lock()
        hints.removeValue(forKey: b)
        probes = probes.filter { !$0.key.hasPrefix("\(b)|") }
        lock.unlock()
    }

    /// Any network change voids every probe and allows a fresh hint fetch.
    public func onNetworkChanged() {
        lock.lock()
        probes.removeAll()
        lastRefresh.removeAll()
        lock.unlock()
    }

    /// Fetch, verify and store the active box's hint, at most once per
    /// `refreshIntervalMs`. Call after each /pods pin refresh.
    public func refreshActive() {
        Task { [self] in
            let (activeBox, pinFor, stkPubFor, fetchHint) = locked {
                (self.activeBox, self.pinFor, self.stkPubFor, self.fetchHint)
            }
            guard let activeBox, let pinFor, let stkPubFor, let fetchHint,
                  let box = await activeBox()?.lowercased(),
                  let pin = pinFor(box), let stk = stkPubFor(box) else { return }
            let now = clock()
            let due: Bool = locked {
                if let last = lastRefresh[box], now - last < Self.refreshIntervalMs { return false }
                lastRefresh[box] = now
                return true
            }
            guard due else { return }
            if let env = await fetchHint() {
                accept(box: box, envelope: env, stkPub: stk, pinnedCertSha256: pin)
            } else {
                forget(box: box)
            }
        }
    }

    /// The proven LAN endpoint for `host` (the box or a name under it), or nil.
    public func lanEndpoint(for host: String) async -> LanHint.Endpoint? {
        let h = host.lowercased()
        let match = locked { hints.first { h == $0.key || h.hasSuffix(".\($0.key)") } }
        guard let (box, entry) = match else { return nil }
        if entry.expiresAt <= clock() {
            forget(box: box)
            return nil
        }
        for e in entry.endpoints {
            let key = "\(box)|\(e.address):\(e.port)"
            let cached = locked { probes[key] }
            let ok: Bool
            if let cached, clock() - cached.at < Self.probeTtlMs {
                ok = cached.ok
            } else {
                ok = await prober.probe(sniHost: box, address: e.address, port: e.port, certSha256: entry.certSha256)
                let at = clock()
                locked { probes[key] = (ok, at) }
                log(ok ? "\(box) proved itself at \(e.address); using the local network"
                       : "\(box) isn't at \(e.address) on this network; using the relay")
            }
            if ok { return e }
        }
        return nil
    }

    /// The endpoint already proven for `host` on this network, without
    /// waiting. When a probe is due it starts in the background and this
    /// call returns nil, so the request it serves takes the relay.
    public func provenEndpoint(for host: String) -> LanHint.Endpoint? {
        let h = host.lowercased()
        let now = clock()
        let found: (box: String, proven: LanHint.Endpoint?, due: Bool)? = locked {
            guard let (box, entry) = hints.first(where: { h == $0.key || h.hasSuffix(".\($0.key)") }) else { return nil }
            if entry.expiresAt <= now {
                hints.removeValue(forKey: box)
                probes = probes.filter { !$0.key.hasPrefix("\(box)|") }
                return nil
            }
            var proven: LanHint.Endpoint?
            var due = false
            for e in entry.endpoints {
                if let p = probes["\(box)|\(e.address):\(e.port)"], now - p.at < Self.probeTtlMs {
                    if p.ok, proven == nil { proven = e }
                } else {
                    due = true
                }
            }
            let start = due && proven == nil && !probing.contains(box)
            if start { probing.insert(box) }
            return (box, proven, start)
        }
        guard let found else { return nil }
        if found.due {
            let box = found.box
            let task = Task.detached { [self] in
                _ = await self.lanEndpoint(for: box)
                self.locked { _ = self.probing.remove(box) }
            }
            locked { probeTasks[box] = task }
        }
        return found.proven
    }

    /// Waits for every background probe started so far (tests).
    public func settleProbes() async {
        for t in locked({ Array(probeTasks.values) }) { await t.value }
    }

    /// A session that reaches `host` through the box's LAN listener, or nil
    /// when the relay should be used. Never waits for a probe.
    public func session(for host: String) -> URLSession? {
        #if canImport(Network)
        guard let e = provenEndpoint(for: host),
              let port = NWEndpoint.Port(rawValue: UInt16(clamping: e.port)) else { return nil }
        return locked { () -> URLSession? in
            guard let pinFor else { return nil }
            let key = "\(e.address):\(e.port)"
            if let s = sessions[key] { return s }
            let cfg = URLSessionConfiguration.default
            cfg.proxyConfigurations = [
                ProxyConfiguration(httpCONNECTProxy: .hostPort(host: NWEndpoint.Host(e.address), port: port), tlsOptions: nil),
            ]
            let s = URLSession(configuration: cfg, delegate: BoxCertPinningDelegate(pinFor: pinFor), delegateQueue: nil)
            sessions[key] = s
            return s
        }
        #else
        return nil
        #endif
    }

    /// The LAN route just failed: stop using it on this network.
    public func markFailed(host: String, why: String = "error") {
        let h = host.lowercased()
        let now = clock()
        let any: Bool = locked {
            var any = false
            for key in probes.keys {
                let box = String(key.split(separator: "|").first ?? "")
                if h == box || h.hasSuffix(".\(box)") {
                    probes[key] = (false, now)
                    any = true
                }
            }
            return any
        }
        if any { log("the local route to \(host) failed (\(why)); using the relay on this network") }
    }

    /// True when `error` means the request cannot have reached the box, so
    /// replaying it over the relay can't duplicate a mutation.
    public static func failedBeforeDelivery(_ error: Error) -> Bool {
        if let u = error as? URLError {
            switch u.code {
            case .cannotConnectToHost, .cannotFindHost, .secureConnectionFailed,
                 .serverCertificateUntrusted, .serverCertificateHasBadDate,
                 .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot,
                 .clientCertificateRejected, .cancelled, .notConnectedToInternet:
                return true
            default:
                return false
            }
        }
        // The CONNECT to the box's listener was refused or answered wrongly
        // (kCFErrorHTTPProxyConnectionFailure, kCFErrorHTTPSProxyConnectionFailure,
        // kCFStreamErrorHTTPSProxyFailureUnexpectedResponseToCONNECTMethod).
        let ns = error as NSError
        return ns.domain == "kCFErrorDomainCFNetwork" && [306, 310, 311].contains(ns.code)
    }

    /// Whether a request that failed on the LAN route may go again over the
    /// relay: it never reached the box, or it only reads.
    public static func mayResendOverRelay(_ error: Error, method: String?) -> Bool {
        failedBeforeDelivery(error) || ["GET", "HEAD", "OPTIONS"].contains((method ?? "GET").uppercased())
    }
}

private let lanDirectLogger = Logger(subsystem: "com.flagshipserver.app", category: "lan-direct")
