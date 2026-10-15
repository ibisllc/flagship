import Foundation

// Access control — members' ranks (docs/service-access-gating.md, "Open mode +
// members" and "Account members, ranks and who may change them"). Wire parity
// with packages/server-daemon/src/memberRoles.ts.
//
// Ranks are exactly member < manager < master, ordered and cumulative; there
// is no owner rank. Apps enforce them. Every redemption of an invite is its
// own grant with a role (its own, else the invite's, else the app's default);
// a person holding several has the highest. The account's own devices and
// co-managing accounts have a rank by default (`accountMembers`).

/// The ranks an admin can give, lowest first. Raw values are the wire names;
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
    /// A role name as the box sends it; anything off the ladder is nil. A
    /// legacy `owner` reads as master.
    public init?(wire: String?) {
        if wire == "owner" { self = .master; return }
        guard let wire, let r = AppMemberRole(rawValue: wire) else { return nil }
        self = r
    }

    /// Manager or master: a non-admin device may invite at Member and
    /// withdraw its own invites.
    public var isManagerClass: Bool { self != .member }
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
    /// The key the box recorded as the invite's creator (lowercase hex).
    public let creatorPub: String?
    /// The account device that key belongs to, from the box's device book.
    public let creatorDeviceId: String?
    public init(inviteId: String, role: String, set: Bool, tier: String? = nil,
                creatorPub: String? = nil, creatorDeviceId: String? = nil) {
        self.inviteId = inviteId
        self.role = role
        self.set = set
        self.tier = tier
        self.creatorPub = creatorPub
        self.creatorDeviceId = creatorDeviceId
    }
}

/// One of the account's devices, or an account that co-manages the server,
/// with its rank in this app. The box knows device ids and keys only; names
/// are resolved on the phone.
public struct AppAccountMember: Codable, Equatable, Sendable, Identifiable {
    /// "device" | "co-manager".
    public let kind: String
    public let deviceId: String?
    /// The device's account device key (lowercase hex).
    public let devicePub: String?
    /// "admin" | "member" (devices only).
    public let tier: String?
    public let shareId: String?
    /// The server owner's own label for a co-managing account.
    public let label: String?
    /// The effective rank; nil when refused.
    public let rank: String?
    /// An admin order set it (else it is the default for its kind).
    public let set: Bool
    public let refused: Bool

    public init(kind: String, deviceId: String? = nil, devicePub: String? = nil, tier: String? = nil,
                shareId: String? = nil, label: String? = nil, rank: String?, set: Bool = false, refused: Bool = false) {
        self.kind = kind
        self.deviceId = deviceId
        self.devicePub = devicePub
        self.tier = tier
        self.shareId = shareId
        self.label = label
        self.rank = rank
        self.set = set
        self.refused = refused
    }

    public static func device(id: String, pub: String, admin: Bool, rank: String?, set: Bool = false,
                              refused: Bool = false) -> AppAccountMember {
        AppAccountMember(kind: "device", deviceId: id, devicePub: pub, tier: admin ? "admin" : "member",
                         rank: rank, set: set, refused: refused)
    }

    public static func coManager(shareId: String, label: String, rank: String?, set: Bool = false,
                                 refused: Bool = false) -> AppAccountMember {
        AppAccountMember(kind: "co-manager", shareId: shareId, label: label, rank: rank, set: set, refused: refused)
    }

    public var isDevice: Bool { kind == "device" }
    public var isAdminDevice: Bool { isDevice && tier == "admin" }
    public var id: String { isDevice ? (deviceId ?? devicePub ?? "") : (shareId ?? "") }
    public var role: AppMemberRole? { refused ? nil : AppMemberRole(wire: rank) }

    /// Where an admin's rank order for this row goes; nil when it names no key.
    public var rankTarget: String? {
        if isDevice { return devicePub.map(AppRankOrder.deviceTarget) }
        return shareId.map(AppRankOrder.shareTarget)
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
    /// The account's devices and co-managing accounts (nil from an older box).
    public let accountMembers: [AppAccountMember]?
    public let members: [AppMember]
    public let invites: [AppMemberInviteRole]

    public init(serviceId: String, mode: String, roles: [String] = AppMemberRole.allCases.map(\.rawValue),
                defaultRole: String, descriptions: [String: String]? = nil,
                accountMembers: [AppAccountMember]? = nil,
                members: [AppMember], invites: [AppMemberInviteRole]) {
        self.serviceId = serviceId
        self.mode = mode
        self.roles = roles
        self.defaultRole = defaultRole
        self.descriptions = descriptions
        self.accountMembers = accountMembers
        self.members = members
        self.invites = invites
    }

    public var account: [AppAccountMember] { accountMembers ?? [] }

    /// This device's own row: by its account device key, else by its id.
    public func me(devicePub: String?, deviceId: String?) -> AppAccountMember? {
        let devices = account.filter(\.isDevice)
        if let pub = devicePub?.lowercased(), !pub.isEmpty,
           let row = devices.first(where: { $0.devicePub?.lowercased() == pub }) {
            return row
        }
        guard let id = deviceId?.lowercased(), !id.isEmpty else { return nil }
        return devices.first { $0.deviceId?.lowercased() == id }
    }

    public func invite(_ inviteId: String) -> AppMemberInviteRole? {
        invites.first { $0.inviteId == inviteId }
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
            return AppRankOrder.aidTarget(m.aid)
        }
        return AppRankOrder.inviteTarget(inviteId)
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
/// the server-named predecessor of `AppRankOrder`. The box still accepts it;
/// iOS sends `AppRankOrder` and keeps this to pass
/// packages/protocol/test-vectors/app-member-role/vectors.json.
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

    private static func validTarget(_ t: String) -> Bool {
        switch AppRankOrder.targetKind(t) {
        case .aid, .invite, .grant: return true
        default: return false
        }
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
