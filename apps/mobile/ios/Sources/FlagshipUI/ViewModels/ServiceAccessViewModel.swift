import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Admin orchestrator for per-service access gating (docs/service-access-gating.md,
/// "## v2 hardening").
///
/// On the service's "Access control" surface (docs/service-access-gating.md,
/// "Open mode + members"; the toggle and the members list are independent):
///   - reads the TRUE mode from the box (`GET /api/service-access/<ref>`),
///   - toggles Open to all ⇄ Members only with an owner-IRK
///     `set-service-access-mode` envelope to the box's pinned pipe,
///   - reads each member's grants and rank from the box (owner session) and
///     changes a rank with a signed `flagship/app-member-role/v1` order,
///   - manages the allow-list across the THREE invite tiers (personal auto /
///     personal manual / group multi-use): add a person/group (seal the bundle
///     under the household key → sign the create → POST `.com` → return
///     the `https://<server>/invite#<secret>&a=<authorAID>[&i=…]` link),
///     list (an OWNER-SIGNED `.com` query; decrypt the bundle locally; group =
///     one "label — k/N" row), and remove (a signed revoke on `.com` + an
///     owner-IRK prune of each bound AID on the box).
///
/// Who can invite (owner decision 2026-10-15): only admins grant higher access;
/// any device of the account may invite at Member, and admins are told. An
/// admin device (it holds the admin root) signs create / revoke with the admin
/// root, behind one Face ID that also opens the session's account keys. Any
/// other device signs them with the stable **AID**: `.com` records the invite
/// as member tier, the box caps its joins at Member, and this device may only
/// withdraw its own member invites and never changes ranks. The listing is
/// AID-signed on every device. The box's mode toggle + allow-remove stay
/// owner-**IRK** signed (the box pins the owner IRK).
@Observable
@MainActor
public final class ServiceAccessViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case failed(String)
    }

    /// The three invite tiers the create picker offers (docs §v2 Phase 3).
    public enum InviteTier: Equatable, Sendable {
        /// Personal, auto-approve — first-bind (the casual-leak window, default).
        case personalAuto
        /// Personal, manual-approve (sensitive) — the friend's redeem returns
        /// {pending}; the friend replies an AID-signed acceptance the AUTHOR
        /// finalizes. `approvalMode:"manual"` on `.com`.
        case personalManual
        /// Group / multi-use — one link, `maxRedemptions` (0 = unlimited) +
        /// optional `expiresAt`. Auto-approve, lower-trust by construction.
        case group(maxRedemptions: Int, expiresAt: Int64?)

        public var isGroup: Bool { if case .group = self { return true }; return false }
        public var isManual: Bool { self == .personalManual }
    }

    public struct Person: Equatable, Sendable, Identifiable {
        public let inviteId: String
        public let name: String
        public let photo: String?
        public let bound: Bool
        /// The friend's allow-listed AID (lowercase hex) once they've redeemed;
        /// nil for an unredeemed invite. Drives the box-side prune on remove.
        public let boundAID: String?
        /// GROUP rows: every bound AID (a group is a labeled set). The box prune
        /// removes ALL of them. Empty for a personal invite.
        public let groupBoundAIDs: [String]
        /// GROUP rows: the cap (0 = unlimited) so the row can show "k/N".
        public let groupMax: Int?
        /// Manual-approve invite (no bind until the author finalizes).
        public let manual: Bool
        /// "admin" | "member" as `.com` recorded it; nil on old rows.
        public let creatorTier: String?
        /// The account device id that created the invite; nil on old rows.
        public let creatorDeviceId: String?
        public var id: String { inviteId }
        public var isGroup: Bool { groupMax != nil }
        public init(inviteId: String, name: String, photo: String?, bound: Bool, boundAID: String?, groupBoundAIDs: [String] = [], groupMax: Int? = nil, manual: Bool = false,
                    creatorTier: String? = nil, creatorDeviceId: String? = nil) {
            self.inviteId = inviteId
            self.name = name
            self.photo = photo
            self.bound = bound
            self.boundAID = boundAID
            self.groupBoundAIDs = groupBoundAIDs
            self.groupMax = groupMax
            self.manual = manual
            self.creatorTier = creatorTier
            self.creatorDeviceId = creatorDeviceId
        }
    }

    /// Why a non-admin device's rank picker is locked to Member.
    public static let memberOnlyReason = "Only an admin device can give a higher rank"

    public private(set) var phase: Phase = .idle
    public private(set) var restricted = false
    public private(set) var allowCount = 0
    public private(set) var people: [Person] = []
    /// Set after a successful create so the screen can surface the share-link.
    public private(set) var lastInviteLink: String?
    /// The tier the last-created link was for (so the screen can label it).
    public private(set) var lastInviteTier: InviteTier?

    public var busyMode = false
    public var busyAdd = false
    /// The box's members, grants and ranks; nil until read (or when it can't be).
    public private(set) var members: AppMembersResponse?
    /// Rows whose rank change is being signed / sent (by inviteId).
    public private(set) var busyRoles: Set<String> = []
    /// Set when an invite was created but its rank couldn't be set.
    public private(set) var roleNotice: String?
    /// This account's device names (decrypted on the phone), nil until read
    /// or when this device can't read the directory.
    public private(set) var deviceNames: [String: String]?

    /// Does this device hold the account's admin root? Only then can it give
    /// a rank above Member, change ranks or revoke anyone's invite.
    public let isAdminDevice: Bool
    /// This device's account device id (sent with a create, for attribution).
    public let deviceId: String?

    private let client: any ServiceAccessClient
    private let serverDomain: String
    private let serviceRef: String
    private let username: String
    private let controlBase: URL
    /// One-biometric author v2 bundle: (AID signer, household key). The AID signs
    /// create/revoke/list AND is the recorded inviter identity; the household
    /// decrypts the listed bundles.
    private let authorAidKeys: @MainActor (String) async throws -> (aid: Curve25519.Signing.PrivateKey, household: Data)
    /// Owner IRK signer — the box mode toggle + allow-remove (the box pins the IRK).
    private let irkSigner: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    /// The box's owner-session API (members + ranks); nil ⇒ no ranks shown.
    private let screens: (any ScreensClient)?
    /// Sensitive-order signer for rank changes (admin root when held, else the IRK).
    private let roleSigner: AppAccessSigner
    /// The admin root, on an admin device, behind a prompt that also opens
    /// the session's account keys, so the AID that follows costs none.
    private let adminSigner: AppAccessSigner
    private let loadDeviceNames: @MainActor () async -> [String: String]?
    private let now: () -> Int64

    public init(
        client: any ServiceAccessClient,
        serverDomain: String,
        serviceRef: String,
        username: String,
        controlBase: URL = Endpoints.controlBaseUrl,
        authorAidKeys: (@MainActor (String) async throws -> (aid: Curve25519.Signing.PrivateKey, household: Data))? = nil,
        irkSigner: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        screens: (any ScreensClient)? = nil,
        roleSigner: AppAccessSigner? = nil,
        isAdminDevice: Bool? = nil,
        adminSigner: AppAccessSigner? = nil,
        deviceId: String? = nil,
        deviceNames: (@MainActor () async -> [String: String]?)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.screens = screens
        self.roleSigner = roleSigner ?? AppAccessOrder.defaultSigner
        self.isAdminDevice = isAdminDevice ?? Keystore.hasAdminRoot
        self.adminSigner = adminSigner ?? { reason in try await ServerOrderSaver.sensitiveOrderKey(reason: reason) }
        self.deviceId = deviceId?.lowercased()
        self.loadDeviceNames = deviceNames ?? { nil }
        self.client = client
        self.serverDomain = serverDomain
        self.serviceRef = serviceRef
        self.username = username
        self.controlBase = controlBase
        self.now = now
        self.authorAidKeys = authorAidKeys ?? { reason in
            try await Keystore.deriveInviteAuthorAidKeys(reason: reason)
        }
        self.irkSigner = irkSigner ?? { reason in try await Keystore.deriveIRK(reason: reason) }
    }

    public func load() async {
        phase = .loading
        do {
            let state = try await client.getAccessState(serverDomain: serverDomain, serviceRef: serviceRef)
            restricted = state.isRestricted
            allowCount = state.allowCount
            phase = .ready
            async let people: Void = refreshPeople()
            async let roles: Void = refreshMembers()
            _ = await (people, roles)
        } catch {
            phase = .failed("Couldn't reach the box to load access settings.")
        }
    }

    /// Read the members, their grants and ranks from the box.
    public func refreshMembers() async {
        guard let screens else { return }
        members = try? await screens.appMembers(serviceId: serviceRef)
    }

    /// The rank one row shows (nil until the box has answered).
    public func role(for p: Person) -> AppMemberRole? {
        guard let members else { return nil }
        return AppMemberRole(wire: members.rowRole(inviteId: p.inviteId, boundAID: p.isGroup ? nil : p.boundAID))
    }

    /// "also in Family: Member" for a person who joined through other invites too.
    public func alsoIn(for p: Person) -> String {
        guard let members, !p.isGroup else { return "" }
        let others = members.otherGrants(inviteId: p.inviteId, boundAID: p.boundAID) { id in
            self.people.first { $0.inviteId == id }?.name
        }
        return AppMembersResponse.alsoInText(others)
    }

    /// How many people a members-only switch leaves able to open it.
    public var memberPeopleCount: Int { members?.members.count ?? allowCount }

    /// Rank changes are an admin device's alone; others see ranks read-only.
    public var canChangeRanks: Bool { isAdminDevice }

    /// An admin device may revoke any row; any other device only the member
    /// invites it created itself.
    public func canRemove(_ p: Person) -> Bool {
        if isAdminDevice { return true }
        guard let deviceId, p.creatorTier == "member" else { return false }
        return p.creatorDeviceId?.lowercased() == deviceId
    }

    /// "Invited by <device>" for one row, or nil for rows from before
    /// invites recorded who made them.
    public func invitedBy(for p: Person) -> String? {
        Self.invitedByText(creatorTier: p.creatorTier, creatorDeviceId: p.creatorDeviceId,
                           ownDeviceId: deviceId, names: deviceNames)
    }

    public static func invitedByText(creatorTier: String?, creatorDeviceId: String?,
                                     ownDeviceId: String?, names: [String: String]?) -> String? {
        guard creatorTier != nil || creatorDeviceId != nil else { return nil }
        guard let id = creatorDeviceId?.lowercased(), !id.isEmpty else { return "Invited by another device" }
        if let own = ownDeviceId?.lowercased(), id == own { return "Invited by this device" }
        if let name = names?[id], !name.isEmpty { return "Invited by \(name)" }
        return "Invited by another device"
    }

    /// Sign + send a rank change for one row. Returns whether the box took it.
    @discardableResult
    public func setRole(_ role: AppMemberRole, for p: Person) async -> Bool {
        guard canChangeRanks, let screens, let members, !busyRoles.contains(p.inviteId) else { return false }
        busyRoles.insert(p.inviteId)
        defer { busyRoles.remove(p.inviteId) }
        let target = members.roleTarget(inviteId: p.inviteId, boundAID: p.isGroup ? nil : p.boundAID)
        do {
            try await sendRole(screens: screens, target: target, role: role, reason: "Change \(p.name)'s rank")
            await refreshMembers()
            return true
        } catch {
            phase = .failed("Couldn't change \(p.name)'s rank. Try again in a moment.")
            return false
        }
    }

    private func sendRole(screens: any ScreensClient, target: String, role: AppMemberRole, reason: String) async throws {
        let key = try await roleSigner(reason)
        let order = AppMemberRoleOrder(serverDomain: serverDomain, serviceId: serviceRef, target: target,
                                       role: role.rawValue, issuedAt: now())
        let sig = try key.signature(for: try order.canonicalBytes())
        _ = try await screens.setAppMemberRole(serviceId: serviceRef,
                                               AppMemberRoleRequest(order: order, signature: HexUtil.encode(sig)))
    }

    /// Owner-IRK-sign + POST the mode change. Reverts `restricted` on failure.
    public func setMode(restricted want: Bool) async {
        if busyMode { return }
        busyMode = true
        defer { busyMode = false }
        let mode = want ? "restricted" : "open"
        do {
            let key = try await irkSigner(want
                ? "Make \(serviceRef) members only"
                : "Open \(serviceRef) to all")
            let bytes = try ServiceInvite.canonicalSetAccessMode(
                serverId: serverDomain, serviceRef: serviceRef, mode: mode, issuedAt: now())
            let sig = try ServiceInvite.sign(bytes, with: key)
            let request: [String: Any] = ["serverId": serverDomain, "serviceRef": serviceRef, "mode": mode, "issuedAt": now()]
            _ = try await client.setAccessMode(serverDomain: serverDomain, request: request, signatureHex: HexUtil.encode(sig))
            // The members list never changes with the mode.
            restricted = want
            phase = .ready
        } catch {
            phase = .failed("Couldn't change access. Try again in a moment.")
        }
    }

    /// Mint a capability invite for a new person / group at the chosen tier;
    /// returns the share-link (also stored in `lastInviteLink`). One biometric
    /// at most (see `inviteKeys`). The link carries the author's AID (the friend
    /// derives their per-author contact AID) and — for a MANUAL invite — the
    /// inviteId (so the friend can sign the acceptance).
    @discardableResult
    public func addPerson(name: String, photo: String?, tier: InviteTier = .personalAuto, role: AppMemberRole? = nil) async -> String? {
        if busyAdd { return nil }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        busyAdd = true
        defer { busyAdd = false }
        do {
            let keys = try await inviteKeys("Create an invite for \(serviceRef)")
            let aidPub = keys.aid.publicKey.rawRepresentation
            let bundle = ServiceInvite.Bundle(name: trimmed, photo: photo)
            let secret = randomSecret()
            let secretHash = ServiceInvite.secretHash(secret: secret)
            // v2 §M2: a random 128-bit id (drops the devicePub fingerprint leak).
            let inviteId = ServiceInvite.randomServiceInviteId()
            let encryptedBundle = try ServiceInvite.sealBundle(bundle, householdKey: keys.household, inviteId: inviteId)
            let ts = now()

            var maxN: Int?
            var expiresAt: Int64?
            if case let .group(m, exp) = tier {
                maxN = m
                expiresAt = exp
            }
            let bytes = try ServiceInvite.canonicalCreate(
                inviteId: inviteId, authorAID: aidPub, serviceRef: serviceRef,
                secretHash: secretHash, encryptedBundle: encryptedBundle, issuedAt: ts,
                maxRedemptions: maxN, expiresAt: expiresAt)
            // `authorAID` stays the AID (the link's author key) whoever signs.
            let sig = try ServiceInvite.sign(bytes, with: keys.signer)
            var request: [String: Any] = [
                "inviteId": inviteId,
                "authorAID": HexUtil.encode(aidPub),
                "serviceRef": serviceRef,
                "secretHash": secretHash,
                "encryptedBundle": encryptedBundle,
                "issuedAt": ts,
            ]
            if let maxN { request["maxRedemptions"] = maxN }
            if let expiresAt { request["expiresAt"] = expiresAt }
            // approvalMode is a `.com`-side policy field (NOT in the signed bytes).
            if tier.isManual { request["approvalMode"] = "manual" }
            if let deviceId { request["deviceId"] = deviceId }
            try await client.createInvite(controlBase: controlBase, username: username, request: request, signatureHex: HexUtil.encode(sig))

            // No local create cache: the author's box fetches the signed create
            // from `.com` at manual-finalize, so an invite can be finalized from
            // ANY of the author's devices.

            // The link carries the authorAID always; the inviteId only for manual
            // (the friend needs it to sign the out-of-band acceptance).
            let link = ServiceInviteLinks.inviteLink(
                serverDomain: serverDomain, secretHex: HexUtil.encode(secret),
                authorAidHex: HexUtil.encode(aidPub),
                inviteId: tier.isManual ? inviteId : nil,
                serviceRef: serviceRef)
            lastInviteLink = link
            lastInviteTier = tier
            roleNotice = nil
            // The rank rides a signed order right after the create; the app's
            // default rank needs none, and a member invite stays at Member.
            if isAdminDevice, let role, let screens, role.rawValue != members?.defaultRole {
                do {
                    try await sendRole(screens: screens, target: AppMemberRoleOrder.inviteTarget(inviteId),
                                       role: role, reason: "Give \(trimmed) a rank")
                } catch {
                    roleNotice = "Created, but couldn't set the rank. Change it in the list."
                }
            }
            async let people: Void = refreshPeople()
            async let roles: Void = refreshMembers()
            _ = await (people, roles)
            return link
        } catch {
            phase = .failed("Couldn't create the invite. Try again in a moment.")
            return nil
        }
    }

    /// Remove a person / group: a signed revoke on `.com` (records the
    /// revocation) AND — for each bound AID — an owner-IRK prune from the box's
    /// allow-list. The box allow-list is add-only, so a `.com` revoke alone never
    /// reaches it: a redeemed friend (or every group member) would keep access
    /// without the prune. For a GROUP, EVERY bound AID is pruned in one op. A
    /// failure of any leg surfaces — losing a box prune silently would leave a
    /// friend with live access.
    public func remove(inviteId: String) async {
        let person = people.first(where: { $0.inviteId == inviteId })
        if let person, !canRemove(person) { return }
        // AIDs to prune from the box: a group's whole set, else the single bind
        // — only those for whom this was their last grant. Someone who also
        // holds another invite keeps it: the box drops just this grant when
        // its revocation poller sees the `.com` revoke.
        var aids: [String] = person?.groupBoundAIDs ?? []
        if aids.isEmpty, let single = person?.boundAID, !single.isEmpty { aids = [single] }
        if let members { aids = members.aidsToPrune(inviteId: inviteId, aids: aids) }

        var revokeFailed = false
        var pruneFailed = false

        // `.com` revoke: the admin root, or the AID that created a member invite.
        do {
            let reason = "Remove this person from \(serviceRef)"
            let revokeSignKey = isAdminDevice
                ? try await adminSigner(reason)
                : try await authorAidKeys(reason).aid
            let ts = now()
            let bytes = try ServiceInvite.canonicalRevoke(inviteId: inviteId, issuedAt: ts)
            let sig = try ServiceInvite.sign(bytes, with: revokeSignKey)
            let request: [String: Any] = ["inviteId": inviteId, "issuedAt": ts]
            try await client.revokeInvite(controlBase: controlBase, username: username, inviteId: inviteId, request: request, signatureHex: HexUtil.encode(sig))
        } catch {
            revokeFailed = true
        }

        // Box prune of each bound AID (owner-IRK signed — the box pins the IRK).
        if !aids.isEmpty {
            do {
                let key = try await irkSigner("Revoke access to \(serviceRef)")
                for aid in aids {
                    let ts = now()
                    let bytes = try ServiceInvite.canonicalRemoveServiceAllow(
                        serverId: serverDomain, serviceRef: serviceRef, aid: aid, issuedAt: ts)
                    let sig = try ServiceInvite.sign(bytes, with: key)
                    let request: [String: Any] = ["serverId": serverDomain, "serviceRef": serviceRef, "aid": aid.lowercased(), "issuedAt": ts]
                    _ = try await client.removeServiceAllow(serverDomain: serverDomain, request: request, signatureHex: HexUtil.encode(sig))
                }
            } catch {
                pruneFailed = true
            }
        }

        async let refreshed: Void = refreshPeople()
        async let roles: Void = refreshMembers()
        _ = await (refreshed, roles)
        if pruneFailed {
            phase = .failed("Removed from the directory, but couldn't reach the box to revoke access. Try again so they're fully removed.")
        } else if revokeFailed {
            phase = .failed("Couldn't remove them. Try again in a moment.")
        }
    }

    /// List the author's live invites for this service from `.com` (OWNER-SIGNED
    /// query, v2 §C2), decrypting each bundle locally with the household key. A
    /// GROUP invite renders as ONE row carrying its whole bound set + cap.
    public func refreshPeople() async {
        do {
            let keys = try await authorAidKeys("Show the members of \(serviceRef)")
            let aidPubHex = HexUtil.encode(keys.aid.publicKey.rawRepresentation)
            let ts = now()
            // OWNER-SIGNED list query (scope "list", cursor 0).
            let qBytes = try ServiceInvite.canonicalListQuery(
                username: username, authorAID: aidPubHex, scope: "list", cursor: 0, issuedAt: ts)
            let qSig = try ServiceInvite.sign(qBytes, with: keys.aid)
            let query: [String: String] = [
                "authorAID": aidPubHex,
                "scope": "list",
                "cursor": "0",
                "issuedAt": String(ts),
            ]
            let rows = try await client.listInvites(
                controlBase: controlBase, username: username, query: query, signatureHex: HexUtil.encode(qSig))
            people = rows
                .filter { $0.serviceRef == serviceRef && $0.revokedAt == nil }
                .map { row in
                    var name = "unknown"
                    var photo: String?
                    if let b = try? ServiceInvite.openBundle(row.encryptedBundleHex, householdKey: keys.household, inviteId: row.inviteId) {
                        name = b.name
                        photo = b.photo
                    }
                    let groupAids = row.isGroup ? (row.boundAidsHex.isEmpty ? (row.boundAidHex.map { [$0] } ?? []) : row.boundAidsHex) : []
                    let bound = row.boundAidHex != nil || !row.boundAidsHex.isEmpty
                    return Person(
                        inviteId: row.inviteId,
                        name: name,
                        photo: photo,
                        bound: bound,
                        boundAID: row.boundAidHex,
                        groupBoundAIDs: groupAids,
                        groupMax: row.maxRedemptions,
                        manual: row.approvalMode == "manual",
                        creatorTier: row.creatorTier,
                        creatorDeviceId: row.creatorDeviceId)
                }
            if deviceNames == nil, people.contains(where: { $0.creatorDeviceId != nil }) {
                deviceNames = await loadDeviceNames()
            }
        } catch {
            // Keep the last-known list; the load-phase error is already surfaced.
        }
    }

    public func clearLink() { lastInviteLink = nil; lastInviteTier = nil }

    /// The AID + household for a create, and the key that signs it: on an
    /// admin device the admin root, asked for first so its one prompt also
    /// opens the session's account keys and the AID costs no second one.
    private func inviteKeys(_ reason: String) async throws
        -> (aid: Curve25519.Signing.PrivateKey, household: Data, signer: Curve25519.Signing.PrivateKey) {
        guard isAdminDevice else {
            let k = try await authorAidKeys(reason)
            return (k.aid, k.household, k.aid)
        }
        let root = try await adminSigner(reason)
        let k = try await authorAidKeys(reason)
        return (k.aid, k.household, root)
    }

    private func randomSecret() -> Data {
        var d = Data(count: 32)
        d.withUnsafeMutableBytes { _ = SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        return d
    }
}
