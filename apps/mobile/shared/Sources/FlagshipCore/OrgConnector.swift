import Foundation
import CryptoKit

/// Directory connectors and their proposals (packages/protocol/src/orgConnector.ts; docs/org-directory.md
/// §2-§4), byte for byte, pinned by test-vectors/org-directory. A connector only proposes; an admin
/// opens a proposal's sealed entry with the seat KEM key, carries it out with the usual approvals and
/// records the decision.
public struct OrgConnector: Equatable {
    public var orgId: String, connectorId: String, kind: String, serverDomain: String, connectorKeyId: String
    public var scopes: [String], mappingSha256: String, status: String, issuedAt: Int64
    public static func fromWire(_ w: Any?) throws -> OrgConnector {
        guard let o = w as? [String: Any], let a = o["orgId"] as? String, let c = o["connectorId"] as? String, let k = o["kind"] as? String,
              let d = o["serverDomain"] as? String, let key = o["connectorKeyId"] as? String, let s = o["scopes"] as? [String],
              let m = o["mappingSha256"] as? String, let st = o["status"] as? String, let t = OrgAuthority.i64(o["issuedAt"]) else {
            throw OrgAuthorityError("malformed", "connector")
        }
        return OrgConnector(orgId: a, connectorId: c, kind: k, serverDomain: d, connectorKeyId: key, scopes: s, mappingSha256: m, status: st, issuedAt: t)
    }
}

public struct OrgProposal: Equatable {
    public var orgId: String, proposalId: String, connectorId: String, kind: String, subject: String, rolesHash: String, sealedSha256: String, issuedAt: Int64
    public static func fromWire(_ w: Any?) throws -> OrgProposal {
        guard let o = w as? [String: Any], let a = o["orgId"] as? String, let p = o["proposalId"] as? String, let c = o["connectorId"] as? String,
              let k = o["kind"] as? String, let s = o["subject"] as? String, let r = o["rolesHash"] as? String, let h = o["sealedSha256"] as? String,
              let t = OrgAuthority.i64(o["issuedAt"]) else { throw OrgAuthorityError("malformed", "proposal") }
        return OrgProposal(orgId: a, proposalId: p, connectorId: c, kind: k, subject: s, rolesHash: r, sealedSha256: h, issuedAt: t)
    }
}

public enum OrgConnectors {
    public static let tagConnector = "flagship/org-connector/v1"
    public static let tagProposal = "flagship/org-proposal/v1"
    public static let scopes = ["propose-invite", "propose-offboard", "update-entry"]
    static let hex16 = "^[0-9a-f]{32}$", hex32 = "^[0-9a-f]{64}$", domain = "^[a-z0-9][a-z0-9.-]{0,252}$"

    static func need(_ ok: Bool, _ code: String, _ d: String = "") throws { if !ok { throw OrgAuthorityError(code, d) } }
    static func t(_ s: String, _ p: String) -> Bool { OrgAuthority.token(s, p) }

    public static func canonicalConnector(_ c: OrgConnector) throws -> [UInt8] {
        try need(t(c.orgId, hex16) && t(c.connectorId, hex16) && ["scim", "ldap", "custom"].contains(c.kind) && t(c.serverDomain, domain)
                 && t(c.connectorKeyId, hex32) && t(c.mappingSha256, hex32) && ["active", "paused", "retired"].contains(c.status) && c.issuedAt >= 0, "malformed", "connector")
        try need(!c.scopes.isEmpty && c.scopes.allSatisfy { scopes.contains($0) } && c.scopes == Array(Set(c.scopes)).sorted(), "malformed", "scopes")
        return OrgAuthority.join([tagConnector, c.orgId, c.connectorId, c.kind, c.serverDomain, c.connectorKeyId, c.scopes.joined(separator: ","),
                                  c.mappingSha256, c.status, String(c.issuedAt)])
    }

    public static func connectorKeyId(_ pub: [UInt8]) throws -> String {
        try need(pub.count == 1984, "malformed", "connector key")
        return OrgAuthority.keyIdHex(ed25519PubHex: PqBin.hex(Array(pub[0..<32])), mldsaPubHex: PqBin.hex(Array(pub[32...])))
    }

    public static func scope(of kind: String) -> String { kind == "offboard" ? "propose-offboard" : kind == "entry-update" ? "update-entry" : "propose-invite" }

    public static func canonicalProposal(_ p: OrgProposal) throws -> [UInt8] {
        try need(t(p.orgId, hex16) && t(p.proposalId, hex16) && t(p.connectorId, hex16) && t(p.subject, hex16) && t(p.sealedSha256, hex32) && p.issuedAt >= 0,
                 "malformed", "proposal")
        try need(["invite", "offboard", "role-change", "entry-update"].contains(p.kind), "malformed", "kind")
        let needsRoles = p.kind == "invite" || p.kind == "role-change"
        try need(needsRoles ? t(p.rolesHash, hex32) : p.rolesHash.isEmpty, "malformed", "rolesHash")
        return OrgAuthority.join([tagProposal, p.orgId, p.proposalId, p.connectorId, p.kind, p.subject, p.rolesHash, p.sealedSha256, String(p.issuedAt)])
    }

    /// (recipient, kemKeyId, sealedHex) triples → the digest the proposal signs.
    public static func recipientsHash(_ r: [(recipient: String, kemKeyId: String, sealedHex: String)]) throws -> String {
        try need(!r.isEmpty && r.count <= 64 && Set(r.map(\.recipient)).count == r.count, "malformed", "recipients")
        let lines = try r.map { x -> String in
            try need(t(x.recipient, "^seat:[0-9a-f]{32}$") && t(x.kemKeyId, hex32), "malformed", "recipient")
            guard let s = PqBin.unhex(x.sealedHex), !s.isEmpty, x.sealedHex.utf8.count <= 32768 else { throw OrgAuthorityError("malformed", "sealedHex") }
            return "\(x.recipient):\(x.kemKeyId):\(OrgAuthority.sha256Hex(s))"
        }
        return OrgAuthority.sha256Hex(Array("\(tagProposal)|recipients|\(lines.sorted().joined(separator: ";"))".utf8))
    }

    static func recipients(_ b: [String: Any]) throws -> [(recipient: String, kemKeyId: String, sealedHex: String)] {
        try ((b["recipients"] as? [[String: Any]]) ?? []).map {
            guard let r = $0["recipient"] as? String, let k = $0["kemKeyId"] as? String, let s = $0["sealedHex"] as? String else { throw OrgAuthorityError("malformed", "recipient") }
            return (r, k, s)
        }
    }

    /// Checks a proposal bundle (wire JSON) against its connector bundle (wire JSON). `rolesHash` is the
    /// roles hash of the proposal's `roles` ("" when none). Throws `OrgAuthorityError`.
    public static func verifyProposal(connector cb: [String: Any], proposal pb: [String: Any], rolesHash: String, now: Int64) throws -> OrgProposal {
        let c = try OrgConnector.fromWire(cb["connector"]), p = try OrgProposal.fromWire(pb["proposal"])
        let msg = try canonicalProposal(p)
        try need(p.orgId == c.orgId && p.connectorId == c.connectorId, "wrong-org", "another connector")
        try need(c.status == "active", "seat-revoked", "connector \(c.status)")
        try need(c.scopes.contains(scope(of: p.kind)), "scope", p.kind)
        try need(p.issuedAt <= now + OrgAuthority.maxSkewMs, "future")
        try need(p.rolesHash == rolesHash, "order-mismatch", "roles")
        try need(try recipientsHash(try recipients(pb)) == p.sealedSha256, "order-mismatch", "sealed copies")
        guard let pub = (cb["connectorPubHex"] as? String).flatMap(PqBin.unhex), let sig = (pb["signature"] as? String).flatMap(PqBin.unhex) else {
            throw OrgAuthorityError("bad-signature")
        }
        try need(try connectorKeyId(pub) == c.connectorKeyId, "binding", "connector key id")
        do { try PqHybrid.hybridVerify(publicKey: pub, purpose: tagProposal, payload: msg, signature: sig) } catch { throw OrgAuthorityError("bad-signature") }
        return p
    }

    /// Opens this admin's copy (the proposed directory entry body) with the seat KEM secret.
    public static func openProposal(_ pb: [String: Any], recipient: String, kemSecret: [UInt8]) throws -> [UInt8] {
        let p = try OrgProposal.fromWire(pb["proposal"])
        guard let mine = try recipients(pb).first(where: { $0.recipient == recipient }), let sealed = PqBin.unhex(mine.sealedHex) else {
            throw OrgAuthorityError("seat-unknown", "not a recipient")
        }
        let ctx = [p.orgId, p.proposalId, recipient].map { Array($0.utf8) }
        return try PqHybrid.hybridOpen(recipientSecretKey: kemSecret, expectedPurpose: tagProposal, context: ctx, sealed: sealed).1
    }

    public static func canonicalDecision(orgId: String, proposalId: String, decision: String, refSha256: String, issuedAt: Int64) throws -> [UInt8] {
        try need(t(orgId, hex16) && t(proposalId, hex16) && ["done", "declined"].contains(decision) && t(refSha256, hex32) && issuedAt >= 0, "malformed", "decision")
        try need((decision == "declined") == (refSha256 == String(repeating: "0", count: 64)), "malformed", "refSha256")
        return OrgAuthority.join([tagProposal, "decision", orgId, proposalId, decision, refSha256, String(issuedAt)])
    }
}

extension OrgConnectors {
    /// SHA-256 of the mapping's canonical JSON (sorted keys), as `orgConnectorMappingSha256` makes it.
    public static func mappingSha256(_ mapping: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: mapping, options: [.sortedKeys, .withoutEscapingSlashes])
        return OrgAuthority.sha256Hex([UInt8](data))
    }

    /// The default mapping a new connector starts with: everyone in scope is proposed as a member.
    public static func defaultMapping(kind: String) -> [String: Any] {
        let attributes: [String: Any] = kind == "ldap"
            ? ["email": "userPrincipalName", "displayName": "displayName", "externalId": "objectGUID", "disabled": "userAccountControl"]
            : ["email": "userName", "displayName": "displayName", "externalId": "externalId"]
        return ["attributes": attributes, "groups": [String: Any](), "defaultRoles": [["role": "member"]]]
    }

    /// A new connector on `serverDomain`: fresh hybrid seeds, the record (unapproved), and the setup to seal.
    public static func newConnector(orgId: String, kind: String, serverDomain: String, mapping: [String: Any], issuedAt: Int64)
        throws -> (connector: OrgConnector, pubHex: String, seedsHex: String) {
        let ed = PqHybrid.randomSeed(), ml = PqHybrid.randomSeed()
        let kp = try PqHybrid.hybridSigKeygen(edSeed: ed, mldsaSeed: ml)
        let c = OrgConnector(orgId: orgId, connectorId: OrgAuthority.randomId(), kind: kind, serverDomain: serverDomain, connectorKeyId: try connectorKeyId(kp.publicKey),
                             scopes: scopes, mappingSha256: try mappingSha256(mapping), status: "active", issuedAt: issuedAt)
        _ = try canonicalConnector(c)
        return (c, PqBin.hex(kp.publicKey), PqBin.hex(ed + ml))
    }

    /// The setup sealed to the connector's box (`sealOrgConnectorSetup`).
    public static func sealSetup(_ c: OrgConnector, boxKem: OrgVerifiedKem, setup: [String: Any], issuedAt: Int64) throws -> [String: Any] {
        try need(boxKem.recipient == "box:\(c.serverDomain)", "scope", "not the connector's box")
        let plain = try JSONSerialization.data(withJSONObject: setup, options: [.sortedKeys, .withoutEscapingSlashes])
        let opts = HybridSealOptions(purpose: tagConnector, senderKeyId: [UInt8](repeating: 0, count: 32), issuedAt: UInt64(issuedAt))
        let sealed = try PqHybrid.hybridSeal(recipientPublicKey: boxKem.kemPub, options: opts, context: [c.orgId, c.connectorId, c.serverDomain].map { Array($0.utf8) }, plaintext: [UInt8](plain))
        return ["kemKeyId": boxKem.kemKeyId, "sealedHex": PqBin.hex(sealed)]
    }

    public static func connectorJSON(_ c: OrgConnector) -> [String: Any] {
        ["orgId": c.orgId, "connectorId": c.connectorId, "kind": c.kind, "serverDomain": c.serverDomain, "connectorKeyId": c.connectorKeyId,
         "scopes": c.scopes, "mappingSha256": c.mappingSha256, "status": c.status, "issuedAt": NSNumber(value: c.issuedAt)]
    }
}

/// A stored connector's standing (packages/protocol/src/orgConnector.ts `orgConnectorStanding`).
public struct OrgConnectorStanding: Equatable {
    public let state: String
    public let approvers: [String]
    public let leftAt: Int64?
    public let suspendAt: Int64?
}

extension OrgConnectors {
    public static let reapprovalGraceMs: Int64 = 7 * 24 * 3_600_000

    /// The approval checked as of the record it names, then whether any approver is still an org admin:
    /// `ok`, `needs-reapproval` for 7 days after the last one left, then `suspended`.
    public static func standing(_ st: OrgAuthorityState, _ book: OrgSeatBook, connector cb: [String: Any], now: Int64) throws -> OrgConnectorStanding {
        let c = try OrgConnector.fromWire(cb["connector"])
        let approvals = try OrgAuthorityWire.approvals(cb["approvals"])
        let at = approvals.first?.oarVersion ?? -1
        try OrgRotation.recordedApprovals(st, book, order: try canonicalConnector(c), approvals: approvals, oarVersion: at, now: now, scoped: nil)
        var signers: [String] = []
        for a in approvals where !signers.contains(a.seatId) { signers.append(a.seatId) }
        let isAdmin = { (s: String) in st.current.admins.contains { $0.seatId == s && $0.kind == .admin } }
        let departed = signers.filter { !isAdmin($0) }.map { s -> Int64 in
            st.records.first { $0.version > at && !$0.admins.contains { $0.seatId == s && $0.kind == .admin } }?.issuedAt ?? st.current.issuedAt
        }
        if departed.count < signers.count { return OrgConnectorStanding(state: "ok", approvers: signers, leftAt: nil, suspendAt: nil) }
        let left = departed.max() ?? 0
        return OrgConnectorStanding(state: now < left + reapprovalGraceMs ? "needs-reapproval" : "suspended", approvers: signers, leftAt: left, suspendAt: left + reapprovalGraceMs)
    }

    static func mappingInfo(_ orgId: String, _ connectorId: String, _ v: Int64) throws -> [UInt8] {
        try need(t(orgId, hex16) && t(connectorId, hex16) && v >= 0, "malformed", "mapping")
        return OrgAuthority.join([tagConnector, "mapping", orgId, connectorId, String(v)])
    }

    static func mappingKey(_ directoryKey: [UInt8], _ info: [UInt8]) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: directoryKey), salt: Data(), info: Data(info), outputByteCount: 32)
    }

    /// The mapping sealed under the org directory key for the admins' editor (`sealOrgConnectorMapping`).
    public static func sealMapping(orgId: String, connectorId: String, directoryKey: [UInt8], keyVersion: Int64, mapping: [String: Any], nonce: [UInt8]? = nil) throws -> [String: Any] {
        let info = try mappingInfo(orgId, connectorId, keyVersion)
        let plain = try JSONSerialization.data(withJSONObject: mapping, options: [.sortedKeys, .withoutEscapingSlashes])
        let box = try AES.GCM.seal(plain, using: mappingKey(directoryKey, info), nonce: try AES.GCM.Nonce(data: nonce ?? PqBin.random(12)), authenticating: info)
        return ["keyVersion": NSNumber(value: keyVersion), "sealedHex": PqBin.hex(Array(box.combined!))]
    }

    public static func openMapping(orgId: String, connectorId: String, directoryKey: [UInt8], sealed: [String: Any]) throws -> [String: Any] {
        guard let v = OrgAuthority.i64(sealed["keyVersion"]), let b = (sealed["sealedHex"] as? String).flatMap(PqBin.unhex) else { throw OrgAuthorityError("malformed", "mapping") }
        let info = try mappingInfo(orgId, connectorId, v)
        do {
            let plain = try AES.GCM.open(try AES.GCM.SealedBox(combined: Data(b)), using: mappingKey(directoryKey, info), authenticating: info)
            guard let o = try JSONSerialization.jsonObject(with: plain) as? [String: Any] else { throw OrgAuthorityError("malformed", "mapping") }
            return o
        } catch { throw OrgAuthorityError("malformed", "mapping does not open") }
    }
}
