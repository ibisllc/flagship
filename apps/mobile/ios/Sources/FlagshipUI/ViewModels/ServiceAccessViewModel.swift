import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// One app's "Access control" (docs/service-access-gating.md, "Open mode +
/// members" and "Account members, ranks and who may change them"; the toggle
/// and the members list are independent):
///   - reads the TRUE mode from the box (`GET /api/service-access/<ref>`) and
///     sets it with a `flagship/service-access-mode/v2` order,
///   - reads the account's devices and co-managers, the invited people, their
///     grants and ranks from the box (owner session) and changes a rank with a
///     signed `flagship/app-rank/v1` order,
///   - manages the invites across the THREE tiers (personal auto / personal
///     manual / group multi-use): add (seal the bundle under the household
///     key → sign the create → POST `.com` → return the
///     `https://<server>/invite#<secret>&a=<authorAID>[&i=…]&s=<ref>` link),
///     list (an AID-signed `.com` query; decrypt the bundle locally; group =
///     one "label — k/N" row), and withdraw (the signed revoke on `.com` and
///     the same revoke on the box, which drops who joined through it).
///
/// Who may change what is the box's call; this mirrors it. An admin device
/// (it holds the admin root) signs every order with the admin root behind
/// one Face ID per order: invites at any rank, rank changes and refusals,
/// the mode, removals, withdrawing any invite. Another device whose own rank
/// in the app is Manager or Master invites at Member and withdraws only the
/// invites it made, signing with its account device key; below that it
/// can't invite.
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
        /// nil for an unredeemed invite.
        public let boundAID: String?
        /// GROUP rows: every bound AID (a group is a labeled set). Empty for a
        /// personal invite.
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
        /// Made by someone the server is shared with (`.com` says `co-manager`).
        public var isCoManagers: Bool { creatorTier == AppInviteTier.coManager.rawValue }
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

    /// No account device key to sign with (no device id on this profile).
    public struct NoDeviceKey: Error {}

    /// Why a non-admin device's rank picker is locked to Member.
    public static let memberOnlyReason = "Only an admin device can give a higher rank"
    /// Why a device below Manager in the app gets no "+ Add".
    public static let cantInviteReason = "Only an admin can let you invite people to this app."
    /// Why the mode toggle is read-only on a non-admin device.
    public static let modeAdminOnly = "Only an admin device can change who may open it."

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
    /// The box's account members, members, grants and ranks; nil until read
    /// (or when it can't be).
    public private(set) var members: AppMembersResponse?
    /// Invite rows whose rank change is being signed / sent (by inviteId).
    public private(set) var busyRoles: Set<String> = []
    /// Account rows whose rank change is being signed / sent (by row id).
    public private(set) var busyAccount: Set<String> = []
    /// Set when an invite was created but its rank couldn't be set.
    public private(set) var roleNotice: String?
    /// This account's device names (decrypted on the phone), nil until read
    /// or when this device can't read the directory.
    public private(set) var deviceNames: [String: String]?
    /// This device's account device key (public, lowercase hex), once known.
    public private(set) var ownDevicePub: String?

    /// Does this device hold the account's admin root?
    public let isAdminDevice: Bool
    /// This device's account device id.
    public let deviceId: String?

    private let client: any ServiceAccessClient
    private let serverDomain: String
    private let serviceRef: String
    private let username: String
    private let controlBase: URL
    /// One-biometric author bundle: (AID, household key). The AID is the
    /// link's author key and signs the list query; the household decrypts the
    /// listed bundles.
    private let authorAidKeys: @MainActor (String) async throws -> (aid: Curve25519.Signing.PrivateKey, household: Data)
    /// The box's owner-session API (members + ranks); nil ⇒ no ranks shown.
    private let screens: (any ScreensClient)?
    /// The admin root, on an admin device, behind a prompt that also opens
    /// the session's account keys, so the AID that follows costs none.
    private let adminSigner: AppAccessSigner
    /// This device's account device key (non-admin creates and withdrawals).
    private let deviceSigner: AppAccessSigner
    /// The account device key when it is at hand without a prompt.
    private let ownDeviceKey: @MainActor () -> Curve25519.Signing.PrivateKey?
    private let loadDeviceNames: @MainActor () async -> [String: String]?
    private let now: () -> Int64

    public init(
        client: any ServiceAccessClient,
        serverDomain: String,
        serviceRef: String,
        username: String,
        controlBase: URL = Endpoints.controlBaseUrl,
        authorAidKeys: (@MainActor (String) async throws -> (aid: Curve25519.Signing.PrivateKey, household: Data))? = nil,
        screens: (any ScreensClient)? = nil,
        isAdminDevice: Bool? = nil,
        adminSigner: AppAccessSigner? = nil,
        deviceId: String? = nil,
        deviceSigner: AppAccessSigner? = nil,
        ownDeviceKey: (@MainActor () -> Curve25519.Signing.PrivateKey?)? = nil,
        deviceNames: (@MainActor () async -> [String: String]?)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        let device = deviceId?.lowercased()
        self.screens = screens
        self.isAdminDevice = isAdminDevice ?? Keystore.hasAdminRoot
        self.adminSigner = adminSigner ?? { reason in try await ServerOrderSaver.sensitiveOrderKey(reason: reason) }
        self.deviceId = device
        self.deviceSigner = deviceSigner ?? { reason in
            guard let device else { throw NoDeviceKey() }
            return try await Keystore.deriveAccountDeviceKey(accountId: username, deviceId: device, reason: reason)
        }
        self.ownDeviceKey = ownDeviceKey ?? {
            device.flatMap { Keystore.sessionAccountDeviceKey(accountId: username, deviceId: $0) }
        }
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
            noteOwnDeviceKey(ownDeviceKey())
            await loadNamesIfNeeded()
        } catch {
            phase = .failed("Couldn't reach the server to load access settings.")
        }
    }

    /// Read the account members, the members, their grants and ranks from the box.
    public func refreshMembers() async {
        guard let screens else { return }
        members = try? await screens.appMembers(serviceId: serviceRef)
    }

    // MARK: who this device is in the app

    /// This device's row in Account members.
    public var me: AppAccountMember? { members?.me(devicePub: ownDevicePub, deviceId: deviceId) }

    /// This device's rank in the app; nil when refused or not known yet.
    public var myRank: AppMemberRole? { me?.role }

    /// "+ Add person / group": an admin device, or a device that is Manager
    /// or Master in this app (it invites at Member).
    public var canInvite: Bool {
        if isAdminDevice { return true }
        return deviceId != nil && myRank?.isManagerClass == true
    }

    /// The one line shown instead of "+ Add" (nil while the box hasn't answered).
    public var inviteBlockedReason: String? {
        guard !canInvite, members != nil else { return nil }
        return Self.cantInviteReason
    }

    /// Rank changes, refusals, the mode and removing others are an admin
    /// device's alone; others see them read-only.
    public var canChangeRanks: Bool { isAdminDevice }
    public var canChangeMode: Bool { isAdminDevice }

    /// An admin device may withdraw any invite; another device only the ones
    /// it made, while it is Manager or Master in the app.
    public func canRemove(_ p: Person) -> Bool {
        if isAdminDevice { return true }
        return canInvite && createdHere(p)
    }

    private func createdHere(_ p: Person) -> Bool {
        let box = members?.invite(p.inviteId)
        if p.isCoManagers || box?.tier == AppInviteTier.coManager.rawValue { return false }
        if let pub = ownDevicePub, let creator = box?.creatorPub?.lowercased() { return creator == pub }
        if let deviceId, let creator = box?.creatorDeviceId?.lowercased() { return creator == deviceId }
        guard let deviceId, p.creatorTier == "member" else { return false }
        return p.creatorDeviceId?.lowercased() == deviceId
    }

    public func isThisDevice(_ a: AppAccountMember) -> Bool {
        guard a.isDevice, let me else { return false }
        return me.id == a.id
    }

    /// A device's name from the decrypted directory (else "Device" and a short
    /// id), or a co-manager's label as the server owner gave it.
    public func accountName(_ a: AppAccountMember) -> String {
        if a.isDevice {
            if let id = a.deviceId?.lowercased(), let name = deviceNames?[id], !name.isEmpty { return name }
            let short = (a.deviceId ?? a.devicePub ?? "").prefix(6).uppercased()
            return short.isEmpty ? "Device" : "Device \(short)"
        }
        if let label = a.label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty { return label }
        return "Shared account"
    }

    public func accountDetail(_ a: AppAccountMember) -> String {
        guard a.isDevice else { return "Co-manages this server" }
        let kind = a.isAdminDevice ? "Admin device" : "Device"
        return isThisDevice(a) ? "\(kind) · This device" : kind
    }

    /// "Invited by <device>" for one row, or nil for rows from before
    /// invites recorded who made them.
    public func invitedBy(for p: Person) -> String? {
        let box = members?.invite(p.inviteId)
        let tier = p.isCoManagers || box?.tier == AppInviteTier.coManager.rawValue ? AppInviteTier.coManager.rawValue : p.creatorTier
        return Self.invitedByText(creatorTier: tier, creatorDeviceId: p.creatorDeviceId,
                                  ownDeviceId: deviceId, names: deviceNames, creatorLabel: box?.creatorLabel)
    }

    /// A co-manager's invitee is named under their key, which this account can't open.
    public static let coManagersInvitee = "Someone they invited"

    public static func invitedByText(creatorTier: String?, creatorDeviceId: String?,
                                     ownDeviceId: String?, names: [String: String]?,
                                     creatorLabel: String? = nil) -> String? {
        if creatorTier == AppInviteTier.coManager.rawValue {
            if let label = creatorLabel, !label.isEmpty { return "Invited by \(label) (co-manager)" }
            return "Invited by a co-manager"
        }
        guard creatorTier != nil || creatorDeviceId != nil else { return nil }
        guard let id = creatorDeviceId?.lowercased(), !id.isEmpty else { return "Invited by another device" }
        if let own = ownDeviceId?.lowercased(), id == own { return "Invited by this device" }
        if let name = names?[id], !name.isEmpty { return "Invited by \(name)" }
        return "Invited by another device"
    }

    /// The rank one invited row shows (nil until the box has answered).
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

    // MARK: ranks

    /// Sign + send a rank change for one invited row. Returns whether the box took it.
    @discardableResult
    public func setRole(_ role: AppMemberRole, for p: Person) async -> Bool {
        guard canChangeRanks, screens != nil, let members, !busyRoles.contains(p.inviteId) else { return false }
        busyRoles.insert(p.inviteId)
        defer { busyRoles.remove(p.inviteId) }
        let target = members.roleTarget(inviteId: p.inviteId, boundAID: p.isGroup ? nil : p.boundAID)
        do {
            try await sendRank(target: target, rank: AppRankValue(role), reason: "Change \(p.name)'s rank")
            await refreshMembers()
            return true
        } catch {
            phase = .failed("Couldn't change \(p.name)'s rank. Try again in a moment.")
            return false
        }
    }

    /// Give one of the account's devices or a co-manager a rank, or refuse
    /// them in this app. One admin-root signature.
    @discardableResult
    public func setAccountRank(_ rank: AppRankValue, for a: AppAccountMember) async -> Bool {
        guard canChangeRanks, screens != nil, let target = a.rankTarget, !busyAccount.contains(a.id) else { return false }
        busyAccount.insert(a.id)
        defer { busyAccount.remove(a.id) }
        let name = accountName(a)
        do {
            try await sendRank(target: target, rank: rank,
                               reason: rank == .refused ? "Refuse \(name) in \(serviceRef)" : "Change \(name)'s rank")
            await refreshMembers()
            return true
        } catch {
            phase = .failed(rank == .refused
                ? "Couldn't refuse \(name). Try again in a moment."
                : "Couldn't change \(name)'s rank. Try again in a moment.")
            return false
        }
    }

    /// One admin-root prompt; a 409 (a newer order landed first) re-signs
    /// once with the same key.
    private func sendRank(target: String, rank: AppRankValue, reason: String) async throws {
        guard let screens else { return }
        let key = try await adminSigner(reason)
        var issuedAt = now()
        for attempt in 0..<2 {
            let order = AppRankOrder(serviceRef: serviceRef, target: target, rank: rank.rawValue, issuedAt: issuedAt)
            let sig = try key.signature(for: try order.canonicalBytes())
            do {
                _ = try await screens.setAppRank(serviceId: serviceRef,
                                                 AppRankRequest(order: order, signature: HexUtil.encode(sig)))
                return
            } catch ScreensClientError.http(let status, _) where status == 409 && attempt == 0 {
                issuedAt = max(now(), issuedAt + 1)
            }
        }
    }

    // MARK: mode

    /// Admin-root-sign + POST the mode change. Reverts `restricted` on failure.
    public func setMode(restricted want: Bool) async {
        if busyMode || !canChangeMode { return }
        busyMode = true
        defer { busyMode = false }
        do {
            let key = try await adminSigner(want ? "Make \(serviceRef) members only" : "Open \(serviceRef) to all")
            let order = ServiceAccessModeOrder(serviceRef: serviceRef, restricted: want, issuedAt: now())
            let sig = try key.signature(for: try order.canonicalBytes())
            _ = try await client.setAccessMode(serverDomain: serverDomain, request: order.request,
                                               signatureHex: HexUtil.encode(sig))
            // The members list never changes with the mode.
            restricted = want
            phase = .ready
        } catch {
            phase = .failed("Couldn't change access. Try again in a moment.")
        }
    }

    // MARK: invites

    /// Mint a capability invite for a new person / group at the chosen tier;
    /// returns the share-link (also stored in `lastInviteLink`). One biometric
    /// at most (see `inviteKeys`). The link carries the author's AID and — for
    /// a MANUAL invite — the inviteId (so the friend can sign the acceptance).
    @discardableResult
    public func addPerson(name: String, photo: String?, tier: InviteTier = .personalAuto, role: AppMemberRole? = nil) async -> String? {
        if busyAdd { return nil }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard canInvite else {
            phase = .failed(Self.cantInviteReason)
            return nil
        }
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
            if isAdminDevice, let role, screens != nil, role.rawValue != members?.defaultRole {
                do {
                    try await sendRank(target: AppRankOrder.inviteTarget(inviteId), rank: AppRankValue(role),
                                       reason: "Give \(trimmed) a rank")
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

    /// Withdraw a person / group: the signed revoke on `.com` (no one new gets
    /// in) and the same revoke on the box, which drops everyone who joined
    /// through it unless they hold another invite. An admin also removes
    /// people the box lists without a grant for it (they joined before grants
    /// were tracked). One signature for all of it. A failure of any leg
    /// surfaces: a lost box leg would leave someone with live access.
    public func remove(inviteId: String) async {
        let person = people.first(where: { $0.inviteId == inviteId })
        if let person, !canRemove(person) { return }
        var aids: [String] = person?.groupBoundAIDs ?? []
        if aids.isEmpty, let single = person?.boundAID, !single.isEmpty { aids = [single] }
        let legacy: [String] = isAdminDevice ? aids.filter { aid in
            guard let m = members?.member(aid) else { return false }
            return !m.grants.contains { $0.inviteId == inviteId }
        } : []

        let reason = "Remove this person from \(serviceRef)"
        let key: Curve25519.Signing.PrivateKey
        do {
            key = isAdminDevice ? try await adminSigner(reason) : try await deviceSigner(reason)
        } catch {
            phase = .failed("Couldn't remove them. Try again in a moment.")
            return
        }
        if !isAdminDevice { noteOwnDeviceKey(key) }

        var revokeFailed = false
        var boxFailed = false
        let ts = now()
        let revoke: [String: Any] = ["inviteId": inviteId, "issuedAt": ts]
        var sigHex = ""
        do {
            let sig = try ServiceInvite.sign(try ServiceInvite.canonicalRevoke(inviteId: inviteId, issuedAt: ts), with: key)
            sigHex = HexUtil.encode(sig)
            try await client.revokeInvite(controlBase: controlBase, username: username, inviteId: inviteId,
                                          request: revoke, signatureHex: sigHex)
        } catch {
            revokeFailed = true
        }

        if !aids.isEmpty, !sigHex.isEmpty {
            do {
                _ = try await client.withdrawInvite(serverDomain: serverDomain, revoke: revoke, signatureHex: sigHex)
                for aid in legacy {
                    let order = ServiceAllowRemoveOrder(serviceRef: serviceRef, aid: aid.lowercased(), issuedAt: now())
                    let sig = try key.signature(for: try order.canonicalBytes())
                    _ = try await client.removeServiceAllow(serverDomain: serverDomain, request: order.request,
                                                            signatureHex: HexUtil.encode(sig))
                }
            } catch {
                boxFailed = true
            }
        }

        async let refreshed: Void = refreshPeople()
        async let roles: Void = refreshMembers()
        _ = await (refreshed, roles)
        if boxFailed {
            phase = .failed("Removed from the directory, but couldn't reach the server to revoke access. Try again so they're fully removed.")
        } else if revokeFailed {
            phase = .failed("Couldn't remove them. Try again in a moment.")
        }
    }

    /// List the author's live invites for this service from `.com` (an
    /// AID-signed query, v2 §C2), decrypting each bundle locally with the
    /// household key. A GROUP invite renders as ONE row carrying its whole
    /// bound set + cap.
    public func refreshPeople() async {
        do {
            let keys = try await authorAidKeys("Show the members of \(serviceRef)")
            let aidPubHex = HexUtil.encode(keys.aid.publicKey.rawRepresentation)
            let ts = now()
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
                    var name = row.creatorTier == AppInviteTier.coManager.rawValue ? Self.coManagersInvitee : "unknown"
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
        } catch {
            // Keep the last-known list; the load-phase error is already surfaced.
        }
    }

    public func clearLink() { lastInviteLink = nil; lastInviteTier = nil }

    private func loadNamesIfNeeded() async {
        guard deviceNames == nil else { return }
        let wanted = people.contains { $0.creatorDeviceId != nil } || members?.account.contains(where: \.isDevice) == true
        if wanted { deviceNames = await loadDeviceNames() }
    }

    private func noteOwnDeviceKey(_ key: Curve25519.Signing.PrivateKey?) {
        guard ownDevicePub == nil, let key else { return }
        ownDevicePub = HexUtil.encode(key.publicKey.rawRepresentation)
    }

    /// The AID + household for a create, and the key that signs it: on an
    /// admin device the admin root, asked for first so its one prompt also
    /// opens the session's account keys; elsewhere the account device key,
    /// which the AID's unlock already makes free.
    private func inviteKeys(_ reason: String) async throws
        -> (aid: Curve25519.Signing.PrivateKey, household: Data, signer: Curve25519.Signing.PrivateKey) {
        guard isAdminDevice else {
            let k = try await authorAidKeys(reason)
            let device = try await deviceSigner(reason)
            noteOwnDeviceKey(device)
            return (k.aid, k.household, device)
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
