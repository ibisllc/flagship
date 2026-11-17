import Foundation

/// Planning a key rotation on a phone (packages/protocol/src/orgKeyRing.ts: verifyOrgSeatKem,
/// verifyOrgBoxKem, orgKeyRecipientAllowed, buildOrgKeyRings, orgPendingRotations,
/// planOrgKeyRecipients, rotateOrgKey); twin of Android `OrgRotation`. Everything `.com` serves is
/// checked under the chain and seat book this phone verified: a new key is sealed only to
/// recipients the phone accepts, and the "who left" list is computed here.
public struct OrgKeyRingBundle {
    public var ring: OrgKeyRing
    public var recipients: [OrgKeyRecipient]
    public var approvals: [OrgApproval]
    public var json: [String: Any] { ["ring": ring.json, "recipients": recipients.map(\.json), "approvals": approvals.map(\.jsonObject)] }

    public static func fromWire(_ w: Any?) throws -> OrgKeyRingBundle {
        guard let o = w as? [String: Any], let rs = o["recipients"] as? [[String: Any]] else { throw OrgAuthorityError("malformed", "bundle") }
        let recipients = try rs.map { x -> OrgKeyRecipient in
            guard let r = x["recipient"] as? String, let k = x["kemKeyId"] as? String, let s = x["sealedHex"] as? String else { throw OrgAuthorityError("malformed", "recipient") }
            return OrgKeyRecipient(recipient: r, kemKeyId: k, sealedHex: s)
        }
        return OrgKeyRingBundle(ring: try OrgKeyRing.fromWire(o["ring"]), recipients: recipients, approvals: try OrgAuthorityWire.approvals(o["approvals"]))
    }
}

public struct OrgPendingRotation: Identifiable, Equatable {
    public struct Key: Equatable { public let kind: OrgKeyKind; public let scope: String }
    public let seatId: String
    public let leftAt: Int64
    public let keys: [Key]
    public var id: String { seatId }
}

public struct OrgVerifiedKem { public let recipient: String; public let kemPub: [UInt8]; public let kemKeyId: String; public let issuedAt: Int64 }

public struct OrgKeyContext {
    public let state: OrgAuthorityState
    public let book: OrgSeatBook
    public let kems: [String: OrgVerifiedKem]
    public let servers: Set<String>
    public let now: Int64
}

public struct OrgRotationPlan {
    public let ctx: OrgKeyContext
    public let chains: [String: [OrgKeyRingBundle]]
    public let pending: [OrgPendingRotation]
}

public enum OrgRotation {
    static func need(_ ok: Bool, _ code: String, _ detail: String = "") throws { if !ok { throw OrgAuthorityError(code, detail) } }
    static func orgWide(_ k: OrgKeyKind) -> Bool { k == .cgk || k == .directoryKey || k == .wallet }
    public static func chainId(_ kind: OrgKeyKind, _ scope: String) -> String { "\(kind.rawValue)|\(scope)" }
    static let zero64 = String(repeating: "0", count: 64)

    static func seatSigningKey(_ st: OrgAuthorityState, _ book: OrgSeatBook, _ seatId: String, _ now: Int64) -> VerifiedPqKeyBinding? {
        if st.current.admins.contains(where: { $0.seatId == seatId }) { return st.binding(st.current.version, seatId) }
        if book.revoked.contains(seatId) { return nil }
        guard let seat = book.seats[seatId], seat.grant.expiresAt > now else { return nil }
        return seat.member
    }

    public static func verifySeatKem(_ st: OrgAuthorityState, _ book: OrgSeatBook, statement s: [String: Any], kemPubHex: String, signatureHex: String, now: Int64) throws -> OrgVerifiedKem {
        let orgId = try OrgAuthorityWire.str(s, "orgId"), seatId = try OrgAuthorityWire.str(s, "seatId")
        let kemKeyId = try OrgAuthorityWire.str(s, "kemKeyId"), issuedAt = try OrgAuthorityWire.num(s, "issuedAt")
        let msg = try OrgAuthority.canonicalSeatKem(orgId: orgId, seatId: seatId, kemKeyId: kemKeyId, issuedAt: issuedAt)
        try need(orgId == st.orgId, "wrong-org")
        try need(issuedAt <= now + OrgAuthority.maxSkewMs, "future")
        guard let kemPub = PqBin.unhex(kemPubHex) else { throw OrgAuthorityError("binding", "kem key") }
        try need(OrgAuthority.kemKeyIdHex(kemPub) == kemKeyId, "binding", "kem key id")
        guard let key = seatSigningKey(st, book, seatId, now) else { throw OrgAuthorityError("seat-unknown", seatId) }
        guard let sig = PqBin.unhex(signatureHex), sig.count == PqHybrid.sigLen else { throw OrgAuthorityError("bad-signature") }
        do { try PqHybrid.hybridVerify(publicKey: key.hybridPublicKey, purpose: OrgAuthority.tagSeatKem, payload: msg, signature: sig) } catch {
            throw OrgAuthorityError("bad-signature")
        }
        return OrgVerifiedKem(recipient: "seat:\(seatId)", kemPub: kemPub, kemKeyId: kemKeyId, issuedAt: issuedAt)
    }

    public static func verifyBoxKem(orgId: String, statement s: [String: Any], kemPubHex: String, signatureHex: String, stkPubHex: String, now: Int64) throws -> OrgVerifiedKem {
        let sOrg = try OrgAuthorityWire.str(s, "orgId"), domain = try OrgAuthorityWire.str(s, "serverDomain")
        let kemKeyId = try OrgAuthorityWire.str(s, "kemKeyId"), issuedAt = try OrgAuthorityWire.num(s, "issuedAt")
        let msg = try OrgAuthority.canonicalBoxKem(orgId: sOrg, serverDomain: domain, kemKeyId: kemKeyId, issuedAt: issuedAt)
        try need(sOrg == orgId, "wrong-org")
        try need(issuedAt <= now + OrgAuthority.maxSkewMs, "future")
        guard let kemPub = PqBin.unhex(kemPubHex) else { throw OrgAuthorityError("binding", "kem key") }
        try need(OrgAuthority.kemKeyIdHex(kemPub) == kemKeyId, "binding", "kem key id")
        guard let sig = PqBin.unhex(signatureHex), sig.count == 64, let pub = PqBin.unhex(stkPubHex), pub.count == 32,
              PqHybrid.ed25519VerifyStrict(signature: sig, message: msg, publicKey: pub) else { throw OrgAuthorityError("bad-signature") }
        return OrgVerifiedKem(recipient: "box:\(domain)", kemPub: kemPub, kemKeyId: kemKeyId, issuedAt: issuedAt)
    }

    public static func recipientAllowed(_ ctx: OrgKeyContext, _ kind: OrgKeyKind, _ scope: String, _ recipient: String) -> Bool {
        if recipient.hasPrefix("box:") {
            let d = String(recipient.dropFirst(4))
            guard ctx.servers.contains(d) else { return false }
            switch kind { case .cgk: return true; case .directoryKey, .wallet: return false; default: return d == scope }
        }
        let seatId = String(recipient.dropFirst(5))
        if ctx.state.current.admins.contains(where: { $0.seatId == seatId && $0.kind == .admin }) { return true }
        if ctx.book.revoked.contains(seatId) { return false }
        guard let seat = ctx.book.seats[seatId], seat.grant.expiresAt > ctx.now else { return false }
        if ctx.book.freezes.contains(where: { $0.seatId == seatId && $0.issuedAt <= ctx.now && ctx.now < $0.untilMs }) { return false }
        if orgWide(kind) { return false }
        return seat.roles.contains { r in
            switch r {
            case .serverAdmin(let s): return s == nil || s!.contains(scope)
            case .unlock(let s): return kind == .diskKey && s.contains(scope)
            default: return false
            }
        }
    }

    /// `verifyOrgRecordedApprovals`: the approvals as of the record they name.
    static func recordedApprovals(_ st: OrgAuthorityState, _ book: OrgSeatBook, order: [UInt8], approvals: [OrgApproval], oarVersion: Int64, now: Int64, scoped: OrgAction?) throws {
        guard let r = st.record(oarVersion) else { throw OrgAuthorityError("stale-oar") }
        try need(!approvals.isEmpty, "threshold", "no approvals")
        let frozen = { (s: String, t: Int64) in book.freezes.contains { $0.seatId == s && $0.issuedAt <= t && t < $0.untilMs } }
        let signers = try OrgAuthority.checkApprovals(approvals, orgId: st.orgId, oarVersion: oarVersion, order: order, now: now, keyOf: { s in
            if r.admins.contains(where: { $0.seatId == s }) { return st.binding(oarVersion, s) }
            if scoped == nil || book.revoked.contains(s) { return nil }
            return book.seats[s]?.admin
        }, frozenAt: frozen)
        let admins = signers.filter { s in r.admins.first(where: { $0.seatId == s })?.kind == .admin }
        if !admins.isEmpty && admins.count == signers.count { return }
        guard let scoped, signers.count == 1 else { throw OrgAuthorityError("scope", "one org admin, or one scoped seat alone") }
        guard let seat = book.seats[signers[0]], seat.grant.expiresAt > now, OrgAuthority.covers(seat, scoped) else { throw OrgAuthorityError("scope", signers[0]) }
    }

    static func verifyStored(_ ctx: OrgKeyContext, _ b: OrgKeyRingBundle, prev: OrgKeyRing?) throws {
        let r = b.ring
        let order = try OrgAuthority.canonicalKeyRing(r)
        try need(r.orgId == ctx.state.orgId, "wrong-org")
        try need(r.issuedAt <= ctx.now + OrgAuthority.maxSkewMs, "future")
        if let prev {
            try need(r.version == prev.version + 1, "version-gap")
            try need(r.prevSha256 == (try OrgAuthority.keyRingSha256(prev)), "prev-hash")
            try need(prev.kind == r.kind && prev.scope == r.scope, "malformed", "another key")
            try need(r.issuedAt > prev.issuedAt, "not-after-previous")
        } else {
            try need(r.version == 1 && r.prevSha256 == zero64, "version-gap")
        }
        try need((try OrgAuthority.recipientsHash(b.recipients)) == r.recipientsHash, "order-mismatch", "recipients")
        try need(!b.recipients.contains { $0.recipient.hasPrefix("seat:") && r.retired.contains(String($0.recipient.dropFirst(5))) }, "scope", "a retired seat is a recipient")
        try recordedApprovals(ctx.state, ctx.book, order: order, approvals: b.approvals, oarVersion: r.oarVersion, now: ctx.now,
                              scoped: r.scope == "*" ? nil : .operate(server: r.scope))
    }

    /// Every stored version, chain by chain; a version that fails stops its chain.
    public static func buildChains(_ ctx: OrgKeyContext, _ bundles: [OrgKeyRingBundle]) -> [String: [OrgKeyRingBundle]] {
        var out: [String: [OrgKeyRingBundle]] = [:]
        for (id, list) in Dictionary(grouping: bundles, by: { chainId($0.ring.kind, $0.ring.scope) }) {
            var ok: [OrgKeyRingBundle] = []
            for b in list.sorted(by: { $0.ring.version < $1.ring.version }) {
                do { try verifyStored(ctx, b, prev: ok.last?.ring); ok.append(b) } catch { break }
            }
            if !ok.isEmpty { out[id] = ok }
        }
        return out
    }

    static func rotationDone(_ chains: [String: [OrgKeyRingBundle]], _ kind: OrgKeyKind, _ scope: String, _ seatId: String, _ leftAt: Int64) -> Bool {
        (chains[chainId(kind, orgWide(kind) ? "*" : scope)] ?? []).contains { b in
            b.ring.issuedAt >= leftAt && !b.recipients.contains { $0.recipient == "seat:\(seatId)" }
        }
    }

    /// `orgPendingRotations`: what every departed seat still leaves to rotate.
    public static func pending(_ st: OrgAuthorityState, _ book: OrgSeatBook, _ chains: [String: [OrgKeyRingBundle]],
                               revokes: [OrgSeatRevokeBundle], grants: [OrgSeatGrantBundle]) -> [OrgPendingRotation] {
        var left: [String: Int64] = [:]
        for r in revokes where book.revoked.contains(r.seatId) { left[r.seatId] = min(left[r.seatId] ?? Int64.max, r.issuedAt) }
        let current = Set(st.current.admins.map(\.seatId))
        if st.records.count > 1 {
            for i in 1..<st.records.count {
                let before = st.records[i - 1], at = st.records[i]
                for a in before.admins where !at.admins.contains(where: { $0.seatId == a.seatId }) && !current.contains(a.seatId) && left[a.seatId] == nil {
                    left[a.seatId] = at.issuedAt
                }
            }
        }
        var out: [OrgPendingRotation] = []
        for (seatId, leftAt) in left {
            var keys: [OrgPendingRotation.Key] = []
            for chain in chains.values {
                let r = chain[0].ring
                guard chain.contains(where: { b in b.recipients.contains { $0.recipient == "seat:\(seatId)" } }) else { continue }
                if !rotationDone(chains, r.kind, r.scope, seatId, leftAt) { keys.append(.init(kind: r.kind, scope: r.scope)) }
            }
            var unlock = Set<String>()
            for g in grants where g.grant.seatId == seatId {
                for role in g.roles { if case .unlock(let s) = role { s.forEach { unlock.insert($0) } } }
            }
            for s in unlock where !rotationDone(chains, .diskKey, s, seatId, leftAt) && !keys.contains(where: { $0.kind == .diskKey && $0.scope == s }) {
                keys.append(.init(kind: .diskKey, scope: s))
            }
            if !keys.isEmpty {
                out.append(OrgPendingRotation(seatId: seatId, leftAt: leftAt, keys: keys.sorted { $0.kind.rawValue + $0.scope < $1.kind.rawValue + $1.scope }))
            }
        }
        return out.sorted { $0.leftAt != $1.leftAt ? $0.leftAt < $1.leftAt : $0.seatId < $1.seatId }
    }

    public static func planRecipients(_ ctx: OrgKeyContext, _ kind: OrgKeyKind, _ scope: String, retired: [String]) -> [OrgKemKey] {
        ctx.kems.values
            .filter { !($0.recipient.hasPrefix("seat:") && retired.contains(String($0.recipient.dropFirst(5)))) }
            .filter { recipientAllowed(ctx, kind, scope, $0.recipient) }
            .sorted { $0.recipient < $1.recipient }
            .map { OrgKemKey(recipient: $0.recipient, kemPub: $0.kemPub, kemKeyId: $0.kemKeyId) }
    }

    /// One rotation ready for `POST /api/orgs/<id>/keys`; `approve` signs the ring with this phone's seat admin key.
    public static func rotate(_ plan: OrgRotationPlan, kind: OrgKeyKind, scope: String, issuedAt: Int64, key: [UInt8],
                              approve: ([UInt8], Int64) throws -> OrgApproval) throws -> OrgKeyRingBundle {
        let s = orgWide(kind) ? "*" : scope
        let prev = plan.chains[chainId(kind, s)]?.last?.ring
        let retired = plan.pending.filter { p in p.keys.contains { $0.kind == kind && $0.scope == s } }.map(\.seatId)
        let recipients = planRecipients(plan.ctx, kind, s, retired: retired)
        try need(!recipients.isEmpty, "seat-unknown", "no recipient may hold this key")
        let oar = plan.ctx.state.current.version
        let built = try OrgAuthority.buildKeyRing(orgId: plan.ctx.state.orgId, kind: kind, scope: s, prev: prev, key: key, recipients: recipients,
                                                  retired: retired, oarVersion: oar, issuedAt: issuedAt)
        return OrgKeyRingBundle(ring: built.ring, recipients: built.recipients, approvals: [try approve(try OrgAuthority.canonicalKeyRing(built.ring), oar)])
    }

    /// Verifies what `GET /keys`, `GET /servers` and `GET /seats` served into a plan.
    public static func planFromServed(_ st: OrgAuthorityState, _ book: OrgSeatBook, keys: [String: Any], servers: [String: Any],
                                      revokes: [OrgSeatRevokeBundle], grants: [OrgSeatGrantBundle], now: Int64) -> OrgRotationPlan {
        let live = ((servers["servers"] as? [[String: Any]]) ?? []).filter { o in
            o["revoked"] == nil || o["revoked"] is NSNull || (o["revoked"] as? Bool) == false
        }
        var stk: [String: String] = [:]
        for o in live { if let d = o["serverDomain"] as? String, let p = o["identityPubKeyHex"] as? String { stk[d] = p } }
        var found: [OrgVerifiedKem] = []
        for o in (keys["seatKems"] as? [[String: Any]]) ?? [] {
            if let s = o["statement"] as? [String: Any], let k = o["kemPubHex"] as? String, let sig = o["signature"] as? String,
               let v = try? verifySeatKem(st, book, statement: s, kemPubHex: k, signatureHex: sig, now: now) { found.append(v) }
        }
        for o in (keys["boxKems"] as? [[String: Any]]) ?? [] {
            if let s = o["statement"] as? [String: Any], let d = s["serverDomain"] as? String, let pub = stk[d], let k = o["kemPubHex"] as? String,
               let sig = o["signature"] as? String,
               let v = try? verifyBoxKem(orgId: st.orgId, statement: s, kemPubHex: k, signatureHex: sig, stkPubHex: pub, now: now) { found.append(v) }
        }
        var newest: [String: OrgVerifiedKem] = [:]
        for k in found where (newest[k.recipient]?.issuedAt ?? -1) < k.issuedAt { newest[k.recipient] = k }
        let ctx = OrgKeyContext(state: st, book: book, kems: newest, servers: Set(stk.keys), now: now)
        let bundles = ((keys["rings"] as? [Any]) ?? []).compactMap { try? OrgKeyRingBundle.fromWire($0) }
        let chains = buildChains(ctx, bundles)
        return OrgRotationPlan(ctx: ctx, chains: chains, pending: pending(st, book, chains, revokes: revokes, grants: grants))
    }
}
