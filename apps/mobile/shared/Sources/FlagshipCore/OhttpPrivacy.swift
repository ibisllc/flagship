import Foundation
import FlagshipAPI

/// One relay the apps may use, in the order `.com` lists them.
public struct OhttpRelayEntry: Equatable, Sendable, Codable {
    public var url: String
    /// Who runs it, shown to the owner.
    public var `operator`: String
    /// Run by Flagship until a third-party contract exists.
    public var interim: Bool
    public init(url: String, operator: String, interim: Bool) { self.url = url; self.operator = `operator`; self.interim = interim }
}

/// `GET /api/ohttp/config` (also `ohttp` in `GET /api/payments/config`).
public struct OhttpPublicConfig: Equatable, Sendable, Codable {
    public var v: Int = 1
    public var keyConfigHex: String?
    public var relays: [OhttpRelayEntry]
    public init(keyConfigHex: String?, relays: [OhttpRelayEntry]) { self.keyConfigHex = keyConfigHex; self.relays = relays }
    public static let empty = OhttpPublicConfig(keyConfigHex: nil, relays: [])

    public var keyConfig: Ohttp.KeyConfig? { keyConfigHex.flatMap(Ohttp.keyConfig(hex:)) }
}

/// What a private request is for; decides whether a relay outage may send it directly.
public enum PrivateSpendKind: String, Sendable {
    case interactive, trickle, overage
}

/// Where private requests go, and what happens when our relay fails. Swift twin of
/// packages/protocol/src/ohttpPrivacy.ts; test-vectors/ohttp/spend-route.json pins every rule.
/// Owner rule: a relay outage never breaks a payment or lapses a plan.
public enum OhttpPrivacy {
    public static let directBeforeLapseMs: Int64 = 24 * 3_600_000
    /// Header a direct fallback carries, so `.com` can count relay failures.
    public static let fallbackHeader = "x-flagship-relay-fallback"

    public static func isForbiddenRelayHost(_ host: String, controlApex: String) -> Bool {
        var h = host.lowercased()
        if h.hasSuffix(".") { h.removeLast() }
        let apex = controlApex.lowercased()
        func under(_ d: String) -> Bool { h == d || h.hasSuffix(".\(d)") }
        return under(apex) || under("cloudflare.com") || under("cloudflare.net") || under("workers.dev") || under("pages.dev")
            || under("cloudflare-gateway.com") || under("cloudflareclient.com")
    }

    static func relayEntry(_ v: JSONValue, controlApex: String?) -> OhttpRelayEntry? {
        guard let url = v["url"]?.string, let op = v["operator"]?.string, case .bool(let interim)? = v["interim"] else { return nil }
        guard let c = URLComponents(string: url), c.scheme?.lowercased() == "https", let host = c.host, !host.isEmpty,
              c.user == nil, c.password == nil, c.fragment == nil else { return nil }
        if let apex = controlApex, isForbiddenRelayHost(host, controlApex: apex) { return nil }
        let operatorName = op.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !operatorName.isEmpty, operatorName.count <= 80 else { return nil }
        return OhttpRelayEntry(url: url, operator: operatorName, interim: interim)
    }

    /// Parse `.com`'s config: bad relays are dropped one by one (at most 4 kept); a missing or bad key means no relay.
    public static func parseConfig(_ v: JSONValue?, controlApex: String?) -> OhttpPublicConfig {
        guard let o = v?.object, let hex = o["keyConfigHex"]?.string, !hex.isEmpty, hex.count % 2 == 0,
              hex.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }), Ohttp.keyConfig(hex: hex) != nil else { return .empty }
        let relays = (o["relays"]?.array ?? []).compactMap { relayEntry($0, controlApex: controlApex) }
        return OhttpPublicConfig(keyConfigHex: hex, relays: Array(relays.prefix(4)))
    }

    /// After every relay failed: may this spend go directly to `.com`, marked? `lapseInMs` is nil when no plan is paid.
    public static func spendMayGoDirect(_ kind: PrivateSpendKind, lapseInMs: Int64?) -> Bool {
        switch kind {
        case .interactive: return true
        case .overage: return false
        case .trickle: return lapseInMs.map { $0 < directBeforeLapseMs } ?? true
        }
    }

    /// Wait before trying the relay again after `failures` failed rounds (5 min doubling, at most 6 h).
    public static func relayRetryAfterMs(_ failures: Int) -> Int64 {
        guard failures > 0 else { return 0 }
        let base: Int64 = 5 * 60_000
        let cap: Int64 = 6 * 3_600_000
        let shift = min(20, failures - 1)
        return min(cap, base * (Int64(1) << Int64(shift)))
    }

    /// `lapseInMs` from a plan's paid-until (0 = none) and the grace.
    public static func planLapseInMs(paidUntil: Int64, graceMs: Int64, now: Int64) -> Int64? {
        paidUntil > 0 ? paidUntil + graceMs - now : nil
    }
}

// MARK: - Sending through the relays

/// How a private request travelled.
public enum PrivatePath: Equatable, Sendable {
    case relay(url: String)
    case direct(reason: String)
}

public struct PrivateResponse: Sendable {
    public var status: Int
    public var headers: [(String, String)]
    public var body: [UInt8]
    public var path: PrivatePath
}

/// Every relay failed and the caller didn't allow a direct request.
public struct RelayUnavailableError: Error, Equatable, Sendable {
    public let reason: String
    public init(reason: String) { self.reason = reason }
}

/// One HTTP round trip: the live app passes URLSession, tests a fake. Returns the status, the content type and the body.
public typealias PrivateTransport = @Sendable (URLRequest) async throws -> (status: Int, contentType: String?, body: [UInt8])

public enum OhttpClient {
    /// Send `request` through the first relay that answers with an OHTTP response (the inner answer is final, whatever
    /// its status), else directly with `x-flagship-relay-fallback: <reason>` when `mayGoDirect(reason)` allows, else
    /// throw `RelayUnavailableError`. With no relay set up (`unconfigured`) it always goes directly, without the
    /// header. Twin of `sendThroughRelays` in ohttpClient.ts. `skipRelaysReason`: the relays
    /// failed recently and are resting; don't try them, decide on the direct path with that reason.
    public static func send(
        url: URL, method: String = "POST", headers: [(String, String)] = [], body: [UInt8] = [],
        config: OhttpPublicConfig, timeout: TimeInterval = 15,
        mayGoDirect: (String) -> Bool, transport: PrivateTransport,
        skipRelaysReason: String? = nil, ephemeralPrivateKey: [UInt8]? = nil
    ) async throws -> PrivateResponse {
        var reason = skipRelaysReason ?? "unconfigured"
        if skipRelaysReason == nil, let key = config.keyConfig, !config.relays.isEmpty {
            let path = url.path.isEmpty ? "/" : url.path
            let query = url.query.map { "?\($0)" } ?? ""
            let authority = url.port.map { "\(url.host ?? ""):\($0)" } ?? (url.host ?? "")
            let inner = try Bhttp.encode(BhttpRequest(method: method.uppercased(), scheme: "https", authority: authority,
                                                       path: path + query, headers: headers, body: body))
            for relay in config.relays {
                guard let relayUrl = URL(string: relay.url) else { reason = "relay-unreachable"; continue }
                let (encapsulated, context) = try Ohttp.encapsulateRequest(key, inner, ephemeralPrivateKey: ephemeralPrivateKey)
                var r = URLRequest(url: relayUrl, timeoutInterval: timeout)
                r.httpMethod = "POST"
                r.httpShouldHandleCookies = false
                r.cachePolicy = .reloadIgnoringLocalCacheData
                r.setValue(Ohttp.requestMediaType, forHTTPHeaderField: "content-type")
                r.httpBody = Data(encapsulated)
                let answer: (status: Int, contentType: String?, body: [UInt8])
                do {
                    answer = try await transport(r)
                } catch let e as URLError where e.code == .timedOut {
                    reason = "relay-timeout"; continue
                } catch {
                    reason = "relay-unreachable"; continue
                }
                guard answer.status == 200 else { reason = "relay-\(answer.status)"; continue }
                let type = (answer.contentType ?? "").split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
                guard type == Ohttp.responseMediaType else { reason = "relay-bad-response"; continue }
                guard let plain = try? Ohttp.decapsulateResponse(context, answer.body), let res = try? Bhttp.decodeResponse(plain) else {
                    reason = "relay-bad-response"; continue
                }
                return PrivateResponse(status: res.status, headers: res.headers, body: res.body, path: .relay(url: relay.url))
            }
        }
        // No relay set up: always direct, and unmarked (`.com` counts the header as a relay failure).
        let unconfigured = reason == "unconfigured"
        guard unconfigured || mayGoDirect(reason) else { throw RelayUnavailableError(reason: reason) }
        var r = URLRequest(url: url, timeoutInterval: timeout)
        r.httpMethod = method.uppercased()
        r.httpShouldHandleCookies = false
        r.cachePolicy = .reloadIgnoringLocalCacheData
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        if !unconfigured { r.setValue(reason, forHTTPHeaderField: OhttpPrivacy.fallbackHeader) }
        if method.uppercased() != "GET" && method.uppercased() != "HEAD" { r.httpBody = Data(body) }
        let answer = try await transport(r)
        var out: [(String, String)] = []
        if let t = answer.contentType { out.append(("content-type", t)) }
        return PrivateResponse(status: answer.status, headers: out, body: answer.body, path: .direct(reason: reason))
    }
}
