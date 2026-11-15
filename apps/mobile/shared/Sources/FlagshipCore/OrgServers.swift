import Foundation
import CryptoKit

/// Org servers, the org key ring and the audit export (packages/protocol/src/orgServers.ts,
/// orgKeyRing.ts, orgAudit.ts; docs/enterprise-accounts.md "Org servers", §5.4, §8, §11). Byte for byte
/// the TypeScript canonical forms, pinned by test-vectors/org-servers.
public struct OrgServerCode: Equatable {
    public var orgId: String, genesisHash: String, serial: String, serverName: String, serverDomain: String, delegatedPubKeyHex: String
    public var issuedAt: Int64, expiresAt: Int64
    public init(orgId: String, genesisHash: String, serial: String, serverName: String, serverDomain: String, delegatedPubKeyHex: String, issuedAt: Int64, expiresAt: Int64) {
        self.orgId = orgId; self.genesisHash = genesisHash; self.serial = serial; self.serverName = serverName
        self.serverDomain = serverDomain; self.delegatedPubKeyHex = delegatedPubKeyHex; self.issuedAt = issuedAt; self.expiresAt = expiresAt
    }
    public var json: [String: Any] {
        ["orgId": orgId, "genesisHash": genesisHash, "serial": serial, "serverName": serverName, "serverDomain": serverDomain,
         "delegatedPubKeyHex": delegatedPubKeyHex, "issuedAt": NSNumber(value: issuedAt), "expiresAt": NSNumber(value: expiresAt)]
    }
    public static func fromWire(_ w: Any?) throws -> OrgServerCode {
        guard let o = w as? [String: Any], let orgId = o["orgId"] as? String, let g = o["genesisHash"] as? String, let serial = o["serial"] as? String,
              let name = o["serverName"] as? String, let domain = o["serverDomain"] as? String, let d = o["delegatedPubKeyHex"] as? String,
              let ia = OrgAuthority.i64(o["issuedAt"]), let ea = OrgAuthority.i64(o["expiresAt"]) else { throw OrgAuthorityError("malformed", "server code") }
        return OrgServerCode(orgId: orgId, genesisHash: g, serial: serial, serverName: name, serverDomain: domain, delegatedPubKeyHex: d, issuedAt: ia, expiresAt: ea)
    }
}

public enum OrgKeyKind: String, CaseIterable { case cgk, directoryKey = "directory-key", archiveKeys = "archive-keys", diskKey = "disk-key" }

public struct OrgKeyRing: Equatable {
    public var orgId: String, kind: OrgKeyKind, scope: String, version: Int64, prevSha256: String, keyCommitment: String, recipientsHash: String
    public var retired: [String], oarVersion: Int64, issuedAt: Int64
    public var json: [String: Any] {
        ["orgId": orgId, "kind": kind.rawValue, "scope": scope, "version": NSNumber(value: version), "prevSha256": prevSha256, "keyCommitment": keyCommitment,
         "recipientsHash": recipientsHash, "retired": retired, "oarVersion": NSNumber(value: oarVersion), "issuedAt": NSNumber(value: issuedAt)]
    }
    public static func fromWire(_ w: Any?) throws -> OrgKeyRing {
        guard let o = w as? [String: Any], let orgId = o["orgId"] as? String, let k = (o["kind"] as? String).flatMap(OrgKeyKind.init(rawValue:)),
              let scope = o["scope"] as? String, let v = OrgAuthority.i64(o["version"]), let p = o["prevSha256"] as? String,
              let c = o["keyCommitment"] as? String, let r = o["recipientsHash"] as? String, let retired = o["retired"] as? [String],
              let ov = OrgAuthority.i64(o["oarVersion"]), let ia = OrgAuthority.i64(o["issuedAt"]) else { throw OrgAuthorityError("malformed", "key ring") }
        return OrgKeyRing(orgId: orgId, kind: k, scope: scope, version: v, prevSha256: p, keyCommitment: c, recipientsHash: r, retired: retired, oarVersion: ov, issuedAt: ia)
    }
}

public struct OrgKeyRecipient: Equatable {
    public var recipient: String, kemKeyId: String, sealedHex: String
    public var json: [String: Any] { ["recipient": recipient, "kemKeyId": kemKeyId, "sealedHex": sealedHex] }
}

/// A recipient's verified X-Wing key (`seat:<id>` or `box:<domain>`).
public struct OrgKemKey { public let recipient: String; public let kemPub: [UInt8]; public let kemKeyId: String }

extension OrgAuthority {
    public static let tagServerCode = "flagship/org-server-code/v1"
    public static let tagServerRegister = "flagship/org-server-register/v1"
    public static let tagInstallBlob = "flagship/org-install-blob/v1"
    public static let tagSeatKem = "flagship/org-seat-kem/v1"
    public static let tagBoxKem = "flagship/org-box-kem/v1"
    public static let tagKeyRing = "flagship/org-key-ring/v1"
    public static let tagKeyRecipients = "flagship/org-key-recipients/v1"
    public static let tagKeyCommit = "flagship/org-key-commit/v1"
    public static let tagKeySeal = "flagship/org-key-seal/v1"
    public static let tagSeatKemSeed = "flagship/org-seat-kem-seed/v1"
    public static let tagLog = "flagship/org-log/v1"
    public static let tagAuditExport = "flagship/org-audit-export/v1"
    public static let serverCodeMaxMs: Int64 = 24 * 3_600_000

    static let labelPattern = "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
    static let domainPattern = "^[a-z0-9][a-z0-9.-]{0,252}$"

    // MARK: server codes and registration

    public static func canonicalServerCode(_ c: OrgServerCode) throws -> [UInt8] {
        try need(isHex(c.orgId, 32) && isHex(c.genesisHash, 64) && isHex(c.delegatedPubKeyHex, 64), "malformed", "server code")
        try need(token(c.serial, "^[A-Za-z0-9_-]{8,64}$") && token(c.serverName, labelPattern) && token(c.serverDomain, domainPattern), "malformed", "server code")
        try need(c.serverDomain.hasPrefix("\(c.serverName)."), "malformed", "serverDomain")
        try need(c.issuedAt >= 0 && c.expiresAt > c.issuedAt && c.expiresAt - c.issuedAt <= serverCodeMaxMs, "malformed", "expiresAt")
        return join([tagServerCode, c.orgId, c.genesisHash, c.serial, c.serverName, c.serverDomain, c.delegatedPubKeyHex, String(c.issuedAt), String(c.expiresAt)])
    }

    public static func serverCodeSha256(_ c: OrgServerCode) throws -> String { sha256Hex(try canonicalServerCode(c)) }

    /// The org's AuthCode: names this org and genesis, still valid, approved for `add-server`.
    public static func verifyServerCode(state: OrgAuthorityState, book: OrgSeatBook, code: OrgServerCode, approvals: [OrgApproval], now: Int64) throws -> (signers: [String], scopedSeat: String?) {
        let order = try canonicalServerCode(code)
        try need(code.orgId == state.orgId && code.genesisHash == (try authorityHash(state.records[0])), "wrong-org")
        try need(code.expiresAt > now, "expired")
        return try authorize(state: state, book: book, action: .addServer, order: order, approvals: approvals, now: now)
    }

    public static func canonicalServerRegister(orgId: String, serial: String, serverDomain: String, codeSha256: String, serverIdentityPubKeyHex: String,
                                               issuedAt: Int64, nonceHex: String) throws -> [UInt8] {
        try need(isHex(orgId, 32) && isHex(codeSha256, 64) && isHex(serverIdentityPubKeyHex, 64) && token(serial, "^[A-Za-z0-9_-]{8,64}$"), "malformed", "register")
        try need(token(serverDomain, domainPattern) && token(nonceHex, "^[0-9a-f]{16,128}$") && issuedAt >= 0, "malformed", "register")
        return join([tagServerRegister, orgId, serial, serverDomain, codeSha256, serverIdentityPubKeyHex, String(issuedAt), nonceHex])
    }

    // MARK: the org recipe

    /// `flagship/org-install-blob/v1|…`: what an org admin approves for the box's recipe (beside the code's approval).
    public static func canonicalInstallBlob(orgId: String, genesisHash: String, orgName: String, serverName: String, serverDomain: String,
                                            registrationUrl: String, installerGitRef: String, phoneDelegatedPubKey: String, code: OrgServerCode,
                                            bootUnlockMode: String, diskEncryption: String) throws -> [UInt8] {
        try need(isHex(orgId, 32) && isHex(genesisHash, 64) && isHex(phoneDelegatedPubKey, 64) && isHex(installerGitRef, 40), "malformed", "install blob")
        try need(token(orgName, labelPattern) && token(serverName, labelPattern) && token(serverDomain, domainPattern), "malformed", "install blob")
        try need(token(registrationUrl, "^https://[a-z0-9.-]+(?::[0-9]{1,5})?/api/orgs/[0-9a-f]{32}/servers/register$") && registrationUrl.contains("/api/orgs/\(orgId)/"),
                 "malformed", "registrationUrl")
        try need(["auto", "approve"].contains(bootUnlockMode) && ["luks", "none"].contains(diskEncryption), "malformed", "install blob")
        try need(code.orgId == orgId && code.genesisHash == genesisHash && code.serverName == serverName && code.serverDomain == serverDomain, "malformed", "code names another server")
        let apex = serverDomain.split(separator: ".").dropFirst(2).joined(separator: ".")
        try need(serverDomain == "\(serverName).\(orgName).\(apex)", "malformed", "serverDomain")
        return join([tagInstallBlob, orgId, genesisHash, orgName, serverName, serverDomain, registrationUrl, installerGitRef, phoneDelegatedPubKey,
                     try serverCodeSha256(code), bootUnlockMode, diskEncryption])
    }

    // MARK: KEM keys

    public static func kemKeyIdHex(_ kemPub: [UInt8]) -> String { hex(PqHybrid.pqKeyId(suite: PqHybrid.suiteHybridSealV1, publicKey: kemPub)) }

    /// The seat's X-Wing seed, from the person's UMK for this org (every device of theirs opens its copies).
    public static func seatKemSeed(umk: [UInt8], orgId: String) throws -> [UInt8] {
        try need(umk.count == 32 && isHex(orgId, 32), "malformed", "kem seed")
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: umk), salt: [UInt8](), info: Array("\(tagSeatKemSeed)|\(orgId)".utf8),
                                      outputByteCount: 32).withUnsafeBytes { Array($0) }
    }

    public static func canonicalSeatKem(orgId: String, seatId: String, kemKeyId: String, issuedAt: Int64) throws -> [UInt8] {
        try need(isHex(orgId, 32) && isHex(seatId, 32) && isHex(kemKeyId, 64) && issuedAt >= 0, "malformed", "seat kem")
        return join([tagSeatKem, orgId, seatId, kemKeyId, String(issuedAt)])
    }

    public static func canonicalBoxKem(orgId: String, serverDomain: String, kemKeyId: String, issuedAt: Int64) throws -> [UInt8] {
        try need(isHex(orgId, 32) && token(serverDomain, domainPattern) && isHex(kemKeyId, 64) && issuedAt >= 0, "malformed", "box kem")
        return join([tagBoxKem, orgId, serverDomain, kemKeyId, String(issuedAt)])
    }

    // MARK: the key ring

    static func orgWide(_ k: OrgKeyKind) -> Bool { k == .cgk || k == .directoryKey }

    public static func canonicalKeyRing(_ r: OrgKeyRing) throws -> [UInt8] {
        try need(isHex(r.orgId, 32), "malformed", "orgId")
        try need(orgWide(r.kind) ? r.scope == "*" : token(r.scope, domainPattern), "malformed", "scope")
        try need(r.version >= 1 && isHex(r.prevSha256, 64) && isHex(r.keyCommitment, 64) && isHex(r.recipientsHash, 64), "malformed", "ring")
        try need(r.retired.allSatisfy { isHex($0, 32) } && r.retired == r.retired.sorted() && Set(r.retired).count == r.retired.count, "malformed", "retired")
        try need(r.oarVersion >= 0 && r.issuedAt >= 0, "malformed", "ring")
        return join([tagKeyRing, r.orgId, r.kind.rawValue, r.scope, String(r.version), r.prevSha256, r.keyCommitment, r.recipientsHash,
                     r.retired.joined(separator: ","), String(r.oarVersion), String(r.issuedAt)])
    }

    public static func keyRingSha256(_ r: OrgKeyRing) throws -> String { sha256Hex(try canonicalKeyRing(r)) }

    public static func keyCommitment(orgId: String, kind: OrgKeyKind, scope: String, version: Int64, key: [UInt8]) throws -> String {
        try need(key.count == 32, "malformed", "key")
        return sha256Hex(join([tagKeyCommit, orgId, kind.rawValue, scope, String(version), hex(key)]))
    }

    public static func recipientsHash(_ recipients: [OrgKeyRecipient]) throws -> String {
        try need(!recipients.isEmpty && recipients.count <= 256 && Set(recipients.map(\.recipient)).count == recipients.count, "malformed", "recipients")
        let lines = try recipients.map { x -> String in
            try need(token(x.recipient, "^(?:seat:[0-9a-f]{32}|box:[a-z0-9][a-z0-9.-]{0,252})$") && isHex(x.kemKeyId, 64), "malformed", "recipient")
            guard let sealed = PqBin.unhex(x.sealedHex), !sealed.isEmpty, x.sealedHex.count <= 8192 else { throw OrgAuthorityError("malformed", "sealedHex") }
            return "\(x.recipient):\(x.kemKeyId):\(sha256Hex(sealed))"
        }
        return sha256Hex(Array("\(tagKeyRecipients)|\(lines.sorted().joined(separator: ";"))".utf8))
    }

    static func sealContext(_ orgId: String, _ kind: OrgKeyKind, _ scope: String, _ version: Int64, _ recipient: String) -> [[UInt8]] {
        [orgId, kind.rawValue, scope, String(version), recipient].map { Array($0.utf8) }
    }

    /// Opens this recipient's copy and checks it against the ring's key commitment.
    public static func openKeyRing(_ r: OrgKeyRing, recipients: [OrgKeyRecipient], recipient: String, kemSecret: [UInt8]) throws -> [UInt8] {
        guard let mine = recipients.first(where: { $0.recipient == recipient }), let sealed = PqBin.unhex(mine.sealedHex) else {
            throw OrgAuthorityError("seat-unknown", "not a recipient")
        }
        let (_, plaintext) = try PqHybrid.hybridOpen(recipientSecretKey: kemSecret, expectedPurpose: tagKeySeal,
                                                     context: sealContext(r.orgId, r.kind, r.scope, r.version, recipient), sealed: sealed)
        try need(try keyCommitment(orgId: r.orgId, kind: r.kind, scope: r.scope, version: r.version, key: plaintext) == r.keyCommitment, "order-mismatch", "key commitment")
        return plaintext
    }

    /// A new version sealed to `recipients` (the phone's side of a rotation); the caller approves `canonicalKeyRing(ring)` and posts it.
    public static func buildKeyRing(orgId: String, kind: OrgKeyKind, scope: String, prev: OrgKeyRing?, key: [UInt8], recipients: [OrgKemKey],
                                    retired: [String], oarVersion: Int64, issuedAt: Int64) throws -> (ring: OrgKeyRing, recipients: [OrgKeyRecipient]) {
        let version = (prev?.version ?? 0) + 1
        let out = try recipients.map { k -> OrgKeyRecipient in
            let opts = HybridSealOptions(purpose: tagKeySeal, senderKeyId: [UInt8](repeating: 0, count: 32), issuedAt: UInt64(issuedAt))
            let sealed = try PqHybrid.hybridSeal(recipientPublicKey: k.kemPub, options: opts, context: sealContext(orgId, kind, scope, version, k.recipient), plaintext: key)
            return OrgKeyRecipient(recipient: k.recipient, kemKeyId: k.kemKeyId, sealedHex: hex(sealed))
        }
        let ring = OrgKeyRing(orgId: orgId, kind: kind, scope: scope, version: version, prevSha256: try prev.map { try keyRingSha256($0) } ?? String(repeating: "0", count: 64),
                              keyCommitment: try keyCommitment(orgId: orgId, kind: kind, scope: scope, version: version, key: key),
                              recipientsHash: try recipientsHash(out), retired: retired.sorted(), oarVersion: oarVersion, issuedAt: issuedAt)
        _ = try canonicalKeyRing(ring)
        return (ring, out)
    }

    // MARK: audit export

    public static func logEntryHash(orgId: String, seq: Int64, prevHash: String, kind: String, refSha256: String, at: Int64) -> String {
        sha256Hex(join([tagLog, orgId, String(seq), prevHash, kind, refSha256, String(at)]))
    }

    public static func canonicalAuditExport(orgId: String, oarVersion: Int64, oarHash: String, logSeq: Int64, logHeadHash: String, issuedAt: Int64) throws -> [UInt8] {
        try need(isHex(orgId, 32) && isHex(oarHash, 64) && isHex(logHeadHash, 64) && oarVersion >= 0 && logSeq >= 0 && issuedAt >= 0, "malformed", "audit export")
        return join([tagAuditExport, orgId, String(oarVersion), oarHash, String(logSeq), logHeadHash, String(issuedAt)])
    }
}
