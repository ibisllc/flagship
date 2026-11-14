import Foundation

/// Direct access on `.com` (docs/direct-access-and-domains.md §8):
///
///   GET  /api/accounts/:u/direct-access                 read token
///   POST /api/accounts/:u/direct-access                 the owner's signed direct-access order
///   POST /api/accounts/:u/direct-names                  the owner's signed direct-name order
///   POST /api/accounts/:u/direct-names/:label/probe     read token, the outside check
///
/// Mirrors the webapp's `lib/directNames.js` and Android's `DirectNamesClient.kt`.
public protocol DirectNamesClient: Sendable {
    func state(username: String) async throws -> DirectAccountState
    func postAccessOrder(username: String, signed: DirectAccess.SignedOrder) async throws
    func postNameOrder(username: String, signed: DirectName.SignedOrder) async throws
    func probe(username: String, label: String) async throws -> DirectProbe
}

/// `GET /api/accounts/:u/direct-access`.
public struct DirectAccountState: Decodable, Equatable, Sendable {
    public let apex: String
    public let servers: [DirectServerState]
    public let names: [DirectNameState]
    public init(apex: String = DirectName.apex, servers: [DirectServerState] = [], names: [DirectNameState] = []) {
        self.apex = apex; self.servers = servers; self.names = names
    }

    public func server(_ domain: String) -> DirectServerState? {
        servers.first { $0.serverDomain.lowercased() == domain.lowercased() }
    }

    public func name(_ fqdn: String) -> DirectNameState? {
        names.first { $0.name.lowercased() == fqdn.lowercased() }
    }
}

public struct DirectServerState: Decodable, Equatable, Sendable {
    public let serverDomain: String
    public let on: Bool
    public let addresses: [String]
    public let prefixes: [String]
    public let port: Int?
    public let issuedAt: Int64?
    public let boxAddresses: [String]?
    public let boxReportedAt: Int64?
    public init(serverDomain: String, on: Bool, addresses: [String] = [], prefixes: [String] = [], port: Int? = 443,
                issuedAt: Int64? = nil, boxAddresses: [String]? = nil, boxReportedAt: Int64? = nil) {
        self.serverDomain = serverDomain; self.on = on; self.addresses = addresses; self.prefixes = prefixes
        self.port = port; self.issuedAt = issuedAt; self.boxAddresses = boxAddresses; self.boxReportedAt = boxReportedAt
    }
}

/// One name with its zone state (`state`: published, pending or empty; `reason` says why it has no records).
public struct DirectNameState: Decodable, Equatable, Sendable, Identifiable {
    public let name: String
    public let serverDomain: String
    public let enabled: Bool
    public let caa: String
    public let addresses: [String]
    public let issuedAt: Int64?
    public let state: String
    public let reason: String?
    public let publishedAt: Int64?
    public let suspended: DirectSuspension?
    public let probe: DirectProbe?
    /// The box's certificate for the name: issued once the owner's order verifies, before the direct path is live.
    public let certificate: DirectNameCertificate?
    public var id: String { name }
    public var isPublished: Bool { state == "published" }

    public init(name: String, serverDomain: String, enabled: Bool, caa: String = "pin", addresses: [String] = [],
                issuedAt: Int64? = nil, state: String, reason: String? = nil, publishedAt: Int64? = nil,
                suspended: DirectSuspension? = nil, probe: DirectProbe? = nil, certificate: DirectNameCertificate? = nil) {
        self.name = name; self.serverDomain = serverDomain; self.enabled = enabled; self.caa = caa
        self.addresses = addresses; self.issuedAt = issuedAt; self.state = state; self.reason = reason
        self.publishedAt = publishedAt; self.suspended = suspended; self.probe = probe; self.certificate = certificate
    }
}

public struct DirectNameCertificate: Decodable, Equatable, Sendable {
    public let notAfter: Int64
    public init(notAfter: Int64) { self.notAfter = notAfter }
}

public struct DirectSuspension: Decodable, Equatable, Sendable {
    public let at: Int64?
    public let reason: String?
}

/// The outside check: `reachable` is nil when nothing was published to check (`why` is then `not-published`).
public struct DirectProbe: Decodable, Equatable, Sendable {
    public let at: Int64?
    public let reachable: Bool?
    public let why: String?
    public let https: DirectProbeHttps?
    public init(at: Int64?, reachable: Bool?, why: String? = nil, https: DirectProbeHttps? = nil) {
        self.at = at; self.reachable = reachable; self.why = why; self.https = https
    }
}

public struct DirectProbeHttps: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let status: Int?
}

/// A refusal from `.com` or the box: `code` picks the app's sentence (`DirectAccessText.refusal`).
public struct DirectAccessRefusal: Error, Equatable, LocalizedError {
    public let status: Int
    public let code: String?
    public let message: String?
    public var errorDescription: String? { DirectAccessText.refusal(code, fallback: message) }
    public init(status: Int, code: String?, message: String? = nil) {
        self.status = status; self.code = code; self.message = message
    }

    public init(status: Int, body: Data) {
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        self.init(status: status, code: json["code"] as? String, message: json["error"] as? String)
    }
}

/// The app's own sentence for every refusal, publish reason and probe answer (docs/direct-access-and-domains.md §8).
public enum DirectAccessText {
    public static func refusal(_ code: String?, fallback: String? = nil) -> String {
        switch code {
        case "malformed", "bad-time", "off-with-addresses", "bad-caa", "no-server":
            return String(localized: "That change couldn't be read. Try again.")
        case "private-address": return String(localized: "Only public addresses can be used. Private, local and reserved addresses can't.")
        case "bad-address", "non-canonical-address": return String(localized: "One of the addresses isn't an IP address.")
        case "bad-prefix": return String(localized: "One of the address ranges isn't valid.")
        case "prefix-too-wide": return String(localized: "An address range is too wide. Use an IPv6 /32 or longer, or an IPv4 /24 or longer.")
        case "no-addresses": return String(localized: "Add at least one public address or address range.")
        case "too-many": return String(localized: "Too many addresses: at most 8 addresses and 4 ranges.")
        case "duplicate": return String(localized: "An address is listed twice.")
        case "bad-port": return String(localized: "The port must be a number from 1 to 65535.")
        case "bad-name": return String(localized: "That name can't be used on fshp.app.")
        case "not-yet-valid", "stale": return String(localized: "This device's clock is off. Check the time and try again.")
        case "unknown-account": return String(localized: "This account wasn't found.")
        case "not-your-server", "wrong-server", "unknown-server": return String(localized: "That server isn't one of this account's servers.")
        case "not-admin": return String(localized: "Only an admin device of this account can change direct access.")
        case "replayed": return String(localized: "A newer change is already saved. Reload and try again.")
        case "vanity-not-available": return String(localized: "Chosen names on fshp.app aren't available yet.")
        case "not-your-name": return String(localized: "A direct name must end in this account's own name.")
        case "taken": return String(localized: "That name belongs to another account.")
        case "unknown-name": return String(localized: "This name isn't on this account.")
        case "probe-too-soon": return String(localized: "This name was checked a moment ago. Try again in a minute.")
        default:
            if let fallback, !fallback.isEmpty { return fallback }
            return String(localized: "Direct access couldn't be changed. Try again.")
        }
    }

    /// The line under a name: its state, and why it has no records.
    public static func state(_ n: DirectNameState) -> String {
        if n.suspended != nil { return String(localized: "Suspended after an abuse report.") }
        switch n.state {
        case "published": return String(localized: "Published")
        case "pending": return String(localized: "Waiting to be published")
        default:
            if n.certificate != nil, n.reason == "direct-access-off" || n.reason == "no-addresses" {
                return String(localized: "Certificate ready. Waiting for the direct path.")
            }
            return reason(n.reason) ?? String(localized: "Not published")
        }
    }

    public static func reason(_ code: String?) -> String? {
        switch code {
        case "off": return String(localized: "Turned off.")
        case "suspended": return String(localized: "Suspended after an abuse report.")
        case "account-gone": return String(localized: "The account is gone.")
        case "server-gone": return String(localized: "Its server is no longer on this account.")
        case "order-unverified": return String(localized: "Its order no longer checks out under this account's admin key. Turn it on again.")
        case "direct-access-off": return String(localized: "Direct access is off on its server.")
        case "no-addresses": return String(localized: "Its server hasn't reported a public address yet.")
        case "caa-account-unknown": return String(localized: "Waiting for the certificate account. It will be published soon.")
        default: return nil
        }
    }

    public static func probe(_ p: DirectProbe) -> String {
        switch p.reachable {
        case .some(true): return String(localized: "Reachable from outside.")
        case .some(false): return String(localized: "Not reachable from outside.")
        case .none: return String(localized: "Not published yet, so there is nothing to check.")
        }
    }
}

// MARK: - Live

public final class LiveDirectNamesClient: DirectNamesClient, @unchecked Sendable {
    private let urlSession: URLSession
    private let baseUrl: URL
    private let readTokens: (any AccountReadTokenSource)?

    public init(urlSession: URLSession = .shared, baseUrl: URL = Endpoints.controlBaseUrl, readTokens: (any AccountReadTokenSource)? = nil) {
        self.urlSession = urlSession
        self.baseUrl = baseUrl
        self.readTokens = readTokens
    }

    public func state(username: String) async throws -> DirectAccountState {
        try await read(request(path: "/api/accounts/\(Self.segment(username))/direct-access"), username: username)
    }

    public func postAccessOrder(username: String, signed: DirectAccess.SignedOrder) async throws {
        try await post(path: "/api/accounts/\(Self.segment(username))/direct-access", body: try JSONEncoder().encode(signed))
    }

    public func postNameOrder(username: String, signed: DirectName.SignedOrder) async throws {
        try await post(path: "/api/accounts/\(Self.segment(username))/direct-names", body: try JSONEncoder().encode(signed))
    }

    public func probe(username: String, label: String) async throws -> DirectProbe {
        var req = request(path: "/api/accounts/\(Self.segment(username))/direct-names/\(Self.segment(label))/probe")
        req.httpMethod = "POST"
        return try await read(req, username: username)
    }

    private func post(path: String, body: Data) async throws {
        var req = request(path: path)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await urlSession.gatedData(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw DirectAccessRefusal(status: status, body: data) }
    }

    private func read<Resp: Decodable>(_ req: URLRequest, username: String) async throws -> Resp {
        let (data, status) = try await sendAccountRead(req, username: username, tokens: readTokens) {
            try await self.urlSession.gatedData(for: $0)
        }
        guard (200..<300).contains(status) else { throw DirectAccessRefusal(status: status, body: data) }
        return try JSONDecoder().decode(Resp.self, from: data)
    }

    private func request(path: String) -> URLRequest {
        var req = URLRequest(url: URL(string: baseUrl.absoluteString + path) ?? baseUrl)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        return req
    }

    private static func segment(_ s: String) -> String {
        s.lowercased().addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }
}

// MARK: - Mock

#if DEBUG
/// Scriptable `.com` for previews, tests and the mock gym. It keeps what it is sent, like `.com` would.
public final class MockDirectNamesClient: DirectNamesClient, @unchecked Sendable {
    /// The one `.com` of a mock-gym run: every screen reads and writes the same state.
    public static let shared = MockDirectNamesClient()
    public var scripted = DirectAccountState()
    public var postError: DirectAccessRefusal?
    public var probeAnswer: DirectProbe?
    public private(set) var accessOrders: [DirectAccess.SignedOrder] = []
    public private(set) var nameOrders: [DirectName.SignedOrder] = []
    public private(set) var probes: [String] = []
    public var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    public init() {}

    public func state(username: String) async throws -> DirectAccountState { scripted }

    public func postAccessOrder(username: String, signed: DirectAccess.SignedOrder) async throws {
        if let postError { throw postError }
        accessOrders.append(signed)
        let o = signed.order
        var servers = scripted.servers.filter { $0.serverDomain.lowercased() != o.serverDomain.lowercased() }
        servers.append(DirectServerState(serverDomain: o.serverDomain, on: o.enabled, addresses: o.addresses, prefixes: o.prefixes,
                                         port: o.port, issuedAt: o.issuedAt))
        scripted = DirectAccountState(apex: scripted.apex, servers: servers, names: scripted.names.map { n in
            guard n.serverDomain.lowercased() == o.serverDomain.lowercased(), n.addresses.isEmpty else { return n }
            return Self.zone(n, accessOn: o.enabled)
        })
    }

    public func postNameOrder(username: String, signed: DirectName.SignedOrder) async throws {
        if let postError { throw postError }
        nameOrders.append(signed)
        let o = signed.order
        let accessOn = scripted.server(o.serverDomain)?.on ?? false
        let row = DirectNameState(name: o.name, serverDomain: o.serverDomain, enabled: o.enabled, caa: o.caa.rawValue,
                                  addresses: o.addresses, issuedAt: o.issuedAt, state: "empty")
        var names = scripted.names.filter { $0.name != o.name }
        names.append(Self.zone(row, accessOn: accessOn))
        scripted = DirectAccountState(apex: scripted.apex, servers: scripted.servers, names: names)
    }

    public func probe(username: String, label: String) async throws -> DirectProbe {
        probes.append(label)
        let fqdn = "\(label).\(scripted.apex)"
        guard let n = scripted.name(fqdn) else { throw DirectAccessRefusal(status: 404, code: "unknown-name") }
        let p = probeAnswer ?? (n.isPublished ? DirectProbe(at: now(), reachable: true, https: DirectProbeHttps(ok: true, status: 200))
                                               : DirectProbe(at: now(), reachable: nil, why: "not-published"))
        scripted = DirectAccountState(apex: scripted.apex, servers: scripted.servers, names: scripted.names.map {
            $0.name == fqdn ? DirectNameState(name: $0.name, serverDomain: $0.serverDomain, enabled: $0.enabled, caa: $0.caa,
                                              addresses: $0.addresses, issuedAt: $0.issuedAt, state: $0.state, reason: $0.reason,
                                              publishedAt: $0.publishedAt, suspended: $0.suspended, probe: p,
                                              certificate: $0.certificate) : $0
        })
        return p
    }

    private static func zone(_ n: DirectNameState, accessOn: Bool) -> DirectNameState {
        let (state, reason): (String, String?) = !n.enabled ? ("empty", "off")
            : (!n.addresses.isEmpty || accessOn) ? ("published", nil) : ("empty", "direct-access-off")
        return DirectNameState(name: n.name, serverDomain: n.serverDomain, enabled: n.enabled, caa: n.caa, addresses: n.addresses,
                               issuedAt: n.issuedAt, state: state, reason: reason, publishedAt: state == "published" ? n.issuedAt : nil,
                               suspended: n.suspended, probe: n.probe, certificate: n.certificate)
    }
}
#endif
