import Foundation

/// The phone endpoint's voi.ci operations (docs/voici-and-messages.md §8.2): which website origins may reach
/// `POST /api/phone/deliver` and `GET /api/phone/live` cross-origin, the preflight answer, and the live answer's shape.
/// Swift twin of the `phoneWebCheck` / `parsePhoneLiveAnswer` / `PHONE_WEB_ORIGINS*` section at the end of
/// packages/protocol/src/phoneRoute.ts, pinned by packages/protocol/test-vectors/messages/vectors.json (`phoneWeb`).
/// No cookie is read or set; Access-Control-Allow-Credentials is never sent.
///
/// Public API: VoiciPhoneWeb namespace: origins, originsGym, deliverPath, livePath, envelopeContentType,
/// deliverMaxBytes, deliverMaxConcurrent, deliverPerSenderPerMinute, deliverPerMinute, Request, Verdict (+ json),
/// LiveAnswer, phoneWebCheck, parsePhoneLiveAnswer.
public enum VoiciPhoneWeb {
    public static let origins = ["https://voi.ci"]
    public static let originsGym = ["https://gym.voi.ci"]
    public static let deliverPath = "/api/phone/deliver"
    public static let livePath = "/api/phone/live"
    public static let envelopeContentType = "application/flagship-envelope+json"
    public static let deliverMaxBytes = 64 * 1024
    public static let deliverMaxConcurrent = 8
    public static let deliverPerSenderPerMinute = 20
    public static let deliverPerMinute = 120

    public struct Request: Equatable, Sendable {
        public var method: String
        /// Path without the query string.
        public var path: String
        public var host: String
        public var origin: String?
        public var contentType: String?
        /// Access-Control-Request-Method / -Headers on a preflight, else nil.
        public var acrMethod: String?
        public var acrHeaders: String?
        public init(method: String, path: String, host: String, origin: String? = nil, contentType: String? = nil,
                    acrMethod: String? = nil, acrHeaders: String? = nil) {
            self.method = method; self.path = path; self.host = host; self.origin = origin; self.contentType = contentType
            self.acrMethod = acrMethod; self.acrHeaders = acrHeaders
        }
    }

    public enum Verdict: Equatable, Sendable {
        case preflight(headers: [String: String])
        case live(corsHeaders: [String: String])
        case deliver(corsHeaders: [String: String])
        /// status 403 | 405 | 415 | 421; code wrong-host | origin | preflight | method | content-type.
        case refuse(status: Int, code: String)
        /// No Origin and not one of the two operations: the endpoint's other (native / same-origin) rules apply.
        case other

        /// The TS verdict object.
        public var json: JSONValue {
            func h(_ d: [String: String]) -> JSONValue { .object(d.mapValues { .string($0) }) }
            switch self {
            case .preflight(let headers): return ["kind": "preflight", "status": 204, "headers": h(headers)]
            case .live(let c): return ["kind": "live", "corsHeaders": h(c)]
            case .deliver(let c): return ["kind": "deliver", "corsHeaders": h(c)]
            case .refuse(let status, let code): return ["kind": "refuse", "status": .number(Double(status)), "code": .string(code)]
            case .other: return ["kind": "other"]
            }
        }
    }

    static func cors(_ origin: String?) -> [String: String] {
        origin.map { ["Access-Control-Allow-Origin": $0, "Vary": "Origin"] } ?? [:]
    }

    /// Host exactly the phone's name (421); an Origin, when present, in `origins` (403); the deliver preflight only
    /// for POST with exactly the content-type header (204); GET live; POST deliver only with Content-Type exactly
    /// application/flagship-envelope+json (415). Anything else with an Origin is 403.
    public static func phoneWebCheck(_ r: Request, hostname: String, origins: [String]) -> Verdict {
        if r.host.lowercased() != hostname.lowercased() { return .refuse(status: 421, code: "wrong-host") }
        let method = r.method.uppercased()
        let listed = r.origin.map { o in origins.contains { CanonicalJson.same($0, o) } } ?? false
        if r.origin != nil && !listed { return .refuse(status: 403, code: "origin") }
        let known = r.path == deliverPath || r.path == livePath
        if method == "OPTIONS" {
            if r.path != deliverPath || !listed { return .refuse(status: 403, code: "preflight") }
            let hdrs = (r.acrHeaders ?? "").split(separator: ",", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty }
            if r.acrMethod?.uppercased() != "POST" || hdrs != ["content-type"] { return .refuse(status: 403, code: "preflight") }
            return .preflight(headers: ["Access-Control-Allow-Origin": r.origin!, "Access-Control-Allow-Methods": "POST",
                                        "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "600", "Vary": "Origin"])
        }
        if !known { return r.origin != nil ? .refuse(status: 403, code: "origin") : .other }
        if r.path == livePath { return method == "GET" ? .live(corsHeaders: cors(r.origin)) : .refuse(status: 405, code: "method") }
        if method != "POST" { return .refuse(status: 405, code: "method") }
        if r.contentType != envelopeContentType { return .refuse(status: 415, code: "content-type") }
        return .deliver(corsHeaders: cors(r.origin))
    }

    /// `GET /api/phone/live` answer: {live:true, account, ownerSignPub}.
    public struct LiveAnswer: Equatable, Sendable {
        public var account: String
        public var ownerSignPub: String
    }

    /// `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`
    static func isAccount(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard (1...63).contains(u.count) else { return false }
        func an(_ c: UInt8) -> Bool { (0x61...0x7a).contains(c) || (0x30...0x39).contains(c) }
        return an(u[0]) && an(u[u.count - 1]) && u.allSatisfy { an($0) || $0 == 0x2d }
    }

    public static func parsePhoneLiveAnswer(_ v: JSONValue?) -> LiveAnswer? {
        guard let r = v?.object, Set(r.keys) == ["account", "live", "ownerSignPub"], r["live"] == .bool(true),
              let account = r["account"]?.string, isAccount(account), let pub = r["ownerSignPub"]?.string,
              CanonicalJson.isLowerHex(pub, bytes: 32) else { return nil }
        return LiveAnswer(account: account, ownerSignPub: pub)
    }
}
