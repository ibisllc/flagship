import Foundation
import CryptoKit
import Observation
import Flagship
import FlagshipCore
import FlagshipAPI

/// Settings → Organizations (docs/enterprise-accounts.md, phase E4). Everything shown is verified on
/// this phone from the genesis hash it pinned; every action is a hybrid-signed approval by this
/// phone's seat admin key (a load-bearing signature, never a flag).
@MainActor
@Observable
public final class OrgViewModel {
    public enum Phase: Equatable { case idle, loading, loaded, failed(String) }

    public struct AdminRow: Identifiable {
        public let seatId: String
        public let kind: OrgAdminKind
        public let isFounder: Bool
        public let isMe: Bool
        public let frozenUntil: Int64?
        public var id: String { seatId }
    }

    public private(set) var seats: [OrgSeatKeys.Seat] = []
    public private(set) var phase: Phase = .idle
    public private(set) var snapshot: OrgSnapshot?
    public private(set) var busy = false
    public var message: String?
    /// The link and code of the last invitation made, shown as a QR and a share sheet.
    public private(set) var inviteLink: String?
    /// People who accepted an invitation and wait for an admin to compare the code and admit them.
    public private(set) var pendingJoins: [OrgPendingJoin] = []
    /// Departed seats whose keys still need rotating, computed on this phone from what it verified.
    public private(set) var rotations: [OrgPendingRotation] = []
    private var plan: OrgRotationPlan?
    /// Pseudonyms from the org directory (seat id → name), opened on this phone with the directory key.
    public private(set) var names: [String: String] = [:]
    private var directoryKeys: [Int64: [UInt8]] = [:]
    private var directoryEntryIds: [String: String] = [:]
    /// The admin console's Directory: everyone's entry (seat id → entry), open proposals, connectors.
    public private(set) var people: [String: OrgDirectoryEntry] = [:]
    public private(set) var proposals: [DirectoryProposal] = []
    public private(set) var connectors: [OrgConnector] = []
    /// The SCIM URL and token of a connector just added (or a rotated token): shown once, never stored on the phone.
    public private(set) var newConnector: (url: String, token: String)?
    /// Each connector's standing (re-approval needed after its approver left), its mapping for the editor.
    public private(set) var standings: [String: OrgConnectorStanding] = [:]
    public private(set) var mappings: [String: [String: Any]] = [:]
    private var connectorBundles: [String: [String: Any]] = [:]
    /// A member's view: the people and servers it shares something with (its slice of the directory).
    public private(set) var sharedWith: (people: [OrgDirectoryEntry], servers: [String])?

    public struct DirectoryProposal: Identifiable {
        public let id: String
        public let kind: String
        public let entry: OrgDirectoryEntry
        public let roles: [OrgSeatRole]
        public let connectorKind: String
        let subject: String
    }

    private let client: OrgClient
    private let keys: OrgSeatKeys
    private let now: () -> Int64
    private let umk: (String) async throws -> [UInt8]

    public init(client: OrgClient = OrgClient(), keys: OrgSeatKeys = .shared, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                umk: @escaping (String) async throws -> [UInt8] = { reason in try await Keystore.currentUMK(reason: reason).withUnsafeBytes { Array($0) } }) {
        self.client = client; self.keys = keys; self.now = now; self.umk = umk
        seats = keys.seats()
    }

    public func reloadSeats() { seats = keys.seats() }

    // MARK: create

    /// Creates an org with this phone as its founder and only admin; more admins join by invite.
    public func create(name: String) async -> Bool {
        let n = name.trimmingCharacters(in: .whitespaces).lowercased()
        guard !n.isEmpty else { return false }
        busy = true; defer { busy = false }
        let orgId = OrgAuthority.randomId(), seatId = OrgAuthority.randomId(), t = now()
        do {
            let (binding, secret) = try keys.makeKey(orgId: orgId, seatId: seatId, now: t)
            let record = OrgAuthority.genesis(orgId: orgId, founderSeatId: seatId, founderBinding: binding, issuedAt: t)
            let order = try OrgAuthority.canonicalAuthority(record)
            let keyId = OrgAuthority.keyIdHex(ed25519PubHex: binding.ed25519PubHex, mldsaPubHex: binding.mldsaPubHex)
            let approval = try OrgAuthority.signApproval(orgId: orgId, oarVersion: 0, order: order, seatId: seatId, adminKeyId: keyId,
                                                          issuedAt: t, notAfter: t + OrgAuthority.day) { p, m in try PqHybrid.hybridSign(secretKey: secret, purpose: p, payload: m) }
            let genesisHash = try OrgAuthority.authorityHash(record)
            _ = try await client.create(name: n, genesis: OrgAuthorityEntry(record: record, via: "genesis", approvals: [approval], notice: nil, overturnOf: nil))
            try keys.remember(orgId: orgId, seatId: seatId, orgName: n, genesisHash: genesisHash, binding: binding, secret: secret)
            reloadSeats()
            return true
        } catch let e as OrgClientError {
            message = e.code == "name taken" || e.status == 409 ? String(localized: "That name is taken. Try another.") : String(localized: "Couldn't create the organization. Try again.")
        } catch {
            message = String(localized: "Couldn't create the organization. Try again.")
        }
        return false
    }

    // MARK: load

    public func load(_ seat: OrgSeatKeys.Seat) async {
        phase = .loading
        do {
            snapshot = try await client.snapshot(orgId: seat.orgId, genesisHash: seat.genesisHash, now: now())
            pendingJoins = (try? await client.pendingJoins(orgId: seat.orgId)) ?? []
            plan = seat.memberOnly == true ? nil : try? await client.rotationPlan(snapshot!, now: now())
            rotations = plan?.pending ?? []
            phase = .loaded
            let isOrgAdmin = snapshot?.state.current.admins.contains { $0.seatId == seat.seatId && $0.kind == .admin } ?? false
            if isOrgAdmin { await loadNames(seat) } else { await loadSlice(seat) }
        } catch {
            snapshot = nil
            phase = .failed(String(localized: "This organization's records didn't check out, so nothing is shown. Try again later."))
        }
    }

    public func admins(_ seat: OrgSeatKeys.Seat) -> [AdminRow] {
        guard let s = snapshot else { return [] }
        let r = s.state.current
        return r.admins.map { a in
            AdminRow(seatId: a.seatId, kind: a.kind, isFounder: a.seatId == r.founderSeatId, isMe: a.seatId == seat.seatId,
                     frozenUntil: OrgAuthority.activeFreeze(s.book, seatId: a.seatId, now: now())?.untilMs)
        }
    }

    public func myFreeze(_ seat: OrgSeatKeys.Seat) -> OrgVerifiedFreeze? {
        snapshot.flatMap { OrgAuthority.activeFreeze($0.book, seatId: seat.seatId, now: now()) }
    }

    public func isOrgAdmin(_ seat: OrgSeatKeys.Seat) -> Bool {
        snapshot?.state.current.admins.contains { $0.seatId == seat.seatId && $0.kind == .admin } ?? false
    }

    /// What a screen calls a seat: "You", its pseudonym from the directory, or a placeholder until the directory opens.
    public func name(_ seat: OrgSeatKeys.Seat, _ seatId: String) -> String {
        if seatId == seat.seatId { return String(localized: "You") }
        return names[seatId] ?? String(localized: "Name hidden (\(String(seatId.prefix(6))))")
    }

    /// Who must approve "Restore my access" under the bylaws, as admin rows.
    public func restoreApprovers(_ seat: OrgSeatKeys.Seat) -> (seats: [String], needed: Int)? {
        snapshot.map { OrgAuthority.overturnSigners($0.state.current, frozenSeat: seat.seatId) }
    }

    // MARK: actions

    private func approval(_ seat: OrgSeatKeys.Seat, order: [UInt8]) throws -> OrgApproval {
        guard let s = snapshot else { throw OrgAuthorityError("stale-oar") }
        let t = now()
        return try OrgAuthority.signApproval(orgId: seat.orgId, oarVersion: s.state.current.version, order: order, seatId: seat.seatId,
                                             adminKeyId: seat.keyId, issuedAt: t, notAfter: t + OrgAuthority.day) { p, m in
            guard let sig = keys.sign(seat, purpose: p, payload: m) else { throw OrgAuthorityError("locked") }
            return sig
        }
    }

    private func failed(_ e: Error) {
        if let o = e as? OrgAuthorityError, o.code == "locked" {
            message = String(localized: "Unlock Flagship to sign this.")
        } else if let c = e as? OrgClientError, c.code == "org-plan-lapsed" {
            message = OrgPlanDisplay.lapsedRefusal
        } else if let c = e as? OrgClientError, c.code == "org-freeze-refused" {
            message = String(localized: "You can freeze one admin for up to 72 hours, once a week.")
        } else {
            message = String(localized: "That didn't go through. Try again.")
        }
    }

    /// Freezes another admin for 72 hours (one admin may, at most once a week).
    public func freeze(_ seat: OrgSeatKeys.Seat, target: String) async {
        busy = true; defer { busy = false }
        guard let s = snapshot else { return }
        let t = now()
        let body = OrgSeatFreeze(orgId: seat.orgId, seatId: target, untilMs: t + OrgAuthority.freezeMaxMs, oarVersion: s.state.current.version, issuedAt: t)
        do {
            let a = try approval(seat, order: try body.canonical())
            try await client.freeze(orgId: seat.orgId, OrgSigned(body: body, approvals: [a]))
            message = String(localized: "Frozen for 72 hours. The bylaws' signers can lift it sooner.")
            await load(seat)
        } catch { failed(error) }
    }

    /// "Restore my access": opens the overturn ceremony of this seat's own freeze for the bylaws' signers.
    public func restoreMyAccess(_ seat: OrgSeatKeys.Seat) async {
        busy = true; defer { busy = false }
        guard let s = snapshot, let f = myFreeze(seat) else { return }
        let body = OrgOverturn(orgId: seat.orgId, freezeSha256: f.sha256, oarVersion: s.state.current.version, issuedAt: now())
        do {
            let order = try body.canonical()
            let a = try approval(seat, order: order)
            try await client.openCeremony(orgId: seat.orgId, order: String(decoding: order, as: UTF8.self),
                                          payload: ["kind": "overturn", "seatId": seat.seatId, "body": OrgJSON.overturn(OrgSigned(body: body, approvals: []))["body"] as Any], approval: a)
            message = String(localized: "Asked. You'll get your access back when enough of them approve.")
            await load(seat)
        } catch { failed(error) }
    }

    /// Approves a ceremony; when it is an overturn that now has enough of the bylaws' signers, submits it.
    public func approve(_ seat: OrgSeatKeys.Seat, _ c: OrgCeremony) async {
        busy = true; defer { busy = false }
        do {
            let a = try approval(seat, order: Array(c.order.utf8))
            try await client.approve(orgId: seat.orgId, sha256: c.sha256, approval: a)
            if c.purpose == OrgAuthority.tagSeatGrant, c.payload["kind"] as? String == "grant", let s = snapshot,
               let roles = try? OrgAuthorityWire.roles(c.payload["roles"]) {
                let all = c.approvals.filter { $0.seatId != seat.seatId } + [a]
                if all.count >= OrgAuthority.grantThreshold(s.state.current, roles) {
                    var body = c.payload
                    body.removeValue(forKey: "kind")
                    body["approvals"] = all.map(\.jsonObject)
                    try await client.grant(orgId: seat.orgId, body: body)
                }
            }
            if c.purpose == OrgAuthority.tagOverturn, let s = snapshot, let frozen = c.payload["seatId"] as? String,
               let body = (c.payload["body"] as? [String: Any]).flatMap({ try? OrgAuthorityWire.overturn(["body": $0, "approvals": []]).body }) {
                let all = c.approvals.filter { $0.seatId != seat.seatId } + [a]
                let need = OrgAuthority.overturnSigners(s.state.current, frozenSeat: frozen)
                if all.filter({ need.seats.contains($0.seatId) }).count >= need.needed {
                    try await client.overturn(orgId: seat.orgId, OrgSigned(body: body, approvals: all.filter { $0.seatId != frozen }))
                }
            }
            message = String(localized: "Approved.")
            await load(seat)
        } catch { failed(error) }
    }

    public func hasApproved(_ seat: OrgSeatKeys.Seat, _ c: OrgCeremony) -> Bool { c.approvals.contains { $0.seatId == seat.seatId } }

    // MARK: admit (after the codes match)

    private func grantBody(_ j: OrgPendingJoin, version: Int64, issuedAt t: Int64) throws -> (order: [UInt8], body: [String: Any], roles: [OrgSeatRole]) {
        let roles = try OrgAuthorityWire.roles(j.roles)
        guard let label = j.invite["labelSha256"] as? String, let rolesHash = j.invite["rolesHash"] as? String,
              let memberKeyId = j.accept["memberKeyId"] as? String else { throw OrgAuthorityError("malformed") }
        let adminKeyId = (j.accept["adminKeyId"] as? String) ?? ""
        let expiresAt = t + 365 * OrgAuthority.day
        // The custody the person's accept signed (a browser seat says so); the grant repeats it.
        let custody: OrgCustody = (j.accept["custody"] as? String) == "browser" ? .browser : .hardware
        var g = OrgSeatGrant(orgId: j.invite["orgId"] as? String ?? "", seatId: j.seatId, labelSha256: label, memberKeyId: memberKeyId,
                             adminKeyId: adminKeyId, rolesHash: rolesHash, oarVersion: version, issuedAt: t, expiresAt: expiresAt)
        g.custody = custody
        let order = try g.canonical()
        var grantJSON: [String: Any] = ["orgId": j.invite["orgId"] as? String ?? "", "seatId": j.seatId, "labelSha256": label, "memberKeyId": memberKeyId, "adminKeyId": adminKeyId,
                                        "rolesHash": rolesHash, "oarVersion": NSNumber(value: version), "issuedAt": NSNumber(value: t), "expiresAt": NSNumber(value: expiresAt)]
        if custody == .browser { grantJSON["custody"] = "browser" }
        let body: [String: Any] = [
            "grant": grantJSON,
            "roles": OrgAuthorityWire.rolesJSON(roles),
            "memberBinding": j.memberBinding.jsonObject,
            "adminBinding": j.adminBinding.map { $0.jsonObject as Any } ?? NSNull(),
        ]
        return (order, body, roles)
    }

    /// Admits a person whose code matched: one admin for a member; for an admin role, the second admin's
    /// approval in the inbox completes it (two org admins raise a seat to admin).
    public func admit(_ seat: OrgSeatKeys.Seat, _ j: OrgPendingJoin) async {
        guard let s = snapshot else { return }
        busy = true; defer { busy = false }
        do {
            let g = try grantBody(j, version: s.state.current.version, issuedAt: now())
            let a = try approval(seat, order: g.order)
            if OrgAuthority.grantThreshold(s.state.current, g.roles) <= 1 {
                var body = g.body
                body["approvals"] = [a.jsonObject]
                try await client.grant(orgId: seat.orgId, body: body)
                message = String(localized: "Admitted.")
            } else {
                var payload = g.body
                payload["kind"] = "grant"
                try await client.openCeremony(orgId: seat.orgId, order: String(decoding: g.order, as: UTF8.self), payload: payload, approval: a)
                message = String(localized: "Another admin needs to approve this before it takes effect.")
            }
            await load(seat)
        } catch let e as OrgClientError where e.code == "org-seat-limit" {
            message = String(localized: "Your plan has no free seats. Remove someone or add seats first.")
        } catch { failed(error) }
    }

    // MARK: invite

    public enum InviteRole: String, CaseIterable, Identifiable {
        case member, serverAdmin, appAdmin
        public var id: String { rawValue }
    }

    /// Makes an invitation. The pseudonym is required first: it is sealed (`.com` keeps only its
    /// digest and ciphertext) and is all the org ever sees of the person.
    public func invite(_ seat: OrgSeatKeys.Seat, pseudonym: String, role: InviteRole, target: String) async {
        let name = pseudonym.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { message = String(localized: "Give this person a name the organization will know them by."); return }
        let roles: [OrgSeatRole]
        switch role {
        case .member: roles = [.member]
        case .serverAdmin: roles = [.serverAdmin(servers: [target.lowercased()])]
        case .appAdmin: roles = [.serviceAdmin(apps: [target.lowercased()])]
        }
        busy = true; defer { busy = false }
        do { _ = try await makeInvite(seat, name: name, roles: roles, entry: nil) } catch let e as OrgClientError where e.code == "org-seat-limit" {
            message = String(localized: "Your plan has no free seats. Remove someone or add seats first.")
        } catch { failed(error) }
    }

    /// Posts an invitation for `roles` and records the person in the directory; returns the invite's digest.
    private func makeInvite(_ seat: OrgSeatKeys.Seat, name: String, roles: [OrgSeatRole], entry: OrgDirectoryEntry?) async throws -> String {
        guard let s = snapshot else { throw OrgAuthorityError("stale-oar") }
        let seatId = OrgAuthority.randomId(), t = now()
        let linkKey = SymmetricKey(size: .bits256)
        let sealedLabel = try AES.GCM.seal(Data(name.utf8), using: linkKey).combined!
        let offerJSON = try JSONSerialization.data(withJSONObject: [
            "orgId": seat.orgId, "orgName": seat.orgName, "genesisHash": seat.genesisHash, "seatId": seatId,
            "roles": OrgAuthorityWire.rolesJSON(roles), "pseudonym": name,
        ])
        let offer = try AES.GCM.seal(offerJSON, using: linkKey).combined!
        let rolesHash = try OrgAuthority.rolesHash(roles)
        let labelSha = OrgAuthority.sha256Hex([UInt8](sealedLabel))
        let order = try OrgAuthority.canonicalSeatInvite(orgId: seat.orgId, seatId: seatId, labelSha256: labelSha, rolesHash: rolesHash,
                                                         oarVersion: s.state.current.version, issuedAt: t, expiresAt: t + 7 * OrgAuthority.day)
        let a = try approval(seat, order: order)
        try await client.createInvite(orgId: seat.orgId, body: [
            "invite": ["orgId": seat.orgId, "seatId": seatId, "labelSha256": labelSha, "rolesHash": rolesHash,
                       "oarVersion": NSNumber(value: s.state.current.version), "issuedAt": NSNumber(value: t), "expiresAt": NSNumber(value: t + 7 * OrgAuthority.day)],
            "roles": OrgAuthorityWire.rolesJSON(roles),
            "approvals": [a.jsonObject],
            "sealedLabelHex": OrgAuthority.hex([UInt8](sealedLabel)),
            "offerHex": OrgAuthority.hex([UInt8](offer)),
        ])
        // The admins' copy of the pseudonym, under the directory key (the link key's copy is the person's).
        var e = entry ?? OrgDirectoryEntry(seatId: seatId, pseudonym: name, updatedAt: t)
        e.seatId = seatId; e.pendingId = ""; e.updatedAt = t
        try? await recordEntry(seat, e)
        let k = linkKey.withUnsafeBytes { OrgAuthority.hex(Array($0)) }
        inviteLink = "\(Endpoints.controlBaseUrl.absoluteString)/org-join#o=\(seat.orgId)&s=\(seatId)&k=\(k)"
        return OrgAuthority.sha256Hex(order)
    }

    public func clearInvite() { inviteLink = nil }

    // MARK: rotate keys (after someone leaves)

    /// Keys this seat can rotate now; a disk key changes only with its server's own re-key (not built yet).
    public func rotatable(_ r: OrgPendingRotation) -> [OrgPendingRotation.Key] { r.keys.filter { $0.kind != .diskKey } }

    /// "Rotate keys" for one departed seat: this phone announces its own seat KEM key first (so it keeps
    /// getting new versions), then seals a fresh key per chain to the recipients it verified, approved by
    /// this seat's admin key, and posts each version.
    public func rotate(_ seat: OrgSeatKeys.Seat, _ r: OrgPendingRotation) async {
        guard let s = snapshot else { return }
        busy = true; defer { busy = false }
        do {
            var umk = try await self.umk(String(localized: "Rotate this organization's keys"))
            defer { for i in umk.indices { umk[i] = 0 } }
            try await publishSeatKem(seat, s, umk: umk)
            await load(seat)
            guard var p = plan else { throw OrgAuthorityError("malformed", "no plan") }
            for k in rotatable(r) {
                var key = [UInt8](repeating: 0, count: 32)
                guard SecRandomCopyBytes(kSecRandomDefault, 32, &key) == errSecSuccess else { throw OrgAuthorityError("malformed", "random") }
                defer { for i in key.indices { key[i] = 0 } }
                let b = try OrgRotation.rotate(p, kind: k.kind, scope: k.scope, issuedAt: now(), key: key) { order, _ in try approval(seat, order: order) }
                try await client.postKeyRing(orgId: seat.orgId, b)
                if let snap = snapshot { p = try await client.rotationPlan(snap, now: now()) }
            }
            message = String(localized: "Keys rotated.")
            await load(seat)
            if rotatable(r).contains(where: { $0.kind == .directoryKey }) { await resealDirectory(seat) }
        } catch { failed(error) }
    }

    /// This seat's X-Wing key from the UMK, signed by the seat admin key (an org admin) or the member key.
    private func publishSeatKem(_ seat: OrgSeatKeys.Seat, _ s: OrgSnapshot, umk: [UInt8]) async throws {
        let t = now()
        let kp = try PqHybrid.hybridSealKeygen(seed: try OrgAuthority.seatKemSeed(umk: umk, orgId: seat.orgId))
        let kemKeyId = OrgAuthority.kemKeyIdHex(kp.publicKey)
        let msg = try OrgAuthority.canonicalSeatKem(orgId: seat.orgId, seatId: seat.seatId, kemKeyId: kemKeyId, issuedAt: t)
        let sig: [UInt8]
        if s.state.current.admins.contains(where: { $0.seatId == seat.seatId }) {
            guard let x = keys.sign(seat, purpose: OrgAuthority.tagSeatKem, payload: msg) else { throw OrgAuthorityError("locked") }
            sig = x
        } else {
            var member = try OrgAuthority.memberKey(umk: umk, orgId: seat.orgId, seatId: seat.seatId, issuedAt: t)
            defer { for i in member.secret.indices { member.secret[i] = 0 } }
            sig = try PqHybrid.hybridSign(secretKey: member.secret, purpose: OrgAuthority.tagSeatKem, payload: msg)
        }
        try await client.postSeatKem(orgId: seat.orgId, body: [
            "statement": ["orgId": seat.orgId, "seatId": seat.seatId, "kemKeyId": kemKeyId, "issuedAt": NSNumber(value: t)] as [String: Any],
            "kemPubHex": OrgAuthority.hex(kp.publicKey),
            "signature": OrgAuthority.hex(sig),
        ])
    }

    // MARK: directory (docs/org-directory.md §2)

    /// Opens the org directory with this admin's seat KEM key. The first admin to look makes the
    /// directory key (sealed to every admin with a KEM key); an admin whose KEM key `.com` lacks
    /// announces it first. Names stay on this phone; nothing here reaches `.com` unsealed.
    func loadNames(_ seat: OrgSeatKeys.Seat) async {
        guard let s = snapshot, s.state.current.admins.contains(where: { $0.seatId == seat.seatId && $0.kind == .admin }) else { return }
        do {
            var umk = try await self.umk(String(localized: "Show the names in this organization"))
            defer { for i in umk.indices { umk[i] = 0 } }
            let kp = try PqHybrid.hybridSealKeygen(seed: try OrgAuthority.seatKemSeed(umk: umk, orgId: seat.orgId))
            if plan?.ctx.kems["seat:\(seat.seatId)"]?.kemKeyId != OrgAuthority.kemKeyIdHex(kp.publicKey) {
                try await publishSeatKem(seat, s, umk: umk)
                plan = try await client.rotationPlan(s, now: now())
            }
            guard var p = plan else { return }
            if OrgDirectory.newestVersion(p) == nil {
                var key = SymmetricKey(size: .bits256).withUnsafeBytes { Array($0) }
                defer { for i in key.indices { key[i] = 0 } }
                let b = try OrgRotation.rotate(p, kind: .directoryKey, scope: "*", issuedAt: now(), key: key) { order, _ in try approval(seat, order: order) }
                try await client.postKeyRing(orgId: seat.orgId, b)
                p = try await client.rotationPlan(s, now: now())
                plan = p
            }
            directoryKeys = OrgDirectory.keys(p, seatId: seat.seatId, kemSecret: kp.secretKey)
            let view = OrgDirectory.openAll(orgId: seat.orgId, try await client.directory(orgId: seat.orgId), keys: directoryKeys)
            names = view.bySeat.mapValues { $0.entry.pseudonym }
            people = view.bySeat.mapValues { $0.entry }
            directoryEntryIds = view.bySeat.mapValues { $0.entryId }
            await loadConsole(seat, kemSecret: kp.secretKey)
            await publishSlices(seat)
        } catch {
            names = [:]
        }
    }

    /// Writes (or updates) one person's entry under the newest directory key; returns the write's digest.
    @discardableResult
    func recordEntry(_ seat: OrgSeatKeys.Seat, _ entry: OrgDirectoryEntry) async throws -> String {
        if directoryKeys.isEmpty { await loadNames(seat) }
        guard let p = plan, let version = OrgDirectory.newestVersion(p), let key = directoryKeys[version] else { throw OrgAuthorityError("locked") }
        let t = now()
        var e = entry
        e.updatedAt = t
        let sealed = try OrgDirectory.seal(orgId: seat.orgId, entryId: directoryEntryIds[e.seatId] ?? OrgAuthority.randomId(), keyVersion: version,
                                           directoryKey: key, entry: e, issuedAt: t)
        let order = try OrgDirectory.canonicalWrite(sealed)
        try await client.putDirectory(orgId: seat.orgId, entry: sealed, approval: try approval(seat, order: order))
        names[e.seatId] = e.pseudonym
        people[e.seatId] = e
        directoryEntryIds[e.seatId] = sealed.entryId
        return OrgAuthority.sha256Hex(order)
    }

    /// After the directory key changes, every entry is sealed again under the new version, so a new
    /// admin (who holds only the new key) reads the same names.
    func resealDirectory(_ seat: OrgSeatKeys.Seat) async {
        guard let p = plan, let version = OrgDirectory.newestVersion(p), let key = directoryKeys[version] else { return }
        guard let all = try? await client.directory(orgId: seat.orgId) else { return }
        let view = OrgDirectory.openAll(orgId: seat.orgId, all, keys: directoryKeys)
        let stale = Set(all.filter { $0.keyVersion < version }.map(\.entryId))
        for (_, e) in view.bySeat.merging(view.byPending, uniquingKeysWith: { a, _ in a }) where stale.contains(e.entryId) {
            let t = now()
            guard let sealed = try? OrgDirectory.seal(orgId: seat.orgId, entryId: e.entryId, keyVersion: version, directoryKey: key, entry: e.entry, issuedAt: t),
                  let a = try? approval(seat, order: try OrgDirectory.canonicalWrite(sealed)) else { continue }
            try? await client.putDirectory(orgId: seat.orgId, entry: sealed, approval: a)
        }
    }

    // MARK: admin console: directory proposals and connectors (docs/org-directory.md §6)

    /// Opens the open proposals addressed to this admin (each checked against its connector record) and lists the connectors.
    func loadConsole(_ seat: OrgSeatKeys.Seat, kemSecret: [UInt8]) async {
        let raw = (try? await client.connectors(orgId: seat.orgId)) ?? []
        var byId: [String: [String: Any]] = [:]
        for c in raw { if let id = (c["connector"] as? [String: Any])?["connectorId"] as? String { byId[id] = c } }
        connectors = raw.compactMap { try? OrgConnector.fromWire($0["connector"]) }.sorted { $0.issuedAt < $1.issuedAt }
        connectorBundles = byId
        if let snap = snapshot {
            standings = byId.compactMapValues { try? OrgConnectors.standing(snap.state, snap.book, connector: $0, now: now()) }
        }
        mappings = byId.compactMapValues { cb -> [String: Any]? in
            guard let sealed = cb["mappingSealed"] as? [String: Any], let v = OrgAuthority.int64(sealed["keyVersion"]), let key = directoryKeys[v],
                  let id = (cb["connector"] as? [String: Any])?["connectorId"] as? String else { return nil }
            return try? OrgConnectors.openMapping(orgId: seat.orgId, connectorId: id, directoryKey: key, sealed: sealed)
        }
        var out: [DirectoryProposal] = []
        for p in (try? await client.proposals(orgId: seat.orgId)) ?? [] where p["decision"] == nil || p["decision"] is NSNull {
            guard let b = p["bundle"] as? [String: Any], let prop = b["proposal"] as? [String: Any], let cid = prop["connectorId"] as? String, let cb = byId[cid],
                  let conn = try? OrgConnector.fromWire(cb["connector"]) else { continue }
            let roles = (try? OrgAuthorityWire.roles(b["roles"])) ?? []
            let rolesHash = roles.isEmpty ? "" : ((try? OrgAuthority.rolesHash(roles)) ?? "")
            guard let v = try? OrgConnectors.verifyProposal(connector: cb, proposal: b, rolesHash: rolesHash, now: now()),
                  let body = try? OrgConnectors.openProposal(b, recipient: "seat:\(seat.seatId)", kemSecret: kemSecret),
                  let entry = try? OrgDirectory.parseBody(body) else { continue }
            out.append(DirectoryProposal(id: v.proposalId, kind: v.kind, entry: entry, roles: roles, connectorKind: conn.kind, subject: v.subject))
        }
        proposals = out.sorted { $0.entry.pseudonym < $1.entry.pseudonym }
    }

    private func decide(_ seat: OrgSeatKeys.Seat, _ p: DirectoryProposal, done refSha256: String?) async throws {
        let t = now()
        let ref = refSha256 ?? String(repeating: "0", count: 64)
        let decision = refSha256 == nil ? "declined" : "done"
        let order = try OrgConnectors.canonicalDecision(orgId: seat.orgId, proposalId: p.id, decision: decision, refSha256: ref, issuedAt: t)
        try await client.decideProposal(orgId: seat.orgId, decision: ["orgId": seat.orgId, "proposalId": p.id, "decision": decision, "refSha256": ref, "issuedAt": NSNumber(value: t)],
                                        approval: try approval(seat, order: order))
        proposals.removeAll { $0.id == p.id }
    }

    /// Carries a proposal out with the usual order, then records it: an invitation (share its link as
    /// usual), a removal, or the updated entry. A role change is done from the person's seat.
    public func approveProposal(_ seat: OrgSeatKeys.Seat, _ p: DirectoryProposal) async {
        guard let s = snapshot else { return }
        busy = true; defer { busy = false }
        do {
            switch p.kind {
            case "invite":
                let ref = try await makeInvite(seat, name: p.entry.pseudonym, roles: p.roles.isEmpty ? [.member] : p.roles, entry: p.entry)
                try await decide(seat, p, done: ref)
                message = String(localized: "Invitation made. Share the link with them.")
            case "offboard":
                let t = now()
                let order = try OrgAuthority.canonicalSeatRevoke(orgId: seat.orgId, seatId: p.subject, reason: "offboarded", oarVersion: s.state.current.version, issuedAt: t)
                let a = try approval(seat, order: order)
                try await client.revoke(orgId: seat.orgId, body: [
                    "revoke": ["orgId": seat.orgId, "seatId": p.subject, "reason": "offboarded", "oarVersion": NSNumber(value: s.state.current.version), "issuedAt": NSNumber(value: t)],
                    "approvals": [a.jsonObject],
                ])
                try await decide(seat, p, done: OrgAuthority.sha256Hex(order))
                message = String(localized: "Removed. Rotate the keys they could open when the list asks.")
                await load(seat)
            case "entry-update":
                var e = p.entry
                e.seatId = p.subject; e.pendingId = ""
                try await decide(seat, p, done: try await recordEntry(seat, e))
                message = String(localized: "Updated.")
            case "role-change":
                guard let g = s.grants.last(where: { $0.grant.seatId == p.subject }), !s.book.revoked.contains(p.subject) else { throw OrgAuthorityError("seat-unknown") }
                if OrgAuthority.rolesRaiseAdmin(p.roles) && g.grant.adminKeyId.isEmpty {
                    message = String(localized: "An admin role needs this person to accept a new invitation. Decline this and invite them again.")
                    return
                }
                // A newer grant replaces the seat's current one; it must be later even if this phone's clock lags.
                let t = max(now(), g.grant.issuedAt + 1)
                let rolesHash = try OrgAuthority.rolesHash(p.roles)
                let expiresAt = t + 365 * OrgAuthority.day
                let order = try OrgAuthority.canonicalSeatGrant(orgId: seat.orgId, seatId: p.subject, labelSha256: g.grant.labelSha256, memberKeyId: g.grant.memberKeyId,
                                                                adminKeyId: g.grant.adminKeyId, rolesHash: rolesHash, oarVersion: s.state.current.version, issuedAt: t, expiresAt: expiresAt)
                let a = try approval(seat, order: order)
                var body: [String: Any] = [
                    "grant": ["orgId": seat.orgId, "seatId": p.subject, "labelSha256": g.grant.labelSha256, "memberKeyId": g.grant.memberKeyId, "adminKeyId": g.grant.adminKeyId,
                              "rolesHash": rolesHash, "oarVersion": NSNumber(value: s.state.current.version), "issuedAt": NSNumber(value: t), "expiresAt": NSNumber(value: expiresAt)],
                    "roles": OrgAuthorityWire.rolesJSON(p.roles),
                    "memberBinding": g.memberBinding.jsonObject,
                    "adminBinding": g.adminBinding.map { $0.jsonObject as Any } ?? NSNull(),
                ]
                if OrgAuthority.grantThreshold(s.state.current, p.roles) <= 1 {
                    body["approvals"] = [a.jsonObject]
                    try await client.grant(orgId: seat.orgId, body: body)
                    message = String(localized: "Role changed.")
                } else {
                    body["kind"] = "grant"
                    try await client.openCeremony(orgId: seat.orgId, order: String(decoding: order, as: UTF8.self), payload: body, approval: a)
                    message = String(localized: "Another admin needs to approve this before it takes effect.")
                }
                // The org log holds the grant (or the ceremony that will produce it) under this digest.
                try await decide(seat, p, done: OrgAuthority.sha256Hex(order))
                await load(seat)
            default:
                message = String(localized: "Updated.")
            }
        } catch { failed(error) }
    }

    public func declineProposal(_ seat: OrgSeatKeys.Seat, _ p: DirectoryProposal) async {
        busy = true; defer { busy = false }
        do { try await decide(seat, p, done: nil) } catch { failed(error) }
    }

    /// Adds a SCIM connector on one of the org's servers: the phone makes its key and bearer token,
    /// approves the record and seals the setup to that server. The token is shown once.
    public func addScimConnector(_ seat: OrgSeatKeys.Seat, serverDomain: String) async {
        guard let p = plan, let boxKem = p.ctx.kems["box:\(serverDomain)"] else {
            message = String(localized: "That server hasn't announced its key yet. Try again in a few minutes.")
            return
        }
        busy = true; defer { busy = false }
        do {
            let t = now()
            let mapping = OrgConnectors.defaultMapping(kind: "scim")
            let made = try OrgConnectors.newConnector(orgId: seat.orgId, kind: "scim", serverDomain: serverDomain, mapping: mapping, issuedAt: t)
            let token = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0).base64EncodedString() }
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            let setup: [String: Any] = ["connectorSeedsHex": made.seedsHex, "mapping": mapping,
                                        "scimTokenSha256": OrgAuthority.sha256Hex(Array(token.utf8)), "scimTokenIssuedAt": NSNumber(value: t)]
            let a = try approval(seat, order: try OrgConnectors.canonicalConnector(made.connector))
            var body: [String: Any] = [
                "connector": OrgConnectors.connectorJSON(made.connector), "connectorPubHex": made.pubHex, "approvals": [a.jsonObject],
                "setup": try OrgConnectors.sealSetup(made.connector, boxKem: boxKem, setup: setup, issuedAt: t),
            ]
            if let dk = newestDirectoryKey() {
                body["mappingSealed"] = try OrgConnectors.sealMapping(orgId: seat.orgId, connectorId: made.connector.connectorId, directoryKey: dk.key, keyVersion: dk.version, mapping: mapping)
            }
            try await client.postConnector(orgId: seat.orgId, body: body)
            newConnector = ("https://\(serverDomain)/scim/v2", token)
            connectors.append(made.connector)
        } catch { failed(error) }
    }

    public func clearNewConnector() { newConnector = nil }

    /// The org's servers this phone verified (for the connector's server picker).
    public var servers: [String] { plan.map { Array($0.ctx.servers).sorted() } ?? [] }

    // MARK: connector upkeep: re-approve, pause, retire, rotate the token, the mapping, LDAP

    private func newestDirectoryKey() -> (version: Int64, key: [UInt8])? {
        guard let p = plan, let v = OrgDirectory.newestVersion(p), let k = directoryKeys[v] else { return nil }
        return (v, k)
    }

    /// Posts a new version of a connector record (same key, a later `issuedAt`) with this admin's approval;
    /// `setup` (sealed to its box) and the mapping change only when given.
    private func postConnectorUpdate(_ seat: OrgSeatKeys.Seat, _ id: String, status: String? = nil, mapping: [String: Any]? = nil, setup: [String: Any]? = nil) async throws {
        guard let cb = connectorBundles[id], var c = try? OrgConnector.fromWire(cb["connector"]), let pub = cb["connectorPubHex"] as? String else { throw OrgAuthorityError("seat-unknown") }
        let t = now()
        c.issuedAt = t
        if let status { c.status = status }
        if let mapping { c.mappingSha256 = try OrgConnectors.mappingSha256(mapping) }
        var body: [String: Any] = ["connector": OrgConnectors.connectorJSON(c), "connectorPubHex": pub, "approvals": [try approval(seat, order: try OrgConnectors.canonicalConnector(c)).jsonObject]]
        var sealedSetup = setup ?? [:]
        if let mapping { sealedSetup["mapping"] = mapping }
        if !sealedSetup.isEmpty {
            guard let boxKem = plan?.ctx.kems["box:\(c.serverDomain)"] else { throw OrgAuthorityError("binding", "box key") }
            body["setup"] = try OrgConnectors.sealSetup(c, boxKem: boxKem, setup: sealedSetup, issuedAt: t)
        }
        if let mapping, let dk = newestDirectoryKey() {
            body["mappingSealed"] = try OrgConnectors.sealMapping(orgId: seat.orgId, connectorId: id, directoryKey: dk.key, keyVersion: dk.version, mapping: mapping)
            mappings[id] = mapping
        }
        try await client.postConnector(orgId: seat.orgId, body: body)
    }

    /// Approves a connector again after the admin who approved it left (it stops 7 days after that).
    public func reapproveConnector(_ seat: OrgSeatKeys.Seat, _ id: String) async {
        busy = true; defer { busy = false }
        do { try await postConnectorUpdate(seat, id); message = String(localized: "Approved again."); await load(seat) } catch { failed(error) }
    }

    /// Pauses, resumes or retires a connector (a retired one never comes back).
    public func setConnectorStatus(_ seat: OrgSeatKeys.Seat, _ id: String, status: String) async {
        busy = true; defer { busy = false }
        do { try await postConnectorUpdate(seat, id, status: status); await load(seat) } catch { failed(error) }
    }

    /// A new SCIM token for the connector, shown once; the box takes it at its next refresh.
    public func rotateScimToken(_ seat: OrgSeatKeys.Seat, _ id: String) async {
        busy = true; defer { busy = false }
        do {
            let token = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0).base64EncodedString() }
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            try await postConnectorUpdate(seat, id, setup: ["scimTokenSha256": OrgAuthority.sha256Hex(Array(token.utf8)), "scimTokenIssuedAt": NSNumber(value: now())])
            if let c = connectors.first(where: { $0.connectorId == id }) { newConnector = ("https://\(c.serverDomain)/scim/v2", token) }
        } catch { failed(error) }
    }

    /// One row of the mapping editor: a directory group and the role its members are proposed.
    public struct MappingRow: Identifiable, Equatable {
        public var id = UUID()
        public var group: String
        public var role: InviteRole
        public var target: String
        public init(group: String, role: InviteRole, target: String) { self.group = group; self.role = role; self.target = target }
    }

    public func mappingRows(_ id: String) -> (rows: [MappingRow], defaultMember: Bool) {
        let m = mappings[id] ?? OrgConnectors.defaultMapping(kind: connectors.first { $0.connectorId == id }?.kind ?? "scim")
        let groups = (m["groups"] as? [String: Any]) ?? [:]
        let rows = groups.keys.sorted().compactMap { g -> MappingRow? in
            guard let roles = try? OrgAuthorityWire.roles(groups[g]) else { return nil }
            for r in roles {
                if case .serverAdmin(let s) = r { return MappingRow(group: g, role: .serverAdmin, target: s?.first ?? "") }
                if case .serviceAdmin(let a) = r { return MappingRow(group: g, role: .appAdmin, target: a.first ?? "") }
            }
            return MappingRow(group: g, role: .member, target: "")
        }
        return (rows, !((m["defaultRoles"] as? [Any]) ?? []).isEmpty)
    }

    /// Saves the mapping: groups → roles, and whether people in no mapped group are proposed as members.
    public func saveMapping(_ seat: OrgSeatKeys.Seat, _ id: String, rows: [MappingRow], defaultMember: Bool) async {
        busy = true; defer { busy = false }
        do {
            let kind = connectors.first { $0.connectorId == id }?.kind ?? "scim"
            var mapping = mappings[id] ?? OrgConnectors.defaultMapping(kind: kind)
            var groups: [String: Any] = [:]
            for r in rows where !r.group.trimmingCharacters(in: .whitespaces).isEmpty {
                let roles: [OrgSeatRole]
                switch r.role {
                case .member: roles = [.member]
                case .serverAdmin: roles = [.member, .serverAdmin(servers: [r.target.lowercased()])]
                case .appAdmin: roles = [.member, .serviceAdmin(apps: [r.target.lowercased()])]
                }
                groups[r.group.trimmingCharacters(in: .whitespaces)] = OrgAuthorityWire.rolesJSON(roles)
            }
            mapping["groups"] = groups
            mapping["defaultRoles"] = defaultMember ? [["role": "member"]] : [[String: Any]]()
            try await postConnectorUpdate(seat, id, mapping: mapping)
            message = String(localized: "Saved. The server uses it at its next check.")
            await load(seat)
        } catch { failed(error) }
    }

    /// The LDAP form: an `ldaps://` URL, the bind account, the base DN and filter, AD or OpenLDAP defaults.
    public struct LdapForm: Equatable {
        public var url = "ldaps://"
        public var bindDn = ""
        public var password = ""
        public var baseDn = ""
        public var userFilter = ""
        public var openLdap = false
        public init() {}
        public var valid: Bool { url.lowercased().hasPrefix("ldaps://") && url.count > 8 && !bindDn.isEmpty && !password.isEmpty && !baseDn.isEmpty }
    }

    /// Adds an LDAP connector, or (with `id`) replaces an LDAP connector's settings; the password goes only to the box, sealed.
    public func saveLdapConnector(_ seat: OrgSeatKeys.Seat, serverDomain: String, form: LdapForm, id: String? = nil) async {
        guard form.valid else { message = String(localized: "Fill in an ldaps:// address, the bind account, its password and the base DN."); return }
        let ldap: [String: Any] = ["url": form.url, "bindDn": form.bindDn, "bindPassword": form.password, "baseDn": form.baseDn, "userFilter": form.userFilter,
                                   "flavor": form.openLdap ? "openldap" : "ad", "intervalMinutes": 15]
        busy = true; defer { busy = false }
        do {
            if let id {
                try await postConnectorUpdate(seat, id, setup: ["ldap": ldap])
            } else {
                guard let boxKem = plan?.ctx.kems["box:\(serverDomain)"] else {
                    message = String(localized: "That server hasn't announced its key yet. Try again in a few minutes.")
                    return
                }
                let t = now()
                var mapping = OrgConnectors.defaultMapping(kind: "ldap")
                if form.openLdap {
                    mapping["attributes"] = ["email": "mail", "displayName": "cn", "externalId": "entryUUID", "disabled": "pwdAccountLockedTime"]
                }
                let made = try OrgConnectors.newConnector(orgId: seat.orgId, kind: "ldap", serverDomain: serverDomain, mapping: mapping, issuedAt: t)
                var body: [String: Any] = [
                    "connector": OrgConnectors.connectorJSON(made.connector), "connectorPubHex": made.pubHex,
                    "approvals": [try approval(seat, order: try OrgConnectors.canonicalConnector(made.connector)).jsonObject],
                    "setup": try OrgConnectors.sealSetup(made.connector, boxKem: boxKem, setup: ["connectorSeedsHex": made.seedsHex, "mapping": mapping, "ldap": ldap], issuedAt: t),
                ]
                if let dk = newestDirectoryKey() {
                    body["mappingSealed"] = try OrgConnectors.sealMapping(orgId: seat.orgId, connectorId: made.connector.connectorId, directoryKey: dk.key, keyVersion: dk.version, mapping: mapping)
                }
                try await client.postConnector(orgId: seat.orgId, body: body)
                connectors.append(made.connector)
            }
            message = String(localized: "Saved. The server reads the directory within 15 minutes.")
        } catch { failed(error) }
    }

    /// Connectors whose approver left, shown beside the keys to rotate.
    public var connectorsToReapprove: [(connector: OrgConnector, standing: OrgConnectorStanding)] {
        connectors.compactMap { c in standings[c.connectorId].flatMap { $0.state == "ok" || c.status == "retired" ? nil : (c, $0) } }
    }

    // MARK: members' slices (docs/org-directory.md: members see whom they share with)

    /// For each live seat that is not an org admin and announced a KEM key, the slice it should hold;
    /// a stale or missing one is sealed to it and stored under this admin's approval.
    func publishSlices(_ seat: OrgSeatKeys.Seat) async {
        guard let s = snapshot, let p = plan, let dk = newestDirectoryKey() else { return }
        let stored = (try? await client.directorySlices(orgId: seat.orgId)) ?? []
        let byId = Dictionary(stored.compactMap { o -> (String, OrgDirectorySlice)? in (try? OrgDirectorySlice.fromWire(o["slice"])).map { ($0.seatId, $0) } }, uniquingKeysWith: { a, _ in a })
        let servers = Array(p.ctx.servers).sorted()
        let admins = Set(s.state.current.admins.filter { $0.kind == .admin }.map(\.seatId))
        for (id, _) in s.book.seats where !s.book.revoked.contains(id) && !admins.contains(id) {
            guard let kem = p.ctx.kems["seat:\(id)"] else { continue }
            let content = OrgDirectory.sliceContent(s.state, s.book, seatId: id, bySeat: people, servers: servers, now: now())
            guard let payload = try? OrgDirectory.slicePayload(orgId: seat.orgId, seatId: id, entries: content.entries, servers: content.servers) else { continue }
            let tag = OrgDirectory.sliceContentTag(directoryKey: dk.key, payload: payload)
            if let have = byId[id], have.contentTag == tag, have.tagKeyVersion == dk.version, have.kemKeyId == kem.kemKeyId { continue }
            guard let slice = try? OrgDirectory.sealSlice(orgId: seat.orgId, seatId: id, kemPub: kem.kemPub, kemKeyId: kem.kemKeyId, entries: content.entries,
                                                         servers: content.servers, directoryKey: dk.key, tagKeyVersion: dk.version, issuedAt: now()),
                  let a = try? approval(seat, order: try OrgDirectory.canonicalSliceWrite(slice)) else { continue }
            try? await client.putDirectorySlice(orgId: seat.orgId, slice: slice, approval: a)
        }
    }

    /// A member opens its own slice (an org admin must have approved it) with its seat KEM key.
    func loadSlice(_ seat: OrgSeatKeys.Seat) async {
        guard let s = snapshot else { return }
        do {
            let mine = (try await client.directorySlices(orgId: seat.orgId)).first { (($0["slice"] as? [String: Any])?["seatId"] as? String) == seat.seatId }
            guard let mine, let slice = try? OrgDirectorySlice.fromWire(mine["slice"]) else { sharedWith = ([], []); return }
            try OrgDirectory.verifySliceApproval(s.state, s.book, slice, approvals: try OrgAuthorityWire.approvals(mine["approvals"]), now: now())
            var umk = try await self.umk(String(localized: "Show the names in this organization"))
            defer { for i in umk.indices { umk[i] = 0 } }
            let kp = try PqHybrid.hybridSealKeygen(seed: try OrgAuthority.seatKemSeed(umk: umk, orgId: seat.orgId))
            let c = try OrgDirectory.openSlice(slice, kemSecret: kp.secretKey)
            sharedWith = (c.entries.sorted { $0.pseudonym < $1.pseudonym }, c.servers)
            for e in c.entries { names[e.seatId] = e.pseudonym }
        } catch {
            sharedWith = nil
        }
    }
}
