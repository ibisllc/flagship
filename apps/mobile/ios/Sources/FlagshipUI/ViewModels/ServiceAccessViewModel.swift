import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Admin orchestrator for per-service access gating (docs/service-access-gating.md).
///
/// On the server-detail "Who can open this" surface:
///   - reads the TRUE mode from the box (`GET /api/service-access/<ref>`),
///   - toggles open ⇄ restricted with an owner-IRK `set-service-access-mode`
///     envelope to the box's pinned pipe,
///   - manages the allow-list: add a person (name + optional photo → seal the
///     bundle under the household key → IRK-sign the create → POST `.com` →
///     return the `https://<server>.<user>/invite#<secret>` share-link), list
///     (decrypt the bundle locally for name/photo, bound vs invite-sent), and
///     remove (IRK-signed revoke → drops the friend's access).
///
/// The author IRK signs create/revoke; the friend's STABLE AID is the recorded
/// principal. `.com` stores only ciphertext + the secretHash (no UMK, no
/// secret) — it cannot read the friend's name/photo.
@Observable
@MainActor
public final class ServiceAccessViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case failed(String)
    }

    public struct Person: Equatable, Sendable, Identifiable {
        public let inviteId: String
        public let name: String
        public let photo: String?
        public let bound: Bool
        /// The friend's allow-listed AID (lowercase hex) once they've redeemed;
        /// nil for an unredeemed invite. Drives the box-side prune on remove.
        public let boundAID: String?
        public var id: String { inviteId }
    }

    public private(set) var phase: Phase = .idle
    public private(set) var restricted = false
    public private(set) var allowCount = 0
    public private(set) var people: [Person] = []
    /// Set after a successful create so the screen can surface the share-link.
    public private(set) var lastInviteLink: String?

    public var busyMode = false
    public var busyAdd = false

    private let client: any ServiceAccessClient
    private let serverDomain: String
    private let serviceRef: String
    private let username: String
    private let controlBase: URL
    /// One-biometric author bundle: (IRK signer, AID pub, household key).
    private let authorKeys: @MainActor (String) async throws -> (irk: Curve25519.Signing.PrivateKey, aidPub: Data, household: Data)
    /// IRK-only signer (revoke + mode toggle).
    private let irkSigner: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    /// AID pub + household for the read path (decrypt the listed bundles).
    private let readKeys: @MainActor (String) async throws -> (aidPub: Data, household: Data)
    private let now: () -> Int64
    private let counter: () -> Int

    public init(
        client: any ServiceAccessClient,
        serverDomain: String,
        serviceRef: String,
        username: String,
        controlBase: URL = Endpoints.controlBaseUrl,
        authorKeys: (@MainActor (String) async throws -> (irk: Curve25519.Signing.PrivateKey, aidPub: Data, household: Data))? = nil,
        irkSigner: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        readKeys: (@MainActor (String) async throws -> (aidPub: Data, household: Data))? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        counter: (() -> Int)? = nil
    ) {
        self.client = client
        self.serverDomain = serverDomain
        self.serviceRef = serviceRef
        self.username = username
        self.controlBase = controlBase
        self.now = now
        self.authorKeys = authorKeys ?? { reason in
            let k = try await Keystore.deriveInviteAuthorKeys(reason: reason)
            return (k.irk, k.aidPub, k.household)
        }
        self.irkSigner = irkSigner ?? { reason in try await Keystore.deriveIRK(reason: reason) }
        self.readKeys = readKeys ?? { reason in
            // One biometric → both the AID pub and the household key.
            try await Keystore.deriveAidPubAndHousehold(reason: reason)
        }
        self.counter = counter ?? ServiceInviteCounter.next
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
            // Surface but keep the prior state — the screen re-reads `restricted`.
            phase = .failed("Couldn't change who can open this. Try again in a moment.")
        }
    }

    /// Mint a capability invite for a new person; returns the share-link (also
    /// stored in `lastInviteLink`). One biometric (author IRK + AID + household).
    @discardableResult
    public func addPerson(name: String, photo: String?) async -> String? {
        if busyAdd { return nil }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        busyAdd = true
        defer { busyAdd = false }
        do {
            let keys = try await authorKeys("Create an invite for \(serviceRef)")
            let bundle = ServiceInvite.Bundle(name: trimmed, photo: photo)
            let secret = randomSecret()
            let secretHash = ServiceInvite.secretHash(secret: secret)
            guard let inviteId = ServiceInvite.inviteId(
                authorAidPub: keys.aidPub,
                authorDevicePub: keys.irk.publicKey.rawRepresentation,
                counter: counter()) else {
                phase = .failed("Couldn't prepare the invite.")
                return nil
            }
            let encryptedBundle = try ServiceInvite.sealBundle(bundle, householdKey: keys.household, inviteId: inviteId)
            let ts = now()
            let bytes = try ServiceInvite.canonicalCreate(
                inviteId: inviteId, authorAID: keys.aidPub, serviceRef: serviceRef,
                secretHash: secretHash, encryptedBundle: encryptedBundle, issuedAt: ts)
            let sig = try ServiceInvite.sign(bytes, with: keys.irk)
            let request: [String: Any] = [
                "inviteId": inviteId,
                "authorAID": HexUtil.encode(keys.aidPub),
                "serviceRef": serviceRef,
                "secretHash": secretHash,
                "encryptedBundle": encryptedBundle,
                "issuedAt": ts,
            ]
            try await client.createInvite(controlBase: controlBase, username: username, request: request, signatureHex: HexUtil.encode(sig))
            let link = "https://\(serverDomain)/invite#\(HexUtil.encode(secret))"
            lastInviteLink = link
            await refreshPeople()
            return link
        } catch {
            phase = .failed("Couldn't create the invite. Try again in a moment.")
            return nil
        }
    }

    /// Remove a person: owner-IRK revoke on `.com` (records the revocation) AND
    /// — when the friend has redeemed (a bound AID) — an owner-IRK prune of that
    /// AID from the box's allow-list. The box allow-list is add-only, so a `.com`
    /// revoke alone never reaches it: a redeemed friend would keep access without
    /// the prune. BOTH run (one biometric covers both signatures); an
    /// unredeemed invite (no bound AID) is `.com`-revoke only. A failure of
    /// EITHER leg surfaces — losing the box prune silently would leave the friend
    /// with live access.
    public func remove(inviteId: String) async {
        let boundAID = people.first(where: { $0.inviteId == inviteId })?.boundAID
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await irkSigner("Remove this person from \(serviceRef)")
        } catch {
            phase = .failed("Couldn't remove them. Try again in a moment.")
            return
        }

        var revokeFailed = false
        var pruneFailed = false

        // `.com` revoke (records the revocation; what the directory shows).
        do {
            let ts = now()
            let bytes = try ServiceInvite.canonicalRevoke(inviteId: inviteId, issuedAt: ts)
            let sig = try ServiceInvite.sign(bytes, with: key)
            let request: [String: Any] = ["inviteId": inviteId, "issuedAt": ts]
            try await client.revokeInvite(controlBase: controlBase, username: username, inviteId: inviteId, request: request, signatureHex: HexUtil.encode(sig))
        } catch {
            revokeFailed = true
        }

        // Box prune (only meaningful once redeemed — an unredeemed invite was
        // never added to the allow-list).
        if let aid = boundAID, !aid.isEmpty {
            do {
                let ts = now()
                let bytes = try ServiceInvite.canonicalRemoveServiceAllow(
                    serverId: serverDomain, serviceRef: serviceRef, aid: aid, issuedAt: ts)
                let sig = try ServiceInvite.sign(bytes, with: key)
                let request: [String: Any] = ["serverId": serverDomain, "serviceRef": serviceRef, "aid": aid.lowercased(), "issuedAt": ts]
                _ = try await client.removeServiceAllow(serverDomain: serverDomain, request: request, signatureHex: HexUtil.encode(sig))
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

    /// List the author's live invites for this service from `.com`, decrypting
    /// each bundle locally with the household key.
    public func refreshPeople() async {
        do {
            let (aidPub, household) = try await readKeys("Show who can open \(serviceRef)")
            let rows = try await client.listInvites(controlBase: controlBase, username: username, authorAidHex: HexUtil.encode(aidPub))
            people = rows
                .filter { $0.serviceRef == serviceRef && $0.revokedAt == nil }
                .map { row in
                    var name = "unknown"
                    var photo: String?
                    if let b = try? ServiceInvite.openBundle(row.encryptedBundleHex, householdKey: household, inviteId: row.inviteId) {
                        name = b.name
                        photo = b.photo
                    }
                    return Person(inviteId: row.inviteId, name: name, photo: photo, bound: row.boundAidHex != nil, boundAID: row.boundAidHex)
                }
        } catch {
            // Keep the last-known list; the load-phase error is already surfaced.
        }
    }

    public func clearLink() { lastInviteLink = nil }

    private func randomSecret() -> Data {
        var d = Data(count: 32)
        d.withUnsafeMutableBytes { _ = SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        return d
    }
}

/// Best-effort monotonic per-(account, device) invite counter, persisted in
/// UserDefaults so two adds don't collide on the inviteId (the daemon + `.com`
/// also dedup by inviteId). Falls back to a time-derived value if storage
/// fails. Mirrors the webapp's `nextInviteCounter`.
public enum ServiceInviteCounter {
    private static let key = "flagship.serviceInviteCounter"
    public static func next() -> Int {
        let d = UserDefaults.standard
        let n = d.integer(forKey: key)
        d.set(n + 1, forKey: key)
        return n
    }
}
