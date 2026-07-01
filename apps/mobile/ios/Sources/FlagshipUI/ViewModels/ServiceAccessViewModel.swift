import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Admin orchestrator for per-service access gating (docs/service-access-gating.md,
/// "## v2 hardening").
///
/// On the server-detail "Who can open this" surface:
///   - reads the TRUE mode from the box (`GET /api/service-access/<ref>`),
///   - toggles open ⇄ restricted with an owner-IRK `set-service-access-mode`
///     envelope to the box's pinned pipe,
///   - manages the allow-list across the THREE invite tiers (personal auto /
///     personal manual / group multi-use): add a person/group (seal the bundle
///     under the household key → **AID-sign** the create → POST `.com` → return
///     the `https://<server>/invite#<secret>&a=<authorAID>[&i=…]` link),
///     list (an OWNER-SIGNED `.com` query; decrypt the bundle locally; group =
///     one "label — k/N" row), and remove (**AID-signed** revoke on `.com` + an
///     owner-IRK prune of each bound AID on the box).
///
/// v2 signing: the author signs create / revoke / the listing with the STABLE
/// **AID** (so the box-as-authority verifies against the owner key across IRK
/// rotations; `.com` dual-accepts AID|IRK). The box's mode toggle + allow-remove
/// stay owner-**IRK** signed (the box pins the owner IRK). The friend's recorded
/// identity is their PER-AUTHOR contact AID.
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
        public var id: String { inviteId }
        public var isGroup: Bool { groupMax != nil }
        public init(inviteId: String, name: String, photo: String?, bound: Bool, boundAID: String?, groupBoundAIDs: [String] = [], groupMax: Int? = nil, manual: Bool = false) {
            self.inviteId = inviteId
            self.name = name
            self.photo = photo
            self.bound = bound
            self.boundAID = boundAID
            self.groupBoundAIDs = groupBoundAIDs
            self.groupMax = groupMax
            self.manual = manual
        }
    }

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
    private let now: () -> Int64

    public init(
        client: any ServiceAccessClient,
        serverDomain: String,
        serviceRef: String,
        username: String,
        controlBase: URL = Endpoints.controlBaseUrl,
        authorAidKeys: (@MainActor (String) async throws -> (aid: Curve25519.Signing.PrivateKey, household: Data))? = nil,
        irkSigner: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
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
            if restricted { await refreshPeople() }
        } catch {
            phase = .failed("Couldn't reach the box to load access settings.")
        }
    }

    /// Owner-IRK-sign + POST the mode change. Reverts `restricted` on failure.
    public func setMode(restricted want: Bool) async {
        if busyMode { return }
        busyMode = true
        defer { busyMode = false }
        let mode = want ? "restricted" : "open"
        do {
            let key = try await irkSigner(want
                ? "Restrict \(serviceRef) to your allow-list"
                : "Open \(serviceRef) to anyone with the link")
            let bytes = try ServiceInvite.canonicalSetAccessMode(
                serverId: serverDomain, serviceRef: serviceRef, mode: mode, issuedAt: now())
            let sig = try ServiceInvite.sign(bytes, with: key)
            let request: [String: Any] = ["serverId": serverDomain, "serviceRef": serviceRef, "mode": mode, "issuedAt": now()]
            _ = try await client.setAccessMode(serverDomain: serverDomain, request: request, signatureHex: HexUtil.encode(sig))
            restricted = want
            if want { await refreshPeople() } else { people = [] }
        } catch {
            phase = .failed("Couldn't change who can open this. Try again in a moment.")
        }
    }

    /// Mint a capability invite for a new person / group at the chosen tier;
    /// returns the share-link (also stored in `lastInviteLink`). One biometric
    /// (author AID + household). The link carries the author's AID (the friend
    /// derives their per-author contact AID) and — for a MANUAL invite — the
    /// inviteId (so the friend can sign the acceptance).
    @discardableResult
    public func addPerson(name: String, photo: String?, tier: InviteTier = .personalAuto) async -> String? {
        if busyAdd { return nil }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        busyAdd = true
        defer { busyAdd = false }
        do {
            let keys = try await authorAidKeys("Create an invite for \(serviceRef)")
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
            // Slice D (D-2) — service-invite CREATE is SENSITIVE (admin-gated).
            // Sign with the admin master root when this device holds one; else
            // AID (the legacy dual-accept path `.com`/box still honor when no
            // admin root is pinned). The `authorAID` field stays the AID (the
            // recorded inviter identity + the link's author key) — only the
            // signing key changes; canonical bytes are unchanged.
            let createSignKey: Curve25519.Signing.PrivateKey = Keystore.hasAdminRoot
                ? try await Keystore.adminRootKey(reason: "Create an invite for \(serviceRef)")
                : keys.aid
            let sig = try ServiceInvite.sign(bytes, with: createSignKey)
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
            try await client.createInvite(controlBase: controlBase, username: username, request: request, signatureHex: HexUtil.encode(sig))

            // No local create cache: the author's box fetches the signed create
            // from `.com` at manual-finalize, so an invite can be finalized from
            // ANY of the author's devices.

            // The link carries the authorAID always; the inviteId only for manual
            // (the friend needs it to sign the out-of-band acceptance).
            let link = ServiceInviteLinks.inviteLink(
                serverDomain: serverDomain, secretHex: HexUtil.encode(secret),
                authorAidHex: HexUtil.encode(aidPub),
                inviteId: tier.isManual ? inviteId : nil)
            lastInviteLink = link
            lastInviteTier = tier
            await refreshPeople()
            return link
        } catch {
            phase = .failed("Couldn't create the invite. Try again in a moment.")
            return nil
        }
    }

    /// Remove a person / group: AID-signed revoke on `.com` (records the
    /// revocation) AND — for each bound AID — an owner-IRK prune from the box's
    /// allow-list. The box allow-list is add-only, so a `.com` revoke alone never
    /// reaches it: a redeemed friend (or every group member) would keep access
    /// without the prune. For a GROUP, EVERY bound AID is pruned in one op. A
    /// failure of any leg surfaces — losing a box prune silently would leave a
    /// friend with live access.
    public func remove(inviteId: String) async {
        let person = people.first(where: { $0.inviteId == inviteId })
        // AIDs to prune from the box: a group's whole set, else the single bind.
        var aids: [String] = person?.groupBoundAIDs ?? []
        if aids.isEmpty, let single = person?.boundAID, !single.isEmpty { aids = [single] }

        var revokeFailed = false
        var pruneFailed = false

        // `.com` revoke (AID-signed; records the revocation / what the directory shows).
        do {
            let aidKey = try await authorAidKeys("Remove this person from \(serviceRef)").aid
            let ts = now()
            let bytes = try ServiceInvite.canonicalRevoke(inviteId: inviteId, issuedAt: ts)
            // Slice D (D-2) — service-invite REVOKE is SENSITIVE (admin-gated):
            // admin master root when present, else the legacy AID.
            let revokeSignKey: Curve25519.Signing.PrivateKey = Keystore.hasAdminRoot
                ? try await Keystore.adminRootKey(reason: "Remove this person from \(serviceRef)")
                : aidKey
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

        await refreshPeople()
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
            let keys = try await authorAidKeys("Show who can open \(serviceRef)")
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
                        manual: row.approvalMode == "manual")
                }
        } catch {
            // Keep the last-known list; the load-phase error is already surfaced.
        }
    }

    public func clearLink() { lastInviteLink = nil; lastInviteTier = nil }

    private func randomSecret() -> Data {
        var d = Data(count: 32)
        d.withUnsafeMutableBytes { _ = SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        return d
    }
}
