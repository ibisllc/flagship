import Foundation

// Admin-only orders over one app's access (docs/service-access-gating.md,
// "Account members, ranks and who may change them"). They name the app (its
// `serviceRef`, the same on every server of the account), never one server,
// and are signed with the admin root. Wire parity with
// packages/protocol/src/appAccessOrders.ts; must pass
// packages/protocol/test-vectors/app-access-orders/vectors.json.
//
//   flagship/app-rank/v1|<serviceRef>|<target>|<rank>|<issuedAt>
//   flagship/service-access-mode/v2|<serviceRef>|<open|restricted>|<issuedAt>
//   flagship/service-allow-remove/v2|<serviceRef>|<aid hex>|<issuedAt>

public struct AppAccessOrderInvalid: Error, Equatable {
    public let reason: String
}

enum AppAccessOrderCheck {
    static func serviceRef(_ ref: String) throws {
        let ok = (1...128).contains(ref.count)
            && ref.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
            && ref.first != "-" && ref.last != "-"
        guard ok else { throw AppAccessOrderInvalid(reason: "serviceRef") }
    }

    static func lowerHex<S: StringProtocol>(_ h: S, count: Int) -> Bool {
        h.count == count && h.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    static func inviteId<S: StringProtocol>(_ id: S) -> Bool {
        (1...128).contains(id.count) && id.allSatisfy { c in
            c.isASCII && (c.isLetter || c.isNumber || c == "." || c == "_" || c == "-")
        }
    }

    static func issuedAt(_ at: Int64) throws {
        guard at >= 0 else { throw AppAccessOrderInvalid(reason: "issuedAt") }
    }

    static func join(_ parts: [String]) -> Data { Data(parts.joined(separator: "|").utf8) }
}

/// What an admin gives one target in one app: a rank, or `refused` (a device
/// or a co-manager only).
public enum AppRankValue: String, Codable, CaseIterable, Sendable {
    case member, manager, master, refused

    public init(_ role: AppMemberRole) {
        switch role {
        case .member: self = .member
        case .manager: self = .manager
        case .master: self = .master
        }
    }
}

/// `flagship/app-rank/v1`: an admin's order giving one target a rank in one app.
public struct AppRankOrder: Codable, Equatable, Sendable {
    public static let canonicalTag = "flagship/app-rank/v1"

    public let serviceRef: String
    public let target: String
    public let rank: String
    public let issuedAt: Int64

    public init(serviceRef: String, target: String, rank: String, issuedAt: Int64) {
        self.serviceRef = serviceRef
        self.target = target
        self.rank = rank
        self.issuedAt = issuedAt
    }

    public static func deviceTarget(_ pubHex: String) -> String { "device:\(pubHex.lowercased())" }
    public static func shareTarget(_ shareId: String) -> String { "share:\(shareId.lowercased())" }
    public static func aidTarget(_ aidHex: String) -> String { "aid:\(aidHex.lowercased())" }
    public static func inviteTarget(_ inviteId: String) -> String { "invite:\(inviteId)" }
    public static func grantTarget(inviteId: String, aidHex: String) -> String {
        "grant:\(inviteId)/\(aidHex.lowercased())"
    }

    enum TargetKind { case device, share, aid, invite, grant }

    static func targetKind(_ t: String) -> TargetKind? {
        typealias C = AppAccessOrderCheck
        if t.hasPrefix("device:") { return C.lowerHex(t.dropFirst(7), count: 64) ? .device : nil }
        if t.hasPrefix("share:") { return C.lowerHex(t.dropFirst(6), count: 32) ? .share : nil }
        if t.hasPrefix("aid:") { return C.lowerHex(t.dropFirst(4), count: 64) ? .aid : nil }
        if t.hasPrefix("invite:") { return C.inviteId(t.dropFirst(7)) ? .invite : nil }
        if t.hasPrefix("grant:") {
            let rest = t.dropFirst(6)
            guard let slash = rest.lastIndex(of: "/") else { return nil }
            return C.inviteId(rest[rest.startIndex..<slash]) && C.lowerHex(rest[rest.index(after: slash)...], count: 64)
                ? .grant : nil
        }
        return nil
    }

    /// Throws for an order the box would refuse (never sign one).
    public func canonicalBytes() throws -> Data {
        try AppAccessOrderCheck.serviceRef(serviceRef)
        guard let kind = Self.targetKind(target) else { throw AppAccessOrderInvalid(reason: "target") }
        guard let value = AppRankValue(rawValue: rank) else { throw AppAccessOrderInvalid(reason: "rank") }
        if value == .refused, kind != .device, kind != .share {
            throw AppAccessOrderInvalid(reason: "only a device or a co-manager can be refused")
        }
        try AppAccessOrderCheck.issuedAt(issuedAt)
        return AppAccessOrderCheck.join([Self.canonicalTag, serviceRef, target, rank, String(issuedAt)])
    }
}

/// `POST /api/screens/services/<id>/members/rank` body.
public struct AppRankRequest: Codable, Equatable, Sendable {
    public let order: AppRankOrder
    public let signature: String
    public init(order: AppRankOrder, signature: String) {
        self.order = order
        self.signature = signature
    }
}

public struct AppRankResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let target: String
    public let rank: String
    public init(ok: Bool, target: String, rank: String) {
        self.ok = ok
        self.target = target
        self.rank = rank
    }
}

/// `flagship/service-access-mode/v2`: open to all, or members only.
public struct ServiceAccessModeOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/service-access-mode/v2"

    public let serviceRef: String
    public let mode: String
    public let issuedAt: Int64

    public init(serviceRef: String, restricted: Bool, issuedAt: Int64) {
        self.init(serviceRef: serviceRef, mode: restricted ? "restricted" : "open", issuedAt: issuedAt)
    }

    public init(serviceRef: String, mode: String, issuedAt: Int64) {
        self.serviceRef = serviceRef
        self.mode = mode
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try AppAccessOrderCheck.serviceRef(serviceRef)
        guard mode == "open" || mode == "restricted" else { throw AppAccessOrderInvalid(reason: "mode") }
        try AppAccessOrderCheck.issuedAt(issuedAt)
        return AppAccessOrderCheck.join([Self.canonicalTag, serviceRef, mode, String(issuedAt)])
    }

    /// The `request` the box parses as v2 (no `serverId`).
    public var request: [String: Any] { ["serviceRef": serviceRef, "mode": mode, "issuedAt": issuedAt] }
}

/// `flagship/service-allow-remove/v2`: drop one person from an app's list.
public struct ServiceAllowRemoveOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/service-allow-remove/v2"

    public let serviceRef: String
    public let aid: String
    public let issuedAt: Int64

    public init(serviceRef: String, aid: String, issuedAt: Int64) {
        self.serviceRef = serviceRef
        self.aid = aid
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try AppAccessOrderCheck.serviceRef(serviceRef)
        guard AppAccessOrderCheck.lowerHex(aid, count: 64) else { throw AppAccessOrderInvalid(reason: "aid") }
        try AppAccessOrderCheck.issuedAt(issuedAt)
        return AppAccessOrderCheck.join([Self.canonicalTag, serviceRef, aid, String(issuedAt)])
    }

    public var request: [String: Any] { ["serviceRef": serviceRef, "aid": aid, "issuedAt": issuedAt] }
}

/// `flagship/restored-access-approve/v1`: an admin's approval of the permissions a restore held back
/// (SECURITY-HARDENING-PLAN.md 18.9). Names the app and the SHA-256 of the exact draft the admin was
/// shown, so it cannot approve another draft, a replaced one or another app.
public struct RestoredAccessApproveOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/restored-access-approve/v1"

    public let serviceRef: String
    public let draftSha256: String
    public let issuedAt: Int64

    public init(serviceRef: String, draftSha256: String, issuedAt: Int64) {
        self.serviceRef = serviceRef
        self.draftSha256 = draftSha256
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try AppAccessOrderCheck.serviceRef(serviceRef)
        guard AppAccessOrderCheck.lowerHex(draftSha256, count: 64) else { throw AppAccessOrderInvalid(reason: "draftSha256") }
        try AppAccessOrderCheck.issuedAt(issuedAt)
        return AppAccessOrderCheck.join([Self.canonicalTag, serviceRef, draftSha256, String(issuedAt)])
    }

    public var request: [String: Any] { ["serviceRef": serviceRef, "draftSha256": draftSha256, "issuedAt": issuedAt] }
}
