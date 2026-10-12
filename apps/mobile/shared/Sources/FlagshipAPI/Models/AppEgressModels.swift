import Foundation

// A live app's internet access, approved host by host by the owner.
//
// MIRRORS: packages/protocol/src/appEgress.ts (canonical bytes, golden vector
//          in packages/protocol/tests/appEgress.test.ts)
//          packages/server-daemon/src/egress/approvals.ts (the endpoint)

/// `egress` on an apps-list entry / app-detail `.app`: the hosts the manifest
/// declares (`network.egress`) and the ones the owner's newest signed grant
/// opened (always a subset of declared). Absent on boxes without the gateway.
public struct AppEgress: Codable, Equatable, Sendable {
    public let declared: [String]
    public let approved: [String]
    public init(declared: [String], approved: [String]) {
        self.declared = declared
        self.approved = approved
    }

    /// Declared hosts the owner hasn't allowed yet, in declared order.
    public var pending: [String] {
        let open = Set(approved.map { $0.lowercased() })
        return declared.filter { !open.contains($0.lowercased()) }
    }

    public var hasPending: Bool { !pending.isEmpty }
}

/// The owner's signed `flagship/app-egress/v1` grant: the hosts a live app
/// may reach on one box. `hosts: []` revokes.
public struct AppEgressGrant: Codable, Equatable, Sendable {
    public static let canonicalTag = "flagship/app-egress/v1"

    public let serverDomain: String
    public let serviceId: String
    /// Distinct, lowercase, sorted by UTF-16 code unit (what the box signs over).
    public let hosts: [String]
    public let issuedAt: Int64

    public init(serverDomain: String, serviceId: String, hosts: [String], issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.serviceId = serviceId
        self.hosts = Self.normalize(hosts)
        self.issuedAt = issuedAt
    }

    /// Lowercase, drop blanks and repeats, and sort by UTF-16 code unit
    /// (JavaScript's default order, which the box uses).
    public static func normalize(_ hosts: [String]) -> [String] {
        let cleaned = hosts
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
        return Array(Set(cleaned)).sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
    }

    /// `flagship/app-egress/v1|<serverDomain>|<serviceId>|<hosts,…>|<issuedAt>`
    public func canonicalBytes() -> Data {
        Data(
            [Self.canonicalTag, serverDomain, serviceId, hosts.joined(separator: ","), String(issuedAt)]
                .joined(separator: "|").utf8
        )
    }
}

/// `POST /api/screens/services/<serviceId>/egress` body.
public struct AppEgressSetRequest: Codable, Equatable, Sendable {
    public let grant: AppEgressGrant
    /// Ed25519 over `grant.canonicalBytes()`, 128 lowercase hex.
    public let signature: String
    public init(grant: AppEgressGrant, signature: String) {
        self.grant = grant
        self.signature = signature
    }
}

/// `→ 200 {ok, egress}`.
public struct AppEgressSetResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let egress: AppEgress?
    public init(ok: Bool, egress: AppEgress?) {
        self.ok = ok
        self.egress = egress
    }
}
