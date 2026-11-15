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
    /// The SCIM URL and token of a connector just added: shown once, never stored on the phone.
    public private(set) var newConnector: (url: String, token: String)?

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
            if seat.memberOnly != true { await loadNames(seat) }
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
        let order = try OrgAuthority.canonicalSeatGrant(orgId: j.invite["orgId"] as? String ?? "", seatId: j.seatId, labelSha256: label, memberKeyId: memberKeyId,
                                                        adminKeyId: adminKeyId, rolesHash: rolesHash, oarVersion: version, issuedAt: t, expiresAt: expiresAt)
        let body: [String: Any] = [
            "grant": ["orgId": j.invite["orgId"] as? String ?? "", "seatId": j.seatId, "labelSha256": label, "memberKeyId": memberKeyId, "adminKeyId": adminKeyId,
                      "rolesHash": rolesHash, "oarVersion": NSNumber(value: version), "issuedAt": NSNumber(value: t), "expiresAt": NSNumber(value: expiresAt)],
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
            default:
                message = String(localized: "Change this person's role from their seat, then decline this proposal.")
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
            try await client.postConnector(orgId: seat.orgId, body: [
                "connector": OrgConnectors.connectorJSON(made.connector), "connectorPubHex": made.pubHex, "approvals": [a.jsonObject],
                "setup": try OrgConnectors.sealSetup(made.connector, boxKem: boxKem, setup: setup, issuedAt: t),
            ])
            newConnector = ("https://\(serverDomain)/scim/v2", token)
            connectors.append(made.connector)
        } catch { failed(error) }
    }

    public func clearNewConnector() { newConnector = nil }

    /// The org's servers this phone verified (for the connector's server picker).
    public var servers: [String] { plan.map { Array($0.ctx.servers).sorted() } ?? [] }
}
