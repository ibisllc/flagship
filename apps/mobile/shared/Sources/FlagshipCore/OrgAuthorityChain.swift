import Foundation

/// The org authority chain, seat book and authority predicate (docs/enterprise-accounts.md §5-§9).
/// Swift twin of `verifyOrgAuthorityChain`, `buildOrgSeatBook` and `authorizeOrgOrder` in
/// `packages/protocol/src/orgAuthority.ts`. Phones verify the chain themselves before showing who
/// must approve; the box enforces the same rules.

public enum OrgSeatRole: Equatable, Sendable {
    case member
    case serverAdmin(servers: [String]?)
    case serviceAdmin(apps: [String])
    case serversAdd
    case unlock(servers: [String])

    var raisesAdmin: Bool {
        switch self { case .serverAdmin, .serviceAdmin, .serversAdd: return true; default: return false }
    }
}

public struct OrgSigned<T> {
    public var body: T
    public var approvals: [OrgApproval]
    public init(body: T, approvals: [OrgApproval]) { self.body = body; self.approvals = approvals }
}

public struct OrgDelayedChange: Sendable {
    public var orgId: String, oarVersion: Int64, kind: String, nextRecordSha256: String, effectiveAt: Int64, issuedAt: Int64
    func canonical() throws -> [UInt8] {
        try OrgAuthority.canonicalDelayedChange(orgId: orgId, oarVersion: oarVersion, kind: kind, nextRecordSha256: nextRecordSha256,
                                                effectiveAt: effectiveAt, issuedAt: issuedAt)
    }
}

public struct OrgVeto: Sendable {
    public var orgId: String, noticeSha256: String, issuedAt: Int64
    func canonical() throws -> [UInt8] { try OrgAuthority.canonicalVeto(orgId: orgId, noticeSha256: noticeSha256, issuedAt: issuedAt) }
}

public struct OrgSeatFreeze: Sendable {
    public var orgId: String, seatId: String, untilMs: Int64, oarVersion: Int64, issuedAt: Int64
    public init(orgId: String, seatId: String, untilMs: Int64, oarVersion: Int64, issuedAt: Int64) {
        self.orgId = orgId; self.seatId = seatId; self.untilMs = untilMs; self.oarVersion = oarVersion; self.issuedAt = issuedAt
    }
    public func canonical() throws -> [UInt8] {
        try OrgAuthority.canonicalFreeze(orgId: orgId, seatId: seatId, untilMs: untilMs, oarVersion: oarVersion, issuedAt: issuedAt)
    }
}

public struct OrgOverturn: Sendable {
    public var orgId: String, freezeSha256: String, oarVersion: Int64, issuedAt: Int64
    public init(orgId: String, freezeSha256: String, oarVersion: Int64, issuedAt: Int64) {
        self.orgId = orgId; self.freezeSha256 = freezeSha256; self.oarVersion = oarVersion; self.issuedAt = issuedAt
    }
    public func canonical() throws -> [UInt8] {
        try OrgAuthority.canonicalOverturn(orgId: orgId, freezeSha256: freezeSha256, oarVersion: oarVersion, issuedAt: issuedAt)
    }
}

public struct OrgAuthorityEntry {
    public var record: OrgAuthorityRecord
    public var via: String
    public var approvals: [OrgApproval]
    public var notice: OrgSigned<OrgDelayedChange>?
    public var overturnOf: Int64?
    public init(record: OrgAuthorityRecord, via: String, approvals: [OrgApproval], notice: OrgSigned<OrgDelayedChange>?, overturnOf: Int64?) {
        self.record = record; self.via = via; self.approvals = approvals; self.notice = notice; self.overturnOf = overturnOf
    }
}

public struct OrgSeatGrant: Sendable {
    public var orgId: String, seatId: String, labelSha256: String, memberKeyId: String, adminKeyId: String, rolesHash: String
    public var oarVersion: Int64, issuedAt: Int64, expiresAt: Int64
    public var custody: OrgCustody = .hardware
    public init(orgId: String, seatId: String, labelSha256: String, memberKeyId: String, adminKeyId: String, rolesHash: String,
                oarVersion: Int64, issuedAt: Int64, expiresAt: Int64, custody: OrgCustody = .hardware) {
        self.orgId = orgId; self.seatId = seatId; self.labelSha256 = labelSha256; self.memberKeyId = memberKeyId; self.adminKeyId = adminKeyId
        self.rolesHash = rolesHash; self.oarVersion = oarVersion; self.issuedAt = issuedAt; self.expiresAt = expiresAt; self.custody = custody
    }
    public func canonical() throws -> [UInt8] {
        try OrgAuthority.need(OrgAuthority.isHex(labelSha256, 64), "label-missing")
        try OrgAuthority.need(OrgAuthority.isHex(orgId, 32) && OrgAuthority.isHex(seatId, 32) && OrgAuthority.isHex(memberKeyId, 64)
                              && (adminKeyId.isEmpty || OrgAuthority.isHex(adminKeyId, 64)) && OrgAuthority.isHex(rolesHash, 64), "malformed", "grant")
        try OrgAuthority.need(expiresAt > issuedAt && expiresAt - issuedAt <= OrgAuthority.grantMaxLifetimeMs, "malformed", "expiresAt")
        return OrgAuthority.join([OrgAuthority.tagSeatGrant, orgId, seatId, labelSha256, memberKeyId, adminKeyId, rolesHash,
                                  String(oarVersion), String(issuedAt), String(expiresAt)]) + (custody == .browser ? Array("|browser".utf8) : [])
    }
}

public struct OrgSeatGrantBundle {
    public var grant: OrgSeatGrant
    public var roles: [OrgSeatRole]
    public var memberBinding: PqKeyBindingWire
    public var adminBinding: PqKeyBindingWire?
    public var approvals: [OrgApproval]
}

public struct OrgSeatRevokeBundle {
    public var orgId: String, seatId: String, reason: String, oarVersion: Int64, issuedAt: Int64
    public var approvals: [OrgApproval]
    public var selfSignature: String?
    func canonical() throws -> [UInt8] {
        try OrgAuthority.canonicalSeatRevoke(orgId: orgId, seatId: seatId, reason: reason, oarVersion: oarVersion, issuedAt: issuedAt)
    }
}

public struct OrgVerifiedFreeze: Sendable {
    public let seatId: String, bySeatId: String, issuedAt: Int64, untilMs: Int64, sha256: String
}

public final class OrgAuthorityState {
    public let records: [OrgAuthorityRecord]
    let bindings: [String: VerifiedPqKeyBinding]
    init(records: [OrgAuthorityRecord], bindings: [String: VerifiedPqKeyBinding]) { self.records = records; self.bindings = bindings }
    public var orgId: String { records[0].orgId }
    public var current: OrgAuthorityRecord { records[records.count - 1] }
    func record(_ v: Int64) -> OrgAuthorityRecord? { records.first { $0.version == v } }
    func binding(_ v: Int64, _ seat: String) -> VerifiedPqKeyBinding? { bindings["\(v):\(seat)"] }
}

public struct OrgSeat {
    public let seatId: String
    public let roles: [OrgSeatRole]
    public let member: VerifiedPqKeyBinding
    public let admin: VerifiedPqKeyBinding?
    public let grant: OrgSeatGrant
}

public struct OrgSeatBook {
    public var seats: [String: OrgSeat] = [:]
    public var revoked: Set<String> = []
    public var freezes: [OrgVerifiedFreeze] = []
    public var refused: [(seatId: String, code: String)] = []
}

public enum OrgAction {
    case seatInvite, seatGrant(roles: [OrgSeatRole]), seatRevoke, freeze, addServer, destroy, site
    case operate(server: String)
    case appAdmin(server: String, serviceRef: String)
}

extension OrgAuthority {
    public static func canonicalRoles(_ roles: [OrgSeatRole]) throws -> [UInt8] {
        try need(!roles.isEmpty && roles.count <= 8, "malformed", "roles")
        func list(_ xs: [String], _ re: String) throws -> String {
            try need(!xs.isEmpty && xs.count <= 256 && Set(xs).count == xs.count && xs.allSatisfy { token($0, re) }, "malformed", "role targets")
            return xs.sorted().joined(separator: ",")
        }
        let server = "^[a-z0-9][a-z0-9.-]{0,252}$", ref = "^[a-z0-9][a-z0-9._-]{0,127}$"
        var lines: [String] = []
        for r in roles {
            switch r {
            case .member: lines.append("member")
            case .serversAdd: lines.append("servers-add")
            case .serverAdmin(let s): lines.append("server-admin:" + (s == nil ? "*" : try list(s!, server)))
            case .serviceAdmin(let a): lines.append("service-admin:" + (try list(a, ref)))
            case .unlock(let s): lines.append("unlock:" + (try list(s, server)))
            }
        }
        try need(Set(lines.map { $0.split(separator: ":").first.map(String.init) ?? $0 }).count == lines.count, "malformed", "role twice")
        return Array("\(tagSeatRoles)|\(lines.sorted().joined(separator: ";"))".utf8)
    }

    public static func rolesHash(_ roles: [OrgSeatRole]) throws -> String { sha256Hex(try canonicalRoles(roles)) }

    public static func grantThreshold(_ r: OrgAuthorityRecord, _ roles: [OrgSeatRole]) -> Int {
        roles.contains { $0.raisesAdmin } ? max(r.kGrant, min(2, r.authorityAdmins.count)) : r.kGrant
    }

    static func verifySeatBinding(_ w: PqKeyBindingWire, role: String, orgId: String, seatId: String, now: Int64) throws -> VerifiedPqKeyBinding {
        do {
            return try PqTrust.verifyPqKeyBinding(w, PqBindingExpectation(role: role, subjectId: seatSubject(orgId: orgId, seatId: seatId),
                                                                           ed25519PubHex: w.ed25519PubHex, now: now))
        } catch let e as PqTrustError { throw OrgAuthorityError("binding", e.code) }
    }

    /// Checks each approval and its signature; returns signer seat ids (refuses duplicates).
    static func checkApprovals(_ approvals: [OrgApproval], orgId: String, oarVersion: Int64, order: [UInt8], now: Int64,
                               keyOf: (String) -> VerifiedPqKeyBinding?, frozenAt: (String, Int64) -> Bool) throws -> [String] {
        let purpose = PqTrust.messagePurpose(order), digest = sha256Hex(order)
        var seen: [String] = []
        for a in approvals {
            let msg = try canonicalApproval(a)
            try need(a.orgId == orgId, "wrong-org")
            try need(a.oarVersion == oarVersion, "stale-oar")
            try need(a.purposeTag == purpose && a.orderSha256 == digest, "order-mismatch")
            try need(a.issuedAt <= now + maxSkewMs, "future")
            try need(a.notAfter >= a.issuedAt && a.notAfter - a.issuedAt <= approvalMaxLifetimeMs, "malformed", "notAfter")
            try need(!seen.contains(a.seatId), "duplicate-signer")
            seen.append(a.seatId)
            guard let b = keyOf(a.seatId), b.keyIdHex == a.adminKeyId else { throw OrgAuthorityError("unknown-signer", a.seatId) }
            guard let sig = PqBin.unhex(a.signature), sig.count == PqHybrid.sigLen else { throw OrgAuthorityError("bad-signature") }
            do { try PqHybrid.hybridVerify(publicKey: b.hybridPublicKey, purpose: tagApproval, payload: msg, signature: sig) } catch {
                throw OrgAuthorityError("bad-signature")
            }
            try need(!frozenAt(a.seatId, a.issuedAt), "frozen-signer", a.seatId)
        }
        return seen
    }

    public static func founderRemovalOf(_ p: OrgAuthorityRecord, target: String, issuedAt: Int64) throws -> OrgAuthorityRecord {
        try need(target != p.founderSeatId, "founder")
        try need(p.admins.first { $0.seatId == target }?.kind == .admin, "seat-unknown")
        let admins = p.admins.filter { $0.seatId != target }
        let n = admins.filter { $0.kind == .admin }.count
        func clamp(_ k: Int) -> Int { max(1, min(k, n)) }
        var bylaws = p.bylaws
        if let s = bylaws.overturnSeats, s.contains(target) {
            let seats = s.filter { $0 != target }
            bylaws = OrgBylaws(overturnSeats: seats.isEmpty ? nil : seats,
                               overturnK: bylaws.overturnK == 0 ? 0 : min(bylaws.overturnK, seats.isEmpty ? n : seats.count), vetoK: bylaws.vetoK,
                               hardwareAdmins: bylaws.hardwareAdmins, quorumHardware: bylaws.quorumHardware)
        }
        return OrgAuthorityRecord(orgId: p.orgId, version: p.version + 1, prevHash: try authorityHash(p), admins: admins, bylaws: bylaws,
                                  founderSeatId: p.founderSeatId, kGov: clamp(p.kGov), kGrant: clamp(p.kGrant), kDestroy: clamp(p.kDestroy),
                                  kSite: clamp(p.kSite), issuedAt: issuedAt)
    }

    public static func overturnOf(_ p: OrgAuthorityRecord, before: OrgAuthorityRecord, after: OrgAuthorityRecord, issuedAt: Int64) throws -> OrgAuthorityRecord {
        var r = p
        for a in before.admins where !after.admins.contains(where: { $0.seatId == a.seatId }) && !r.admins.contains(where: { $0.seatId == a.seatId }) {
            r.admins.append(a)
        }
        r.version = p.version + 1; r.prevHash = try authorityHash(p); r.issuedAt = issuedAt
        return r
    }

    // MARK: freezes

    static func verifiedFreezes(records: [OrgAuthorityRecord], bindings: [String: VerifiedPqKeyBinding], orgId: String,
                                freezes: [OrgSigned<OrgSeatFreeze>], overturns: [OrgSigned<OrgOverturn>], now: Int64) -> [OrgVerifiedFreeze] {
        var out: [OrgVerifiedFreeze] = []
        var lastBy: [String: Int64] = [:]
        for f in freezes.sorted(by: { $0.body.issuedAt < $1.body.issuedAt }) {
            guard let v = try? checkFreeze(f, records: records, bindings: bindings, orgId: orgId, now: now, earlier: out) else { continue }
            if let last = lastBy[v.bySeatId], v.issuedAt - last < freezeCooldownMs { continue }
            lastBy[v.bySeatId] = v.issuedAt
            if overturned(v, records: records, bindings: bindings, orgId: orgId, overturns: overturns, now: now) { continue }
            out.append(v)
        }
        return out
    }

    static func checkFreeze(_ f: OrgSigned<OrgSeatFreeze>, records: [OrgAuthorityRecord], bindings: [String: VerifiedPqKeyBinding],
                            orgId: String, now: Int64, earlier: [OrgVerifiedFreeze]) throws -> OrgVerifiedFreeze {
        let b = f.body, order = try b.canonical()
        try need(b.orgId == orgId, "wrong-org")
        guard let r = records.first(where: { $0.version == b.oarVersion }) else { throw OrgAuthorityError("stale-oar") }
        try need(b.untilMs > b.issuedAt, "malformed")
        try need(b.untilMs - b.issuedAt <= freezeMaxMs, "freeze-too-long")
        let signers = try checkApprovals(f.approvals, orgId: orgId, oarVersion: b.oarVersion, order: order, now: now,
                                         keyOf: { bindings["\(b.oarVersion):\($0)"] },
                                         frozenAt: { s, t in earlier.contains { $0.seatId == s && $0.issuedAt <= t && t < $0.untilMs } })
        try need(signers.count == 1, "threshold")
        try need(r.admins.first { $0.seatId == signers[0] }?.kind == .admin, "not-an-admin")
        try need(signers[0] != b.seatId, "freeze-self")
        return OrgVerifiedFreeze(seatId: b.seatId, bySeatId: signers[0], issuedAt: b.issuedAt, untilMs: b.untilMs, sha256: sha256Hex(order))
    }

    static func overturned(_ v: OrgVerifiedFreeze, records: [OrgAuthorityRecord], bindings: [String: VerifiedPqKeyBinding], orgId: String,
                           overturns: [OrgSigned<OrgOverturn>], now: Int64) -> Bool {
        for o in overturns where o.body.orgId == orgId && o.body.freezeSha256 == v.sha256 {
            guard let r = records.first(where: { $0.version == o.body.oarVersion }), let order = try? o.body.canonical(),
                  let signers = try? checkApprovals(o.approvals, orgId: orgId, oarVersion: r.version, order: order, now: now,
                                                    keyOf: { bindings["\(r.version):\($0)"] }, frozenAt: { _, _ in false })
            else { continue }
            let set = Set(overturnSet(r).filter { $0 != v.seatId })
            if signers.filter({ set.contains($0) }).count >= overturnThreshold(r) { return true }
        }
        return false
    }

    // MARK: the chain

    public static func verifyChain(_ entries: [OrgAuthorityEntry], genesisHash: String, now: Int64,
                                   freezes: [OrgSigned<OrgSeatFreeze>] = [], overturns: [OrgSigned<OrgOverturn>] = [],
                                   vetoes: [OrgSigned<OrgVeto>] = [],
                                   noticeOpenedAt: [String: Int64] = [:]) throws -> OrgAuthorityState {
        try need(!entries.isEmpty, "malformed", "empty chain")
        var records: [OrgAuthorityRecord] = []
        var bindings: [String: VerifiedPqKeyBinding] = [:]
        // One delayed change at a time: each is observed only after the one before it took effect.
        var lastDelayedAt: Int64 = -1
        for e in entries {
            let r = e.record
            try checkShape(r)
            try need(r.issuedAt <= now + maxSkewMs, "future")
            var verified: [String: VerifiedPqKeyBinding] = [:]
            for a in r.admins {
                verified[a.seatId] = try verifySeatBinding(a.binding, role: "org-seat-admin", orgId: r.orgId, seatId: a.seatId, now: now)
            }
            let order = try canonicalAuthority(r)
            if let p = records.last {
                try need(r.orgId == p.orgId, "wrong-org")
                try need(r.version == p.version + 1, "version-gap")
                try need(r.prevHash == (try authorityHash(p)), "prev-hash")
                try need(r.issuedAt > p.issuedAt, "not-after-previous")
                let fs = verifiedFreezes(records: records, bindings: bindings, orgId: r.orgId, freezes: freezes, overturns: overturns, now: now)
                let frozen: (String, Int64) -> Bool = { s, t in fs.contains { $0.seatId == s && $0.issuedAt <= t && t < $0.untilMs } }
                try verifyTransition(e, p: p, records: records, bindings: bindings, verified: verified, frozen: frozen, vetoes: vetoes, now: now,
                                     noticeOpenedAt: noticeOpenedAt, lastDelayedAt: lastDelayedAt)
                if e.via == "founder-removal" || e.via == "recovery" { lastDelayedAt = r.issuedAt }
            } else {
                try need(e.via == "genesis" && r.version == 0 && r.prevHash == genesisPrev, "version-gap", "genesis")
                try need((try authorityHash(r)) == genesisHash, "prev-hash", "genesis hash")
                let signers = try checkApprovals(e.approvals, orgId: r.orgId, oarVersion: 0, order: order, now: now,
                                                 keyOf: { verified[$0] }, frozenAt: { _, _ in false })
                for a in r.admins { try need(signers.contains(a.seatId), "consent-missing", a.seatId) }
            }
            records.append(r)
            for (s, b) in verified { bindings["\(r.version):\(s)"] = b }
        }
        return OrgAuthorityState(records: records, bindings: bindings)
    }

    static func verifyTransition(_ e: OrgAuthorityEntry, p: OrgAuthorityRecord, records: [OrgAuthorityRecord],
                                 bindings: [String: VerifiedPqKeyBinding], verified: [String: VerifiedPqKeyBinding],
                                 frozen: @escaping (String, Int64) -> Bool, vetoes: [OrgSigned<OrgVeto>], now: Int64,
                                 noticeOpenedAt: [String: Int64] = [:], lastDelayedAt: Int64 = -1) throws {
        let r = e.record, order = try canonicalAuthority(r)
        let prevKey: (String) -> VerifiedPqKeyBinding? = { bindings["\(p.version):\($0)"] }
        let kindOf: (String) -> OrgAdminKind? = { s in p.admins.first { $0.seatId == s }?.kind }
        let removed = p.admins.filter { a in !r.admins.contains { $0.seatId == a.seatId } }.map(\.seatId)
        let newcomers = r.admins.filter { a in
            guard let old = p.admins.first(where: { $0.seatId == a.seatId }) else { return true }
            return old.binding.ed25519PubHex != a.binding.ed25519PubHex || old.binding.mldsaPubHex != a.binding.mldsaPubHex
        }.map(\.seatId)
        let bylawsChanged = (try canonicalBylaws(p.bylaws)) != (try canonicalBylaws(r.bylaws))
        let founderMoved = p.founderSeatId != r.founderSeatId
        let consent = e.approvals.filter { newcomers.contains($0.seatId) && $0.oarVersion == r.version }
        let ordinary = e.approvals.filter { a in !consent.contains(a) }
        let consenting = try checkApprovals(consent, orgId: r.orgId, oarVersion: r.version, order: order, now: now,
                                            keyOf: { verified[$0] }, frozenAt: { _, _ in false })
        for n in newcomers { try need(consenting.contains(n), "consent-missing", n) }
        if founderMoved && !newcomers.contains(r.founderSeatId) {
            try need(ordinary.contains { $0.seatId == r.founderSeatId }, "consent-missing", "new founder")
        }
        // A veto counts inside the window `.com` observed: [openedAt, openedAt + wait).
        func vetoSigners(_ v: OrgSigned<OrgVeto>, _ noticeHash: String, openedAt: Int64, wait: Int64) -> [String]? {
            guard v.body.orgId == p.orgId, v.body.noticeSha256 == noticeHash, v.body.issuedAt >= openedAt, v.body.issuedAt < openedAt + wait,
                  let o = try? v.body.canonical() else { return nil }
            return try? checkApprovals(v.approvals, orgId: p.orgId, oarVersion: p.version, order: o, now: now, keyOf: prevKey, frozenAt: frozen)
        }
        // The notice is dated near when `.com` saw it, seen after the previous delayed change took effect, and applies
        // only once `wait` has passed since then. Returns the observed open time.
        func checkNotice(_ n: OrgSigned<OrgDelayedChange>, wait: Int64) throws -> Int64 {
            let b = n.body
            let hash = sha256Hex(try b.canonical())
            try need(b.orgId == p.orgId && b.oarVersion == p.version, "notice-invalid", "version")
            try need(r.issuedAt == b.effectiveAt, "notice-invalid", "date")
            try need(b.nextRecordSha256 == (try authorityHash(r)), "notice-invalid", "names another record")
            try need(b.effectiveAt == b.issuedAt + wait, "notice-invalid", "period")
            try need(b.issuedAt >= p.issuedAt, "notice-invalid", "older")
            guard let openedAt = noticeOpenedAt[hash], openedAt >= 0 else { throw OrgAuthorityError("notice-unobserved") }
            try need(openedAt >= lastDelayedAt, "notice-overlap")
            try need(abs(b.issuedAt - openedAt) <= maxSkewMs, "notice-backdated")
            try need(now >= max(b.effectiveAt, openedAt + wait), "notice-early")
            return openedAt
        }
        switch e.via {
        case "direct":
            let signers = try checkApprovals(ordinary, orgId: r.orgId, oarVersion: p.version, order: order, now: now, keyOf: prevKey, frozenAt: frozen)
            for s in signers {
                try need(kindOf(s) == .admin, "not-an-admin", s)
                try need(!removed.contains(s), "removed-signer", s)
            }
            let k = bylawsChanged || founderMoved ? bylawsThreshold(p) : p.kGov
            try need(signers.count >= k, "threshold")
            try checkQuorumCustody(p, k: k, signers: signers, custodyOf: adminCustody(p))
        case "founder-removal":
            guard let n = e.notice, n.body.kind == "founder-removal" else { throw OrgAuthorityError("notice-invalid") }
            try need(removed.count == 1, "notice-invalid", "exactly one admin")
            try need((try authorityHash(try founderRemovalOf(p, target: removed[0], issuedAt: r.issuedAt))) == (try authorityHash(r)),
                     "notice-invalid", "record is not the removal")
            let openedAt = try checkNotice(n, wait: founderNoticeMs)
            let signers = try checkApprovals(n.approvals, orgId: p.orgId, oarVersion: p.version, order: try n.body.canonical(), now: now,
                                             keyOf: prevKey, frozenAt: frozen)
            try need(signers == [p.founderSeatId], "notice-invalid", "only the founder")
            let noticeHash = sha256Hex(try n.body.canonical())
            let eligible = Set(p.admins.filter { $0.kind == .admin && $0.seatId != p.founderSeatId && $0.seatId != removed[0] }.map(\.seatId))
            let set = Set(overturnSet(p).filter { $0 != removed[0] })
            for v in vetoes {
                guard let c = vetoSigners(v, noticeHash, openedAt: openedAt, wait: founderNoticeMs) else { continue }
                if c.filter({ eligible.contains($0) }).count >= p.bylaws.vetoK { throw OrgAuthorityError("notice-vetoed") }
                if c.filter({ set.contains($0) }).count >= overturnThreshold(p) { throw OrgAuthorityError("notice-vetoed") }
            }
            try need(e.approvals.count == consent.count, "malformed", "stray approvals")
        case "recovery":
            guard let n = e.notice, n.body.kind == "recovery" else { throw OrgAuthorityError("notice-invalid") }
            let openedAt = try checkNotice(n, wait: recoveryNoticeMs)
            let signers = try checkApprovals(n.approvals, orgId: p.orgId, oarVersion: p.version, order: try n.body.canonical(), now: now,
                                             keyOf: prevKey, frozenAt: frozen)
            for s in signers { try need(kindOf(s) == .admin || kindOf(s) == .recovery, "not-an-admin", s) }
            try need(signers.contains { kindOf($0) == .recovery }, "notice-invalid", "no recovery seat")
            let k = bylawsChanged || founderMoved ? bylawsThreshold(p) : p.kGov
            try need(signers.count >= k, "threshold")
            try checkQuorumCustody(p, k: k, signers: signers, custodyOf: adminCustody(p))
            let noticeHash = sha256Hex(try n.body.canonical())
            let eligible = Set(p.admins.filter { $0.kind == .admin && !signers.contains($0.seatId) }.map(\.seatId))
            for v in vetoes { if let c = vetoSigners(v, noticeHash, openedAt: openedAt, wait: recoveryNoticeMs), c.contains(where: { eligible.contains($0) }) { throw OrgAuthorityError("notice-vetoed") } }
            try need(e.approvals.count == consent.count, "malformed", "stray approvals")
        case "overturn":
            guard let at = e.overturnOf, at >= 1, at <= p.version, let idx = records.firstIndex(where: { $0.version == at }), idx >= 1
            else { throw OrgAuthorityError("overturn-invalid") }
            let after = records[idx], before = records[idx - 1]
            try need(before.founderSeatId == after.founderSeatId, "overturn-invalid")
            let removedThen = before.admins.filter { a in !after.admins.contains { $0.seatId == a.seatId } }
            try need(removedThen.count == 1, "overturn-invalid", "not a founder removal")
            try need((try authorityHash(try founderRemovalOf(before, target: removedThen[0].seatId, issuedAt: after.issuedAt))) == (try authorityHash(after)),
                     "overturn-invalid", "not a founder removal")
            let restored = removedThen[0].seatId
            try need(!p.admins.contains { $0.seatId == restored }, "overturn-invalid", "already back")
            try need((try authorityHash(try overturnOf(p, before: before, after: after, issuedAt: r.issuedAt))) == (try authorityHash(r)),
                     "overturn-invalid", "record is not the restore")
            let restoredConsent = e.approvals.filter { $0.seatId == restored && $0.oarVersion == r.version }
            let others = e.approvals.filter { a in !restoredConsent.contains(a) }
            let back = try checkApprovals(restoredConsent, orgId: r.orgId, oarVersion: r.version, order: order, now: now,
                                          keyOf: { $0 == restored ? verified[$0] : nil }, frozenAt: { _, _ in false })
            try need(back.contains(restored), "consent-missing", restored)
            let signers = try checkApprovals(others, orgId: r.orgId, oarVersion: p.version, order: order, now: now, keyOf: prevKey, frozenAt: frozen)
            let set = Set(overturnSet(p))
            try need(signers.allSatisfy { set.contains($0) }, "not-an-admin", "outside the overturn set")
            try need(signers.count >= overturnThreshold(p), "threshold")
            try checkQuorumCustody(p, k: overturnThreshold(p), signers: signers, custodyOf: adminCustody(p))
        default:
            throw OrgAuthorityError("malformed", "via")
        }
    }

    // MARK: seat book

    public static func buildSeatBook(_ st: OrgAuthorityState, grants: [OrgSeatGrantBundle], revokes: [OrgSeatRevokeBundle],
                                     freezes: [OrgSigned<OrgSeatFreeze>] = [], overturns: [OrgSigned<OrgOverturn>] = [], now: Int64) -> OrgSeatBook {
        var book = OrgSeatBook()
        book.freezes = verifiedFreezes(records: st.records, bindings: st.bindings, orgId: st.orgId, freezes: freezes, overturns: overturns, now: now)
        let fs = book.freezes
        let frozen: (String, Int64) -> Bool = { s, t in fs.contains { $0.seatId == s && $0.issuedAt <= t && t < $0.untilMs } }
        func code(_ e: Error) -> String { (e as? OrgAuthorityError)?.code ?? "malformed" }
        for v in revokes {
            do { try verifyRevoke(st, v, grants: grants, frozen: frozen, now: now); book.revoked.insert(v.seatId) }
            catch { book.refused.append((v.seatId, code(error))) }
        }
        for g in grants.enumerated().sorted(by: { ($0.element.grant.issuedAt, $0.offset) < ($1.element.grant.issuedAt, $1.offset) }).map(\.element) {
            do {
                try need(!book.revoked.contains(g.grant.seatId), "seat-revoked")
                let seat = try verifyGrant(st, g, frozen: frozen, now: now)
                if let prev = book.seats[seat.seatId], prev.grant.issuedAt >= seat.grant.issuedAt { continue }
                book.seats[seat.seatId] = seat
            } catch { book.refused.append((g.grant.seatId, code(error))) }
        }
        return book
    }

    public static func verifyGrant(_ st: OrgAuthorityState, _ b: OrgSeatGrantBundle, frozen: (String, Int64) -> Bool, now: Int64) throws -> OrgSeat {
        let g = b.grant, order = try g.canonical()
        try need(g.orgId == st.orgId, "wrong-org")
        try need((try rolesHash(b.roles)) == g.rolesHash, "order-mismatch", "roles")
        try need(g.expiresAt > now, "expired")
        guard let r = st.record(g.oarVersion) else { throw OrgAuthorityError("stale-oar") }
        let member = try verifySeatBinding(b.memberBinding, role: "org-seat-member", orgId: g.orgId, seatId: g.seatId, now: now)
        try need(member.keyIdHex == g.memberKeyId, "binding", "member key id")
        var admin: VerifiedPqKeyBinding?
        if !g.adminKeyId.isEmpty {
            guard let ab = b.adminBinding else { throw OrgAuthorityError("binding", "admin binding missing") }
            admin = try verifySeatBinding(ab, role: "org-seat-admin", orgId: g.orgId, seatId: g.seatId, now: now)
            try need(admin?.keyIdHex == g.adminKeyId, "binding", "admin key id")
        } else {
            try need(!b.roles.contains { $0.raisesAdmin }, "binding", "an admin role needs an admin key")
        }
        if g.custody == .browser {
            try need(!g.adminKeyId.isEmpty, "malformed", "custody without an admin key")
            try need(!(r.bylaws.hardwareAdmins && b.roles.contains { $0.raisesAdmin }), "custody", "the bylaws need hardware custody for admins")
        }
        let signers = try checkApprovals(b.approvals, orgId: g.orgId, oarVersion: g.oarVersion, order: order, now: now,
                                         keyOf: { st.binding(g.oarVersion, $0) }, frozenAt: frozen)
        for s in signers { try need(r.admins.first { $0.seatId == s }?.kind == .admin, "not-an-admin", s) }
        try need(signers.count >= grantThreshold(r, b.roles), "threshold")
        try checkQuorumCustody(r, k: grantThreshold(r, b.roles), signers: signers, custodyOf: adminCustody(r))
        return OrgSeat(seatId: g.seatId, roles: b.roles, member: member, admin: admin, grant: g)
    }

    static func verifyRevoke(_ st: OrgAuthorityState, _ v: OrgSeatRevokeBundle, grants: [OrgSeatGrantBundle],
                             frozen: (String, Int64) -> Bool, now: Int64) throws {
        let order = try v.canonical()
        try need(v.orgId == st.orgId, "wrong-org")
        try need(!st.current.admins.contains { $0.seatId == v.seatId }, "seat-is-org-admin")
        guard let r = st.record(v.oarVersion) else { throw OrgAuthorityError("stale-oar") }
        if let selfSig = v.selfSignature {
            try need(v.reason == "left", "malformed", "a leave says left")
            for g in grants where g.grant.seatId == v.seatId && g.grant.orgId == v.orgId {
                guard let m = try? verifySeatBinding(g.memberBinding, role: "org-seat-member", orgId: v.orgId, seatId: v.seatId, now: now),
                      m.keyIdHex == g.grant.memberKeyId, let sig = PqBin.unhex(selfSig) else { continue }
                if (try? PqHybrid.hybridVerify(publicKey: m.hybridPublicKey, purpose: tagSeatRevoke, payload: order, signature: sig)) != nil { return }
            }
            throw OrgAuthorityError("bad-signature", "leave")
        }
        let signers = try checkApprovals(v.approvals, orgId: v.orgId, oarVersion: v.oarVersion, order: order, now: now,
                                         keyOf: { st.binding(v.oarVersion, $0) }, frozenAt: frozen)
        try need(!signers.isEmpty, "threshold")
        for s in signers { try need(r.admins.first { $0.seatId == s }?.kind == .admin, "not-an-admin", s) }
    }

    // MARK: the predicate

    static func covers(_ seat: OrgSeat, _ action: OrgAction) -> Bool {
        for r in seat.roles {
            switch (action, r) {
            case (.addServer, .serversAdd): return true
            case (.operate(let s), .serverAdmin(let servers)), (.appAdmin(let s, _), .serverAdmin(let servers)):
                if servers == nil || servers!.contains(s) { return true }
            case (.appAdmin(_, let ref), .serviceAdmin(let apps)):
                if apps.contains(ref) { return true }
            default: continue
            }
        }
        return false
    }

    /// Who authorizes `order` for `action`; returns the scoped seat when one seat outside the org admins did.
    public static func authorize(state: OrgAuthorityState, book: OrgSeatBook, action: OrgAction, order: [UInt8],
                                 approvals: [OrgApproval], now: Int64) throws -> (signers: [String], scopedSeat: String?) {
        let cur = state.current
        guard let first = approvals.first else { throw OrgAuthorityError("threshold", "no approvals") }
        let prev = state.record(cur.version - 1)
        let version = first.oarVersion
        try need(version == cur.version || (prev != nil && version == prev!.version && now - cur.issuedAt <= previousOarGraceMs), "stale-oar")
        let at = version == cur.version ? cur : prev!
        let frozen: (String, Int64) -> Bool = { s, t in
            book.freezes.contains { $0.seatId == s && (($0.issuedAt <= t && t < $0.untilMs) || ($0.issuedAt <= now && now < $0.untilMs)) }
        }
        let keyOf: (String) -> VerifiedPqKeyBinding? = { s in
            if let here = at.admins.first(where: { $0.seatId == s }) {
                let still = cur.admins.contains { $0.seatId == s && $0.kind == here.kind && $0.binding.ed25519PubHex == here.binding.ed25519PubHex
                    && $0.binding.mldsaPubHex == here.binding.mldsaPubHex }
                return still ? state.binding(at.version, s) : nil
            }
            if book.revoked.contains(s) { return nil }
            return book.seats[s]?.admin
        }
        for a in approvals { try need(a.notAfter >= now, "expired", a.seatId) }
        let signers = try checkApprovals(approvals, orgId: state.orgId, oarVersion: version, order: order, now: now, keyOf: keyOf, frozenAt: frozen)
        let orgAdmins = signers.filter { s in at.admins.first { $0.seatId == s }?.kind == .admin }
        let others = signers.filter { !orgAdmins.contains($0) }
        for s in others {
            try need(!at.admins.contains { $0.seatId == s }, "not-an-admin", s)
            try need(!book.revoked.contains(s), "seat-revoked", s)
        }
        func needK(_ k: Int) throws -> (signers: [String], scopedSeat: String?) {
            try need(others.isEmpty, "scope", "a seat outside the org admins")
            try need(orgAdmins.count >= k, "threshold")
            try checkQuorumCustody(at, k: k, signers: orgAdmins, custodyOf: adminCustody(at))
            return (signers, nil)
        }
        switch action {
        case .seatGrant(let roles): return try needK(grantThreshold(at, roles))
        case .seatInvite, .seatRevoke, .freeze: return try needK(1)
        case .destroy: return try needK(at.kDestroy)
        case .site: return try needK(at.kSite)
        case .addServer, .operate, .appAdmin:
            if !orgAdmins.isEmpty && others.isEmpty { return (signers, nil) }
            try need(signers.count == 1, "scope", "one scoped seat signs alone")
            guard let seat = book.seats[others[0]], seat.grant.expiresAt > now else { throw OrgAuthorityError("seat-unknown") }
            try need(covers(seat, action), "scope")
            return (signers, seat.seatId)
        }
    }

    /// The seats whose pending approvals of `order` verify (a ceremony's approvals, a veto, as `.com` takes them):
    /// anyone in the current record or a seat with an admin key, each approval unexpired, not frozen when it signed
    /// nor now, under the current record (or the previous one within 24 h). Counts nothing (`verifyOrgApprovers`).
    public static func verifyApprovers(state: OrgAuthorityState, book: OrgSeatBook, order: [UInt8], approvals: [OrgApproval], now: Int64,
                                       allowFrozenSeat: String? = nil) throws -> [String] {
        let cur = state.current
        guard let first = approvals.first else { throw OrgAuthorityError("threshold", "no approvals") }
        let prev = state.record(cur.version - 1)
        let version = first.oarVersion
        try need(version == cur.version || (prev != nil && version == prev!.version && now - cur.issuedAt <= previousOarGraceMs), "stale-oar")
        let at = version == cur.version ? cur : prev!
        for a in approvals { try need(a.notAfter >= now, "expired", a.seatId) }
        let keyOf: (String) -> VerifiedPqKeyBinding? = { s in
            if let here = at.admins.first(where: { $0.seatId == s }) {
                let still = cur.admins.contains { $0.seatId == s && $0.kind == here.kind && $0.binding.ed25519PubHex == here.binding.ed25519PubHex
                    && $0.binding.mldsaPubHex == here.binding.mldsaPubHex }
                return still ? state.binding(at.version, s) : nil
            }
            if book.revoked.contains(s) { return nil }
            return book.seats[s]?.admin
        }
        let frozen: (String, Int64) -> Bool = { s, t in
            s != allowFrozenSeat && book.freezes.contains { $0.seatId == s && (($0.issuedAt <= t && t < $0.untilMs) || ($0.issuedAt <= now && now < $0.untilMs)) }
        }
        return try checkApprovals(approvals, orgId: state.orgId, oarVersion: version, order: order, now: now, keyOf: keyOf, frozenAt: frozen)
    }
}
