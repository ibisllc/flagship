import Foundation

// Access control — members' roles (docs/service-access-gating.md, "Open mode +
// members"). Wire parity with packages/server-daemon/src/memberRoles.ts.
//
// Ranks are Flagship's member < manager < master, ordered and cumulative
// (the box owner is always owner and never given); apps enforce them. Every redemption of an invite is its own grant with a
// role (its own, else the invite's, else the app's default); a person holding
// several has the highest.

/// The ranks an owner can give, lowest first. Raw values are the wire names;
/// `label` is the ONE place their display names live on iOS.
public enum AppMemberRole: String, Codable, CaseIterable, Sendable, Identifiable {
    case member, manager, master
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .member: return "Member"
        case .manager: return "Manager"
        case .master: return "Master"
        }
    }
    /// Master is shown with a crown (`crown.fill`).
    public var crowned: Bool { self == .master }
    /// A role name as the box sends it; anything off the ladder is nil.
    public init?(wire: String?) {
        guard let wire, let r = AppMemberRole(rawValue: wire) else { return nil }
        self = r
    }
}

/// Who created an invite, as the box decided from the key that signed it:
/// `admin` (the admin root) or `member` (a membership key; its joins are
/// capped at Member). Nil on rows from before tiers were recorded.
public enum AppInviteTier: String, Codable, Sendable {
    case admin, member
}

public struct AppMemberGrant: Codable, Equatable, Sendable {
    public let inviteId: String
    public let role: String
    public let tier: String?
    public init(inviteId: String, role: String, tier: String? = nil) {
        self.inviteId = inviteId
        self.role = role
        self.tier = tier
    }
}

public struct AppMember: Codable, Equatable, Sendable {
    /// The member's per-author contact AID (lowercase hex).
    public let aid: String
    /// Their effective role: the highest of their grants.
    public let role: String
    public let grants: [AppMemberGrant]
    /// A role set on them directly (members who joined before grants were tracked).
    public let direct: String?
    public init(aid: String, role: String, grants: [AppMemberGrant], direct: String? = nil) {
        self.aid = aid
        self.role = role
        self.grants = grants
        self.direct = direct
    }
}

public struct AppMemberInviteRole: Codable, Equatable, Sendable {
    public let inviteId: String
    public let role: String
    public let set: Bool
    public let tier: String?
    public init(inviteId: String, role: String, set: Bool, tier: String? = nil) {
        self.inviteId = inviteId
        self.role = role
        self.set = set
        self.tier = tier
    }
}

/// `GET /api/screens/services/<id>/members`.
public struct AppMembersResponse: Codable, Equatable, Sendable {
    public let serviceId: String
    public let mode: String
    public let roles: [String]
    public let defaultRole: String
    /// The app's one line per rank (its manifest's `role_descriptions`).
    public let descriptions: [String: String]?
    public let members: [AppMember]
    public let invites: [AppMemberInviteRole]

    public init(serviceId: String, mode: String, roles: [String] = AppMemberRole.allCases.map(\.rawValue),
                defaultRole: String, descriptions: [String: String]? = nil,
                members: [AppMember], invites: [AppMemberInviteRole]) {
        self.serviceId = serviceId
        self.mode = mode
        self.roles = roles
        self.defaultRole = defaultRole
        self.descriptions = descriptions
        self.members = members
        self.invites = invites
    }

    /// The app's one line for a rank, or nil.
    public func description(of role: AppMemberRole) -> String? {
        guard let d = descriptions?[role.rawValue], !d.isEmpty else { return nil }
        return d
    }

    public func member(_ aid: String?) -> AppMember? {
        guard let aid = aid?.lowercased() else { return nil }
        return members.first { $0.aid == aid }
    }

    /// Where a role change for one row goes: a person's personal invite is
    /// their grant; a member who joined before grants were tracked is
    /// addressed by their AID.
    public func roleTarget(inviteId: String, boundAID: String?) -> String {
        if let m = member(boundAID), !m.grants.contains(where: { $0.inviteId == inviteId }) {
            return AppMemberRoleOrder.aidTarget(m.aid)
        }
        return AppMemberRoleOrder.inviteTarget(inviteId)
    }

    /// The role one row shows.
    public func rowRole(inviteId: String, boundAID: String?) -> String {
        if let m = member(boundAID), !m.grants.contains(where: { $0.inviteId == inviteId }) { return m.role }
        return invites.first { $0.inviteId == inviteId }?.role ?? defaultRole
    }

    /// The tier the box recorded for an invite, or nil when it has none.
    public func inviteTier(_ inviteId: String) -> AppInviteTier? {
        let raw = invites.first { $0.inviteId == inviteId }?.tier
            ?? members.lazy.flatMap(\.grants).first { $0.inviteId == inviteId }?.tier
        return raw.flatMap(AppInviteTier.init(rawValue:))
    }

    /// The person's other grants, for "also in Family: Viewer".
    public func otherGrants(inviteId: String, boundAID: String?, label: (String) -> String?) -> [(label: String, role: String)] {
        guard let m = member(boundAID) else { return [] }
        return m.grants.filter { $0.inviteId != inviteId }.compactMap { g in
            guard let l = label(g.inviteId), !l.isEmpty else { return nil }
            return (l, g.role)
        }
    }

    /// The AIDs to prune on the box when this grant goes: only those for whom
    /// it was their last grant (the box drops just the grant for the others).
    public func aidsToPrune(inviteId: String, aids: [String]) -> [String] {
        aids.filter { aid in
            guard let m = member(aid) else { return true }
            return m.grants.allSatisfy { $0.inviteId == inviteId }
        }
    }

    public static func alsoInText(_ others: [(label: String, role: String)]) -> String {
        guard !others.isEmpty else { return "" }
        return "also in " + others.map { "\($0.label): \(AppMemberRole(wire: $0.role)?.label ?? $0.role)" }
            .joined(separator: ", ")
    }
}

/// `flagship/app-member-role/v1|<serverDomain>|<serviceId>|<target>|<role>|<issuedAt>`:
/// the owner's order giving an invite (`invite:<inviteId>`), one person's join
/// through it (`grant:<inviteId>/<aid>`) or a member (`aid:<hex>`) a role. Signed by the sensitive-order key.
/// Must pass packages/protocol/test-vectors/app-member-role/vectors.json.
public struct AppMemberRoleOrder: Codable, Equatable, Sendable {
    public static let canonicalTag = "flagship/app-member-role/v1"

    public struct Invalid: Error, Equatable {
        public let reason: String
    }

    /// The box the request goes to (its FQDN).
    public let serverDomain: String
    public let serviceId: String
    public let target: String
    public let role: String
    public let issuedAt: Int64

    public init(serverDomain: String, serviceId: String, target: String, role: String, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.serviceId = serviceId
        self.target = target
        self.role = role
        self.issuedAt = issuedAt
    }

    public static func aidTarget(_ aidHex: String) -> String { "aid:\(aidHex.lowercased())" }
    public static func inviteTarget(_ inviteId: String) -> String { "invite:\(inviteId)" }

    public static func grantTarget(inviteId: String, aidHex: String) -> String {
        "grant:\(inviteId)/\(aidHex.lowercased())"
    }

    private static func isAidHex<S: StringProtocol>(_ h: S) -> Bool {
        h.count == 64 && h.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    private static func isInviteId<S: StringProtocol>(_ id: S) -> Bool {
        (1...128).contains(id.count) && id.allSatisfy { c in
            c.isASCII && (c.isLetter || c.isNumber || c == "." || c == "_" || c == "-")
        }
    }

    private static func validTarget(_ t: String) -> Bool {
        if t.hasPrefix("aid:") { return isAidHex(t.dropFirst(4)) }
        if t.hasPrefix("invite:") { return isInviteId(t.dropFirst(7)) }
        if t.hasPrefix("grant:") {
            let rest = t.dropFirst(6)
            guard let slash = rest.lastIndex(of: "/") else { return false }
            return isInviteId(rest[rest.startIndex..<slash]) && isAidHex(rest[rest.index(after: slash)...])
        }
        return false
    }

    private static func fieldOK(_ v: String) -> Bool {
        !v.isEmpty && !v.unicodeScalars.contains { $0 == "|" || $0.value <= 0x1f || $0.value == 0x7f }
    }

    /// Throws for an order the box would refuse (never sign one).
    public func canonicalBytes() throws -> Data {
        guard Self.fieldOK(serverDomain) else { throw Invalid(reason: "serverDomain") }
        guard Self.fieldOK(serviceId) else { throw Invalid(reason: "serviceId") }
        guard Self.validTarget(target) else { throw Invalid(reason: "target") }
        guard AppMemberRole(rawValue: role) != nil else { throw Invalid(reason: "role") }
        guard issuedAt >= 0 else { throw Invalid(reason: "issuedAt") }
        return Data([Self.canonicalTag, serverDomain, serviceId, target, role, String(issuedAt)]
            .joined(separator: "|").utf8)
    }
}

/// `POST /api/screens/services/<id>/members/role` body.
public struct AppMemberRoleRequest: Codable, Equatable, Sendable {
    public let order: AppMemberRoleOrder
    public let signature: String
    public init(order: AppMemberRoleOrder, signature: String) {
        self.order = order
        self.signature = signature
    }
}

public struct AppMemberRoleResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let target: String
    public let role: String
    public init(ok: Bool, target: String, role: String) {
        self.ok = ok
        self.target = target
        self.role = role
    }
}
