import Foundation

// A separate access list on each server, a Pro option (docs/service-access-
// gating.md, "Separate lists per server (Pro)"; feat/marketplace only). An
// admin signs which one an app has; it names the app, never a server. Wire
// parity with packages/protocol (appListScope); must pass
// packages/protocol/test-vectors/app-list-scope/vectors.json.
//
//   flagship/app-list-scope/v1|<serviceRef>|<account|server>|<issuedAt>

/// `flagship/app-list-scope/v1`: one list on every server (`account`) or a
/// separate one on each (`server`).
public struct AppListScopeOrder: Codable, Equatable, Sendable {
    public static let canonicalTag = "flagship/app-list-scope/v1"
    public static let scopes = ["account", "server"]

    public let serviceRef: String
    public let scope: String
    public let issuedAt: Int64

    public init(serviceRef: String, scope: String, issuedAt: Int64) {
        self.serviceRef = serviceRef
        self.scope = scope
        self.issuedAt = issuedAt
    }

    public init(serviceRef: String, separate: Bool, issuedAt: Int64) {
        self.init(serviceRef: serviceRef, scope: separate ? "server" : "account", issuedAt: issuedAt)
    }

    /// Throws for an order the box would refuse (never sign one).
    public func canonicalBytes() throws -> Data {
        try AppAccessOrderCheck.serviceRef(serviceRef)
        guard Self.scopes.contains(scope) else { throw AppAccessOrderInvalid(reason: "scope") }
        try AppAccessOrderCheck.issuedAt(issuedAt)
        return AppAccessOrderCheck.join([Self.canonicalTag, serviceRef, scope, String(issuedAt)])
    }
}

/// `POST /api/screens/services/<id>/list-scope` body.
public struct AppListScopeRequest: Codable, Equatable, Sendable {
    public let order: AppListScopeOrder
    public let signature: String
    public init(order: AppListScopeOrder, signature: String) {
        self.order = order
        self.signature = signature
    }
}

/// `GET /api/screens/services/<id>/list-scope` (and the POST's answer): the
/// app's scope as one server holds it.
public struct AppListScopeState: Codable, Equatable, Sendable {
    public let serviceRef: String
    /// "account" (one list) | "server" (a separate list on each server).
    public let scope: String
    /// A "server" order this box holds but hasn't honoured yet (it hasn't
    /// seen Pro).
    public let pending: Bool
    /// "pro" | "free" | "unknown".
    public let plan: String
    /// The box that answered (lowercase FQDN).
    public let selfFqdn: String
    /// The app's lead server, whose list every server takes when the app
    /// goes back to one.
    public let leader: String
    /// The app's servers in the owner's server order, this box included.
    public let servers: [String]

    enum CodingKeys: String, CodingKey {
        case serviceRef, scope, pending, plan, leader, servers
        case selfFqdn = "self"
    }

    public init(serviceRef: String, scope: String, pending: Bool = false, plan: String,
                selfFqdn: String, leader: String, servers: [String]) {
        self.serviceRef = serviceRef
        self.scope = scope == "server" ? "server" : "account"
        self.pending = pending
        self.plan = ["pro", "free"].contains(plan) ? plan : "unknown"
        self.selfFqdn = selfFqdn.lowercased()
        self.leader = leader.lowercased()
        var seen = Set<String>()
        self.servers = servers.map { $0.lowercased() }.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            serviceRef: (try? c.decode(String.self, forKey: .serviceRef)) ?? "",
            scope: (try? c.decode(String.self, forKey: .scope)) ?? "account",
            pending: (try? c.decode(Bool.self, forKey: .pending)) ?? false,
            plan: (try? c.decode(String.self, forKey: .plan)) ?? "unknown",
            selfFqdn: (try? c.decode(String.self, forKey: .selfFqdn)) ?? "",
            leader: (try? c.decode(String.self, forKey: .leader)) ?? "",
            servers: (try? c.decode([String].self, forKey: .servers)) ?? [])
    }

    public var isSeparate: Bool { scope == "server" }
    public var isPro: Bool { plan == "pro" }
}

/// `GET /api/screens/access-lists/summary`: across the whole account.
public struct AccessListsSummary: Codable, Equatable, Sendable {
    public let plan: String
    /// How many apps keep a separate list on each server.
    public let separateApps: Int
    /// Those apps' lead servers (lowercase FQDNs, no repeats).
    public let leaders: [String]

    enum CodingKeys: String, CodingKey { case plan, separateApps, leaders }

    public init(plan: String, separateApps: Int, leaders: [String]) {
        self.plan = ["pro", "free"].contains(plan) ? plan : "unknown"
        self.separateApps = max(0, separateApps)
        var seen = Set<String>()
        self.leaders = leaders.map { $0.lowercased() }.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            plan: (try? c.decode(String.self, forKey: .plan)) ?? "unknown",
            separateApps: (try? c.decode(Int.self, forKey: .separateApps)) ?? 0,
            leaders: (try? c.decode([String].self, forKey: .leaders)) ?? [])
    }
}
