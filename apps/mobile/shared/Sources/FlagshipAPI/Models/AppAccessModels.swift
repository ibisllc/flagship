import Foundation
import CryptoKit

// A live app's access list: which internet hosts it may reach, one
// `allow` / `deny` rule per line, first match wins, default deny.
//
// MIRRORS: docs/ai-privacy-and-staging.md §3a
//          packages/protocol/test-vectors/app-access/vectors.json (every case
//          runs in AppAccessVectorTests)

public enum AppAccessAction: String, Codable, Equatable, Sendable {
    case allow
    case deny
}

/// One parsed rule. `target` is `all`, a lowercase host, or `*.` + a host.
public struct AppAccessRule: Codable, Equatable, Sendable {
    public let line: Int
    public let action: AppAccessAction
    public let target: String
    public init(line: Int, action: AppAccessAction, target: String) {
        self.line = line
        self.action = action
        self.target = target
    }

    public func matches(_ host: String) -> Bool {
        if target == "all" { return true }
        if target.hasPrefix("*.") {
            let base = String(target.dropFirst(2))
            return host.hasSuffix("." + base)
        }
        return host == target
    }
}

/// A line the parser refused, with what to write instead.
public struct AppAccessLineError: Codable, Equatable, Sendable {
    public let line: Int
    public let message: String
    public init(line: Int, message: String) {
        self.line = line
        self.message = message
    }
}

public struct AppAccessParse: Equatable, Sendable {
    public let rules: [AppAccessRule]
    public let errors: [AppAccessLineError]
    public var isValid: Bool { errors.isEmpty }
}

/// What the list decides for one host: the action, and the rule that decided
/// it (nil: no rule matched, so the default deny applies). `rule` is its
/// 1-based position among the parsed rules, `line` its line in the text.
public struct AppAccessDecision: Equatable, Sendable {
    public let result: AppAccessAction
    public let rule: Int?
    public let line: Int?
}

public enum AppAccessList {
    /// A new app's list: denies everything and shows how to open it up.
    /// Allow / Deny add rules above it, so these lines stay last.
    public static let defaultList = "# Uncomment the following line to allow all hosts\n#allow all\n"
    public static let maxRules = 200
    public static let tooManyRulesMessage = "an access list can have at most \(maxRules) rules"

    /// `\r\n` and `\r` become `\n`, trailing spaces go, trailing blank lines
    /// go, and a non-empty list ends in one `\n`. This text is what gets
    /// hashed and signed.
    public static func normalize(_ text: String) -> String {
        var lines = splitLines(text).map(stripTrailingSpaces)
        while let last = lines.last, last.isEmpty { lines.removeLast() }
        return lines.isEmpty ? "" : lines.joined(separator: "\n") + "\n"
    }

    public static func isNormalized(_ text: String) -> Bool { normalize(text) == text }

    /// Every rule, or every line's error (all of them, so the editor can mark
    /// each one).
    public static func parse(_ text: String) -> AppAccessParse {
        var rules: [AppAccessRule] = []
        var errors: [AppAccessLineError] = []
        for (i, line) in splitLines(normalize(text)).enumerated() {
            switch parseLine(line, number: i + 1) {
            case .none: continue
            case .rule(let r):
                rules.append(r)
                if rules.count == maxRules + 1 {
                    errors.append(AppAccessLineError(line: r.line, message: tooManyRulesMessage))
                }
            case .error(let e): errors.append(e)
            }
        }
        return AppAccessParse(rules: rules, errors: errors)
    }

    /// First matching rule decides; no match is deny.
    public static func decide(_ text: String, host: String) -> AppAccessDecision {
        let h = normalizeHost(host)
        for (i, rule) in parse(text).rules.enumerated() where rule.matches(h) {
            return AppAccessDecision(result: rule.action, rule: i + 1, line: rule.line)
        }
        return AppAccessDecision(result: .deny, rule: nil, line: nil)
    }

    /// The owner's answer for one host: drop any rule for exactly that host,
    /// then put the new rule on top so it decides. Comments and other rules
    /// stay where they were.
    public static func withRule(_ text: String, action: AppAccessAction, host: String) -> String {
        let h = normalizeHost(host)
        let kept = splitLines(normalize(text)).enumerated().filter { i, line in
            if case .rule(let r) = parseLine(line, number: i + 1), r.target == h { return false }
            return true
        }.map(\.element)
        return normalize((["\(action.rawValue) \(h)"] + kept).joined(separator: "\n"))
    }

    /// Lowercase hex SHA-256 of the normalized list's UTF-8 bytes.
    public static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(normalize(text).utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public static func normalizeHost(_ host: String) -> String {
        var h = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if h.hasSuffix(".") { h.removeLast() }
        return h
    }

    // MARK: - Lines

    private enum LineResult {
        case none
        case rule(AppAccessRule)
        case error(AppAccessLineError)
    }

    private static func parseLine(_ raw: String, number: Int) -> LineResult {
        var body = raw
        if let hash = body.firstIndex(of: "#") { body = String(body[..<hash]) }
        let tokens = body.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        guard let first = tokens.first else { return .none }
        func fail(_ m: String) -> LineResult { .error(AppAccessLineError(line: number, message: m)) }
        guard let action = AppAccessAction(rawValue: first.lowercased()) else {
            return fail("start the line with \"allow\" or \"deny\"")
        }
        guard tokens.count >= 2 else { return fail("say what to allow or deny, e.g. \"allow example.com\"") }
        guard tokens.count == 2 else { return fail("one host per line") }
        var target = tokens[1].lowercased()
        if target.contains("://") { return fail("write the host only, without http:// or https://") }
        if target.contains("/") { return fail("write the host only, without a path") }
        if isIPv6Literal(target) { return fail("IP addresses can't be allowed or denied; use a host name") }
        if target.contains(":") { return fail("write the host only, without a port") }
        if target.hasSuffix("."), target.count > 1 { target.removeLast() }
        if target == "all" { return .rule(AppAccessRule(line: number, action: action, target: "all")) }
        if target == "*" { return fail("write \"all\" instead of \"*\"") }
        var host = target
        if target.contains("*") {
            guard target.hasPrefix("*."), !target.dropFirst(2).contains("*") else {
                return fail("a * may only start a host, as in *.example.com")
            }
            host = String(target.dropFirst(2))
        }
        if !host.isEmpty, host.allSatisfy({ $0 == "." || ("0"..."9").contains($0) }) {
            return fail("IP addresses can't be allowed or denied; use a host name")
        }
        if host == "localhost" || host.hasSuffix(".localhost") {
            return fail("\"localhost\" is not a public host name")
        }
        guard isValidHostName(host) else { return fail("\"\(target)\" is not a valid host name") }
        return .rule(AppAccessRule(line: number, action: action, target: target))
    }

    /// `2001:db8::1`, `[2001:db8::1]` (and `::ffff:1.2.3.4`): two or more
    /// colons among hex digits and dots, or anything in brackets.
    private static func isIPv6Literal(_ t: String) -> Bool {
        if t.hasPrefix("[") { return true }
        guard t.filter({ $0 == ":" }).count >= 2 else { return false }
        return t.allSatisfy { $0 == ":" || $0 == "." || $0.isHexDigit }
    }

    private static func isValidHostName(_ host: String) -> Bool {
        guard !host.isEmpty, host.utf8.count <= 253 else { return false }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        return labels.allSatisfy { label in
            guard (1...63).contains(label.utf8.count), label.first != "-", label.last != "-" else { return false }
            return label.unicodeScalars.allSatisfy { s in
                ("a"..."z").contains(s) || ("0"..."9").contains(s) || s == "-"
            }
        }
    }

    /// Split on `\n`, `\r\n` and `\r` by unicode scalar (a Swift `Character`
    /// treats `\r\n` as one).
    private static func splitLines(_ text: String) -> [String] {
        var lines: [String] = []
        var current = String.UnicodeScalarView()
        var it = text.unicodeScalars.makeIterator()
        var pending = it.next()
        while let s = pending {
            pending = it.next()
            if s == "\r" {
                lines.append(String(current)); current = .init()
                if pending == "\n" { pending = it.next() }
            } else if s == "\n" {
                lines.append(String(current)); current = .init()
            } else {
                current.append(s)
            }
        }
        lines.append(String(current))
        return lines
    }

    private static func stripTrailingSpaces(_ line: String) -> String {
        var scalars = Array(line.unicodeScalars)
        while let last = scalars.last, last == " " || last == "\t" { scalars.removeLast() }
        var v = String.UnicodeScalarView()
        v.append(contentsOf: scalars)
        return String(v)
    }
}

// MARK: - The owner's signed order

/// `flagship/app-access/v1|<serverDomain>|<serviceId>|<listSha256>|<issuedAt>`,
/// signed by the sensitive-order key and sent with the list text.
public struct AppAccessGrant: Codable, Equatable, Sendable {
    public static let canonicalTag = "flagship/app-access/v1"

    public let serverDomain: String
    public let serviceId: String
    public let listSha256: String
    public let issuedAt: Int64

    public init(serverDomain: String, serviceId: String, listSha256: String, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.serviceId = serviceId
        self.listSha256 = listSha256
        self.issuedAt = issuedAt
    }

    /// The grant for `list` (hashed after normalizing).
    public init(serverDomain: String, serviceId: String, list: String, issuedAt: Int64) {
        self.init(serverDomain: serverDomain, serviceId: serviceId,
                  listSha256: AppAccessList.sha256Hex(list), issuedAt: issuedAt)
    }

    public func canonicalBytes() -> Data {
        Data([Self.canonicalTag, serverDomain, serviceId, listSha256, String(issuedAt)]
            .joined(separator: "|").utf8)
    }
}

/// `POST /api/screens/services/:id/access` body. `list` is normalized.
public struct AppAccessSetRequest: Codable, Equatable, Sendable {
    public let list: String
    public let grant: AppAccessGrant
    /// Ed25519 over `grant.canonicalBytes()`, 128 lowercase hex.
    public let signature: String
    public init(list: String, grant: AppAccessGrant, signature: String) {
        self.list = list
        self.grant = grant
        self.signature = signature
    }
}

/// A host the gateway denied because no rule matched ("attempt"), or one the
/// manifest declared at install ("app").
public struct AppAccessPendingHost: Codable, Equatable, Sendable, Identifiable {
    public let host: String
    public let source: String
    public let attempts: Int
    public let firstSeen: Int64
    public let lastSeen: Int64
    public var id: String { host }

    public init(host: String, source: String, attempts: Int = 0, firstSeen: Int64 = 0, lastSeen: Int64 = 0) {
        self.host = host
        self.source = source
        self.attempts = attempts
        self.firstSeen = firstSeen
        self.lastSeen = lastSeen
    }

    private enum CodingKeys: String, CodingKey { case host, source, attempts, firstSeen, lastSeen }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        host = try c.decode(String.self, forKey: .host)
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "attempt"
        attempts = try c.decodeIfPresent(Int.self, forKey: .attempts) ?? 0
        firstSeen = try c.decodeIfPresent(Int64.self, forKey: .firstSeen) ?? 0
        lastSeen = try c.decodeIfPresent(Int64.self, forKey: .lastSeen) ?? 0
    }
}

/// A host the app's manifest suggests, with its short reason (`why`, at most
/// 120 characters) when it gave one.
public struct AppAccessDraftHost: Codable, Equatable, Sendable, Identifiable {
    public let host: String
    public let why: String?
    public var id: String { host }

    public init(host: String, why: String? = nil) {
        self.host = host
        self.why = why
    }

    private enum CodingKeys: String, CodingKey { case host, why }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        host = try c.decode(String.self, forKey: .host)
        let w = try c.decodeIfPresent(String.self, forKey: .why)?.trimmingCharacters(in: .whitespacesAndNewlines)
        why = (w?.isEmpty ?? true) ? nil : w
    }
}

/// A suggested list waiting for the owner's review: the current list with an
/// `allow <host>   # <why>` line on top for each new host. It opens nothing
/// until the owner signs it (the normal `POST …/access`).
public struct AppAccessDraft: Codable, Equatable, Sendable {
    public let list: String
    public let listSha256: String?
    public let hosts: [AppAccessDraftHost]
    public let createdAt: Int64

    public init(list: String, listSha256: String? = nil, hosts: [AppAccessDraftHost], createdAt: Int64 = 0) {
        self.list = list
        self.listSha256 = listSha256
        self.hosts = hosts
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey { case list, listSha256, hosts, createdAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        list = try c.decode(String.self, forKey: .list)
        listSha256 = try c.decodeIfPresent(String.self, forKey: .listSha256)
        hosts = try c.decodeIfPresent([AppAccessDraftHost].self, forKey: .hosts) ?? []
        createdAt = try c.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
    }
}

/// `GET /api/screens/services/:id/access` (and `access` in the POST answer).
public struct AppAccessState: Codable, Equatable, Sendable {
    public let list: String
    public let listSha256: String?
    public let pending: [AppAccessPendingHost]
    /// A suggested list waiting for review; nil when none (or an older box).
    public let draft: AppAccessDraft?

    public init(list: String, listSha256: String? = nil, pending: [AppAccessPendingHost] = [],
                draft: AppAccessDraft? = nil) {
        self.list = list
        self.listSha256 = listSha256
        self.pending = pending
        self.draft = draft
    }

    private enum CodingKeys: String, CodingKey { case list, listSha256, pending, draft }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        list = try c.decodeIfPresent(String.self, forKey: .list) ?? ""
        listSha256 = try c.decodeIfPresent(String.self, forKey: .listSha256)
        pending = try c.decodeIfPresent([AppAccessPendingHost].self, forKey: .pending) ?? []
        draft = try? c.decodeIfPresent(AppAccessDraft.self, forKey: .draft)
    }

    public var ruleCount: Int { AppAccessList.parse(list).rules.count }
}

public struct AppAccessSetResponse: Codable, Equatable, Sendable {
    public let ok: Bool?
    public let access: AppAccessState?
    public init(ok: Bool? = true, access: AppAccessState?) {
        self.ok = ok
        self.access = access
    }
}

/// `access` on an apps-list entry / app-detail `.app`: how many rules the
/// list has and how many hosts wait for an answer. Absent on older boxes.
public struct AppAccessSummary: Codable, Equatable, Sendable {
    public let rules: Int
    public let pending: Int
    /// A suggested list waits for review (the box sends `draft: true`).
    public let draft: Bool

    public init(rules: Int, pending: Int, draft: Bool = false) {
        self.rules = rules
        self.pending = pending
        self.draft = draft
    }

    private enum CodingKeys: String, CodingKey { case rules, pending, draft }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rules = Self.count(c, .rules)
        pending = Self.count(c, .pending)
        draft = (try? c.decodeIfPresent(Bool.self, forKey: .draft)) == true
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(rules, forKey: .rules)
        try c.encode(pending, forKey: .pending)
        if draft { try c.encode(true, forKey: .draft) }
    }

    /// A count, or the length of a list of them.
    private static func count(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Int {
        if let n = try? c.decode(Int.self, forKey: key) { return n }
        if let list = try? c.decode([AnyCodable].self, forKey: key) { return list.count }
        return 0
    }

    public var hasPending: Bool { pending > 0 }
}

/// One entry of `GET /api/screens/access-requests`.
public struct AppAccessRequest: Codable, Equatable, Sendable {
    public let serviceId: String
    public let appName: String
    public let host: String
    public let source: String
    public let attempts: Int
    public let firstSeen: Int64
    public let lastSeen: Int64

    public init(serviceId: String, appName: String, host: String, source: String,
                attempts: Int = 0, firstSeen: Int64 = 0, lastSeen: Int64 = 0) {
        self.serviceId = serviceId
        self.appName = appName
        self.host = host
        self.source = source
        self.attempts = attempts
        self.firstSeen = firstSeen
        self.lastSeen = lastSeen
    }

    private enum CodingKeys: String, CodingKey { case serviceId, appName, host, source, attempts, firstSeen, lastSeen }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serviceId = try c.decode(String.self, forKey: .serviceId)
        host = try c.decode(String.self, forKey: .host)
        appName = try c.decodeIfPresent(String.self, forKey: .appName) ?? serviceId
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "attempt"
        attempts = try c.decodeIfPresent(Int.self, forKey: .attempts) ?? 0
        firstSeen = try c.decodeIfPresent(Int64.self, forKey: .firstSeen) ?? 0
        lastSeen = try c.decodeIfPresent(Int64.self, forKey: .lastSeen) ?? 0
    }
}

/// A suggested list in `GET /api/screens/access-requests`
/// (`{kind:"draft", serviceId, appName, hosts, createdAt}`).
public struct AppAccessDraftEntry: Codable, Equatable, Sendable {
    public static let kind = "draft"
    public let serviceId: String
    public let appName: String
    public let hosts: [AppAccessDraftHost]
    public let createdAt: Int64

    public init(serviceId: String, appName: String, hosts: [AppAccessDraftHost], createdAt: Int64 = 0) {
        self.serviceId = serviceId
        self.appName = appName
        self.hosts = hosts
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey { case kind, serviceId, appName, hosts, createdAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard try c.decodeIfPresent(String.self, forKey: .kind) == Self.kind else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "not a draft")
        }
        serviceId = try c.decode(String.self, forKey: .serviceId)
        appName = try c.decodeIfPresent(String.self, forKey: .appName) ?? serviceId
        hosts = try c.decodeIfPresent([AppAccessDraftHost].self, forKey: .hosts) ?? []
        createdAt = try c.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.kind, forKey: .kind)
        try c.encode(serviceId, forKey: .serviceId)
        try c.encode(appName, forKey: .appName)
        try c.encode(hosts, forKey: .hosts)
        try c.encode(createdAt, forKey: .createdAt)
    }
}

/// `GET /api/screens/access-requests`: suggested lists (drafts) and single
/// waiting hosts, in one array on the wire (drafts first). An entry of a kind
/// this build doesn't know is skipped rather than failing the whole list.
public struct AppAccessRequestsResponse: Codable, Equatable, Sendable {
    public let requests: [AppAccessRequest]
    public let drafts: [AppAccessDraftEntry]
    public init(requests: [AppAccessRequest], drafts: [AppAccessDraftEntry] = []) {
        self.requests = requests
        self.drafts = drafts
    }

    private enum Entry: Decodable {
        case request(AppAccessRequest)
        case draft(AppAccessDraftEntry)
        case unknown

        init(from decoder: Decoder) throws {
            if let d = try? AppAccessDraftEntry(from: decoder) { self = .draft(d); return }
            let kind = try? decoder.container(keyedBy: KindKey.self).decodeIfPresent(String.self, forKey: .kind)
            if kind == nil || kind == "request", let r = try? AppAccessRequest(from: decoder) {
                self = .request(r)
                return
            }
            self = .unknown
        }
    }

    private enum KindKey: String, CodingKey { case kind }
    private enum CodingKeys: String, CodingKey { case requests }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let entries = try c.decodeIfPresent([Entry].self, forKey: .requests) ?? []
        var requests: [AppAccessRequest] = []
        var drafts: [AppAccessDraftEntry] = []
        for e in entries {
            switch e {
            case .request(let r): requests.append(r)
            case .draft(let d): drafts.append(d)
            case .unknown: continue
            }
        }
        self.requests = requests
        self.drafts = drafts
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        var list = c.nestedUnkeyedContainer(forKey: .requests)
        for d in drafts { try list.encode(d) }
        for r in requests { try list.encode(r) }
    }
}

/// `GET|POST /api/screens/settings/access-alerts`: whether the box pushes an
/// alert for a new access request. The phone's push switch writes it; the POST
/// answer also carries `ok`.
public struct AccessAlertsSetting: Codable, Equatable, Sendable {
    public let enabled: Bool
    public let ok: Bool?
    public init(enabled: Bool, ok: Bool? = nil) {
        self.enabled = enabled
        self.ok = ok
    }
}

/// The box's 400 for a list that doesn't parse: `{error, errors:[{line, message}]}`.
public struct AppAccessRefusal: Codable, Equatable, Sendable {
    public let error: String?
    public let errors: [AppAccessLineError]?

    public static func decode(_ body: String) -> AppAccessRefusal? {
        try? JSONDecoder().decode(AppAccessRefusal.self, from: Data(body.utf8))
    }
}

// MARK: - "A request is waiting" signal

/// Raised when a box says an app was denied a host no rule covered (a
/// `generic` push, or `app-access` from an older box; an `access-request`
/// frame on a screens socket; or the phone alert outbox). Carries nothing
/// about the app or host: the phone fetches those from the box.
public enum AppAccessEvents {
    public static let requested = Notification.Name("flagship.app-access.requested")
    /// What boxes before the push switch sent.
    public static let pushCategory = "app-access"
    /// What a box sends now: Apple and Google see only that Flagship pinged.
    public static let genericPushCategory = "generic"
    private static let pushCategories: Set<String> = [pushCategory, genericPushCategory]
    public static let socketEvent = "access-request"

    public static func post() {
        NotificationCenter.default.post(name: requested, object: nil)
    }

    /// A screens-socket frame `{kind|type|event: "access-request"}`.
    public static func isRequestFrame(_ data: Data) -> Bool {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return ["kind", "type", "event"].contains { obj[$0] as? String == socketEvent }
    }

    /// A push payload's category (`aps.category`, or a top-level
    /// `category` / `kind`) is `generic` or `app-access`.
    public static func isPush(_ userInfo: [AnyHashable: Any], categoryIdentifier: String? = nil) -> Bool {
        func matches(_ value: Any?) -> Bool { (value as? String).map(pushCategories.contains) ?? false }
        if matches(categoryIdentifier) || matches(userInfo["category"]) || matches(userInfo["kind"]) { return true }
        if let aps = userInfo["aps"] as? [String: Any], matches(aps["category"]) { return true }
        return false
    }
}
