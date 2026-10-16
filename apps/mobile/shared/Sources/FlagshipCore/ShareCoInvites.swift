import Foundation
import CryptoKit

// Co-manager invites (docs/service-access-gating.md "Co-manager invites"): at
// "Can manage", B invites people to the shared server's apps at Member while
// B stays manager-class there, and withdraws only B's own invites. The create
// and the withdraw are signed with B's member key and go to the box over the
// share session; the box relays them to `.com`, so the app never calls `.com`
// for them. Names are sealed under B's share-invite bundle key, so only B's
// devices read them. Strings match the webapp's `CO_INVITE_*`.

public enum ShareCoInviteCopy {
    public static let open = "Invite people"
    public static let line = "People you invite join as Member. You can withdraw your own invites."
    public static let addPerson = "+ Add person"
    public static let addGroup = "+ Add group"
    public static let nameLabel = "Name"
    public static let groupNameLabel = "Group name"
    public static let nameHint = "Only your devices see it."
    public static let namePlaceholder = "Alex"
    public static let groupNamePlaceholder = "Chess club"
    public static let maxUsesLabel = "Max uses"
    public static let maxUsesHint = "0 = unlimited"
    public static let daysLabel = "Expires in days"
    public static let daysHint = "optional"
    public static let rankLine = "Rank: Member"
    public static let create = "Create invite link"
    public static let linkLine = "Send the link over a private channel. Whoever opens it joins as Member."
    public static let copyLink = "Copy link"
    public static let yours = "Your invites"
    public static let none = "You haven't invited anyone to this app yet."
    public static let withdraw = "Withdraw"
    public static let withdrawTitle = "Withdraw this invite?"
    public static let unnamed = "Someone"
    public static let created = "Invite created"
    public static let withdrawn = "Invite withdrawn"
    public static let linkCopied = "Link copied"
    public static let noName = "Give them a name."
    public static let noGroupName = "Give the group a name."
    public static let noOwner = "This server can't take invites yet."
    public static let readFailed = "Couldn't read your invites from this server."
    public static let createFailed = "Couldn't create the invite. Try again."
    public static let withdrawFailed = "Couldn't withdraw the invite. Try again."

    /// Why B can't invite (the box sends the same sentence as `whyText`; this is the fallback).
    public static let why: [String: String] = [
        "not-shared": "This server isn't shared with you anymore.",
        "view-only": "You can view this server but not manage it, so you can't invite people to its apps.",
        "demoted": "An admin made you a Member of this app, so you can't invite people to it.",
        "refused": "An admin turned off your access to this app.",
        "catching-up": "This server is catching up with the app's other servers. Try again in a moment.",
    ]
    public static var viewOnly: String { why["view-only"]! }

    public static func withdrawMessage(_ appName: String) -> String {
        "The link stops working, and anyone who joined through it loses access to \(appName)."
    }

    /// "Not opened yet", "1 person joined", "3 of 10 joined", "3 joined" (a group with no limit).
    public static func statusText(_ inv: ShareCoInvite, now: Int64 = ServerShareClock.nowMs()) -> String {
        let n = inv.joined
        var text: String
        if let max = inv.maxRedemptions {
            text = max == 0 ? "\(n) joined" : "\(n) of \(max) joined"
        } else {
            text = n == 0 ? "Not opened yet" : n == 1 ? "1 person joined" : "\(n) people joined"
        }
        if let exp = inv.expiresAt, exp <= now { text += " · expired" }
        return text
    }
}

/// The box refused (or the phone stopped) a co-manager invite action, in words for the person.
public struct ShareInviteRefusal: Error, Equatable, LocalizedError, Sendable {
    public let code: String?
    public let message: String

    public init(code: String?, message: String) {
        self.code = code
        self.message = message
    }

    /// The box's own sentence for a refusal it explained (a coded error), else `fallback`.
    public init(_ e: ServerShareHTTPError, fallback: String) {
        self.code = e.code
        if let code = e.code, let error = e.error, !error.isEmpty, code != "malformed", code != "invalid-signature" {
            self.message = error
        } else {
            self.message = fallback
        }
    }

    public var errorDescription: String? { message }
}

// MARK: - Wire

/// `GET /api/shares/invites?service=<serviceRef>`.
public struct ShareInvitesResponse: Decodable, Equatable, Sendable {
    public struct Row: Decodable, Equatable, Sendable {
        public let inviteId: String?
        public let createdAt: Int64?
        public let encryptedBundle: String?
        public let maxRedemptions: Int?
        public let expiresAt: Int64?
        public let joined: Int?
    }
    public let serviceRef: String?
    public let canInvite: Bool?
    public let why: String?
    public let whyText: String?
    public let rank: String?
    public let ownerAid: String?
    public let invites: [Row]?
}

/// The create B signs (`flagship/service-invite/create/v1`); `authorAID` is the owner's AID.
public struct ShareInviteCreateRequest: Codable, Equatable, Sendable {
    public let inviteId: String
    public let authorAID: String
    public let serviceRef: String
    public let secretHash: String
    public let encryptedBundle: String
    public let issuedAt: Int64
    public let maxRedemptions: Int?
    public let expiresAt: Int64?

    public func canonicalBytes() throws -> Data {
        guard let aid = HexUtil.decode(authorAID) else { throw ServiceInviteError.field("authorAID must be hex") }
        return try ServiceInvite.canonicalCreate(inviteId: inviteId, authorAID: aid, serviceRef: serviceRef,
                                                 secretHash: secretHash, encryptedBundle: encryptedBundle,
                                                 issuedAt: issuedAt, maxRedemptions: maxRedemptions, expiresAt: expiresAt)
    }
}

/// The withdraw B signs (`flagship/service-invite/revoke/v1`).
public struct ShareInviteRevoke: Codable, Equatable, Sendable {
    public let inviteId: String
    public let issuedAt: Int64

    public func canonicalBytes() throws -> Data {
        try ServiceInvite.canonicalRevoke(inviteId: inviteId, issuedAt: issuedAt)
    }
}

struct ShareInviteCreateBody: Encodable {
    let request: ShareInviteCreateRequest
    let signature: String
}

struct ShareInviteWithdrawBody: Encodable {
    let revoke: ShareInviteRevoke
    let signature: String
}

// MARK: - Opened

/// One of B's own invites, its name opened with B's bundle key (nil when it won't open).
public struct ShareCoInvite: Identifiable, Equatable, Sendable {
    public let inviteId: String
    public let name: String?
    public let createdAt: Int64?
    public let joined: Int
    public let maxRedemptions: Int?
    public let expiresAt: Int64?
    public var id: String { inviteId }
    public var displayName: String { name ?? ShareCoInviteCopy.unnamed }

    public init(inviteId: String, name: String?, createdAt: Int64? = nil, joined: Int = 0,
                maxRedemptions: Int? = nil, expiresAt: Int64? = nil) {
        self.inviteId = inviteId
        self.name = name
        self.createdAt = createdAt
        self.joined = joined
        self.maxRedemptions = maxRedemptions
        self.expiresAt = expiresAt
    }
}

/// Whether B may invite to one app, and B's own invites there.
public struct ShareCoInviteState: Equatable, Sendable {
    public let canInvite: Bool
    public let why: String?
    /// The box's sentence when B can't invite ("" when B can).
    public let whyText: String
    public let rank: String?
    public let ownerAid: String?
    public let invites: [ShareCoInvite]

    public init(canInvite: Bool, why: String?, whyText: String, rank: String?, ownerAid: String?, invites: [ShareCoInvite]) {
        self.canInvite = canInvite
        self.why = why
        self.whyText = whyText
        self.rank = rank
        self.ownerAid = ownerAid
        self.invites = invites
    }

    /// Open the box's answer: names under `bundleKey` ("Someone" when one won't open).
    public static func from(_ body: ShareInvitesResponse, bundleKey: Data) -> ShareCoInviteState {
        let invites: [ShareCoInvite] = (body.invites ?? []).compactMap { r in
            guard let id = r.inviteId else { return nil }
            let name = r.encryptedBundle.flatMap {
                try? ServiceInvite.openBundle($0, householdKey: bundleKey, inviteId: id).name
            }
            return ShareCoInvite(inviteId: id, name: name, createdAt: r.createdAt, joined: max(0, r.joined ?? 0),
                                 maxRedemptions: r.maxRedemptions, expiresAt: r.expiresAt)
        }
        let canInvite = body.canInvite == true
        let whyText = canInvite ? "" : (body.whyText.flatMap { $0.isEmpty ? nil : $0 } ?? body.why.flatMap { ShareCoInviteCopy.why[$0] } ?? "")
        let owner = body.ownerAid.flatMap { ServerShare.isLowerHex($0, 64) ? $0 : nil }
        return ShareCoInviteState(canInvite: canInvite, why: body.why, whyText: whyText, rank: body.rank,
                                  ownerAid: owner, invites: invites)
    }
}

/// A group invite's limits: `maxRedemptions` 0 = unlimited.
public struct ShareCoInviteGroup: Equatable, Sendable {
    public let maxRedemptions: Int
    public let expiresAt: Int64?

    public init(maxRedemptions: Int, expiresAt: Int64? = nil) {
        self.maxRedemptions = maxRedemptions
        self.expiresAt = expiresAt
    }

    /// From the form: max uses (default 10 when unreadable) and days (none when empty or 0).
    public static func fromForm(maxUses: String, days: String, now: Int64 = ServerShareClock.nowMs()) -> ShareCoInviteGroup {
        let m = Int(maxUses.trimmingCharacters(in: .whitespaces)).flatMap { $0 >= 0 ? $0 : nil } ?? 10
        let d = Double(days.trimmingCharacters(in: .whitespaces)) ?? 0
        let exp: Int64? = d.isFinite && d > 0 ? now + Int64((d * 86_400_000).rounded()) : nil
        return ShareCoInviteGroup(maxRedemptions: m, expiresAt: exp)
    }
}

public struct ShareCoInviteCreated: Equatable, Sendable {
    public let inviteId: String
    public let link: String
}

// MARK: - Flow

extension ServerShareMemberFlow {
    /// Whether B may invite to `serviceRef` and B's own invites there.
    public func coInvites(_ entry: SharedServerEntry, shareToken: String, serviceRef: String) async throws -> ShareCoInviteState {
        let body: ShareInvitesResponse
        do {
            body = try await client.boxInvites(serverDomain: entry.serverDomain.lowercased(), shareToken: shareToken,
                                               serviceRef: serviceRef)
        } catch let e as ServerShareHTTPError where e.status != 0 && e.status != 401 {
            throw ShareInviteRefusal(e, fallback: ShareCoInviteCopy.readFailed)
        }
        let seed = try await umkSeed("See who you invited to \(entry.displayName)")
        return ShareCoInviteState.from(body, bundleKey: try ServerShare.deriveShareInviteBundleKey(umkSeed: seed, shareId: entry.shareId))
    }

    /// Invite someone (or a group) to an app on the shared server at Member:
    /// sign `flagship/service-invite/create/v1` with B's member key, hand it
    /// to the box, and build the link on the shared server.
    public func createCoInvite(_ entry: SharedServerEntry, shareToken: String, serviceRef: String, ownerAid: String?,
                               name: String, group: ShareCoInviteGroup? = nil,
                               random: ((Int) -> Data)? = nil) async throws -> ShareCoInviteCreated {
        let label = ServerShare.jsTrim(name)
        guard !label.isEmpty else {
            throw ShareInviteRefusal(code: "no-name", message: group == nil ? ShareCoInviteCopy.noName : ShareCoInviteCopy.noGroupName)
        }
        guard let ownerAid, ServerShare.isLowerHex(ownerAid, 64) else {
            throw ShareInviteRefusal(code: "no-owner", message: ShareCoInviteCopy.noOwner)
        }
        let seed = try await umkSeed("Invite someone to \(entry.displayName)")
        let member = try ServerShare.deriveShareMemberKey(umkSeed: seed, shareId: entry.shareId)
        let bundleKey = try ServerShare.deriveShareInviteBundleKey(umkSeed: seed, shareId: entry.shareId)
        let rand = random ?? { ServerShare.randomBytes($0) }
        let secret = rand(32)
        let inviteId = HexUtil.encode(rand(32))
        let request = ShareInviteCreateRequest(
            inviteId: inviteId, authorAID: ownerAid, serviceRef: serviceRef,
            secretHash: ServiceInvite.secretHash(secret: secret),
            encryptedBundle: try ServiceInvite.sealBundle(.init(name: label), householdKey: bundleKey, inviteId: inviteId),
            issuedAt: now(), maxRedemptions: group?.maxRedemptions, expiresAt: group?.expiresAt)
        let signature = HexUtil.encode(try member.signature(for: try request.canonicalBytes()))
        let domain = entry.serverDomain.lowercased()
        do {
            try await client.boxCreateInvite(serverDomain: domain, shareToken: shareToken, request: request, signature: signature)
        } catch let e as ServerShareHTTPError where e.status != 0 && e.status != 401 {
            throw ShareInviteRefusal(e, fallback: ShareCoInviteCopy.createFailed)
        }
        let link = ServiceInviteLinks.inviteLink(serverDomain: domain, secretHex: HexUtil.encode(secret),
                                                 authorAidHex: ownerAid, inviteId: inviteId, serviceRef: serviceRef)
        return ShareCoInviteCreated(inviteId: inviteId, link: link)
    }

    /// Withdraw one of B's own invites: `flagship/service-invite/revoke/v1` signed with B's member key.
    public func withdrawCoInvite(_ entry: SharedServerEntry, shareToken: String, inviteId: String) async throws {
        let member = try await memberKey(shareId: entry.shareId, reason: "Withdraw an invite to \(entry.displayName)")
        let revoke = ShareInviteRevoke(inviteId: inviteId, issuedAt: now())
        let signature = HexUtil.encode(try member.signature(for: try revoke.canonicalBytes()))
        do {
            try await client.boxWithdrawInvite(serverDomain: entry.serverDomain.lowercased(), shareToken: shareToken,
                                               revoke: revoke, signature: signature)
        } catch let e as ServerShareHTTPError where e.status != 0 && e.status != 401 {
            throw ShareInviteRefusal(e, fallback: ShareCoInviteCopy.withdrawFailed)
        }
    }
}
