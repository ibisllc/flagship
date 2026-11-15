import Foundation
import CryptoKit

/// Enterprise org authority (docs/enterprise-accounts.md): canonical forms, approvals, the seat SAS
/// and the seat member key. Swift twin of `packages/protocol/src/orgAuthority.ts`; every port reads
/// `packages/protocol/test-vectors/org-authority/vectors.json`. The chain, seat book and predicate
/// are in OrgAuthorityChain.swift.
public enum OrgAuthority {
    public static let tagAuthority = "flagship/org-authority/v1"
    public static let tagAdmins = "flagship/org-admins/v1"
    public static let tagBylaws = "flagship/org-bylaws/v1"
    public static let tagApproval = "flagship/org-approval/v1"
    public static let tagDelayedChange = "flagship/org-delayed-change/v1"
    public static let tagVeto = "flagship/org-veto/v1"
    public static let tagSeatInvite = "flagship/org-seat-invite/v1"
    public static let tagSeatAccept = "flagship/org-seat-accept/v1"
    public static let tagSeatGrant = "flagship/org-seat-grant/v1"
    public static let tagSeatRoles = "flagship/org-seat-roles/v1"
    public static let tagSeatRevoke = "flagship/org-seat-revoke/v1"
    public static let tagSeatFreeze = "flagship/org-seat-freeze/v1"
    public static let tagOverturn = "flagship/org-overturn/v1"
    public static let tagSeatSas = "flagship/org-seat-sas/v1"
    public static let tagSeatMemberKdf = "flagship/org-seat-member/v1"
    public static let tagSeatMemberPqKdf = "flagship/org-seat-member-pq/v1"

    public static let hour: Int64 = 3_600_000
    public static let day: Int64 = 24 * hour
    public static let freezeMaxMs: Int64 = 72 * hour
    public static let freezeCooldownMs: Int64 = 7 * day
    public static let founderNoticeMs: Int64 = 7 * day
    public static let recoveryNoticeMs: Int64 = 14 * day
    public static let previousOarGraceMs: Int64 = 24 * hour
    public static let approvalMaxLifetimeMs: Int64 = 7 * day
    public static let grantMaxLifetimeMs: Int64 = 400 * day
    public static let inviteMaxLifetimeMs: Int64 = 14 * day
    public static let maxSkewMs: Int64 = 5 * 60 * 1000
    public static let kMax = 7
    public static let maxAdmins = 32
    public static let genesisPrev = String(repeating: "0", count: 64)

    public static func sha256Hex(_ b: [UInt8]) -> String { PqBin.hex(Array(SHA256.hash(data: b))) }
    public static func hex(_ b: [UInt8]) -> String { PqBin.hex(b) }
    public static func seatSubject(orgId: String, seatId: String) -> String { "\(orgId):\(seatId)" }

    static func isHex(_ s: String, _ n: Int) -> Bool { s.utf8.count == n && PqBin.isLowerHex(s) }
    static func need(_ ok: Bool, _ code: String, _ detail: String = "") throws { if !ok { throw OrgAuthorityError(code, detail) } }
    static func join(_ parts: [String]) -> [UInt8] { Array(parts.joined(separator: "|").utf8) }
    static func token(_ s: String, _ pattern: String) -> Bool { s.range(of: pattern, options: .regularExpression) != nil }
}

/// A refusal; `code` matches the TypeScript port and the vectors' `expect.code`.
public struct OrgAuthorityError: Error, Equatable, CustomStringConvertible {
    public let code: String
    public let detail: String
    public init(_ code: String, _ detail: String = "") { self.code = code; self.detail = detail }
    public var description: String { detail.isEmpty ? code : "\(code): \(detail)" }
    public static func == (a: Self, b: Self) -> Bool { a.code == b.code }
}

public enum OrgAdminKind: String, Sendable { case admin, board, recovery }

/// Where a seat's admin key lives (docs/webapp-key-custody.md items 1 and 3): `hardware` (a phone, the
/// default) or `browser` ("Browser: software key, unlocked with a passkey"). Encoded only when `browser`.
public enum OrgCustody: String, Sendable { case hardware, browser }

public struct OrgAdminEntry: Sendable {
    public var seatId: String
    public var kind: OrgAdminKind
    public var binding: PqKeyBindingWire
    public var custody: OrgCustody
    public init(seatId: String, kind: OrgAdminKind, binding: PqKeyBindingWire, custody: OrgCustody = .hardware) {
        self.seatId = seatId; self.kind = kind; self.binding = binding; self.custody = custody
    }
}

public struct OrgBylaws: Equatable, Sendable {
    /// nil = every `admin` of the record.
    public var overturnSeats: [String]?
    /// 0 = a majority of the set.
    public var overturnK: Int
    public var vetoK: Int
    /// true: admin keys must be hardware custody.
    public var hardwareAdmins: Bool
    /// true (default): a quorum of two or more needs a hardware-custody approval.
    public var quorumHardware: Bool
    public init(overturnSeats: [String]?, overturnK: Int, vetoK: Int, hardwareAdmins: Bool = false, quorumHardware: Bool = true) {
        self.overturnSeats = overturnSeats; self.overturnK = overturnK; self.vetoK = vetoK
        self.hardwareAdmins = hardwareAdmins; self.quorumHardware = quorumHardware
    }
}

public struct OrgAuthorityRecord: Sendable {
    public var orgId: String
    public var version: Int64
    public var prevHash: String
    public var admins: [OrgAdminEntry]
    public var bylaws: OrgBylaws
    public var founderSeatId: String
    public var kGov: Int
    public var kGrant: Int
    public var kDestroy: Int
    public var kSite: Int
    public var issuedAt: Int64

    public init(orgId: String, version: Int64, prevHash: String, admins: [OrgAdminEntry], bylaws: OrgBylaws, founderSeatId: String,
                kGov: Int, kGrant: Int, kDestroy: Int, kSite: Int, issuedAt: Int64) {
        self.orgId = orgId; self.version = version; self.prevHash = prevHash; self.admins = admins; self.bylaws = bylaws
        self.founderSeatId = founderSeatId; self.kGov = kGov; self.kGrant = kGrant; self.kDestroy = kDestroy; self.kSite = kSite
        self.issuedAt = issuedAt
    }

    var authorityAdmins: [OrgAdminEntry] { admins.filter { $0.kind == .admin } }
}

public struct OrgApproval: Sendable, Equatable {
    public var orgId: String
    public var oarVersion: Int64
    public var purposeTag: String
    public var orderSha256: String
    public var seatId: String
    public var adminKeyId: String
    public var notAfter: Int64
    public var issuedAt: Int64
    public var signature: String

    public var jsonObject: [String: Any] {
        ["orgId": orgId, "oarVersion": NSNumber(value: oarVersion), "purposeTag": purposeTag, "orderSha256": orderSha256,
         "seatId": seatId, "adminKeyId": adminKeyId, "notAfter": NSNumber(value: notAfter), "issuedAt": NSNumber(value: issuedAt),
         "signature": signature]
    }
}

extension OrgAuthority {
    public static func canonicalAdmins(_ admins: [OrgAdminEntry]) throws -> [UInt8] {
        var lines: [String] = []
        for a in admins {
            try need(isHex(a.seatId, 32), "malformed", "seatId")
            try need(isHex(a.binding.ed25519PubHex, 64) && isHex(a.binding.mldsaPubHex, 3904), "malformed", "binding")
            lines.append("\(a.seatId):\(a.kind.rawValue):\(a.binding.ed25519PubHex):\(a.binding.mldsaPubHex)\(a.custody == .browser ? ":browser" : "")")
        }
        return Array("\(tagAdmins)|\(lines.sorted().joined(separator: ","))".utf8)
    }

    public static func canonicalBylaws(_ b: OrgBylaws) throws -> [UInt8] {
        try need(b.overturnK >= 0 && b.vetoK >= 0, "malformed", "bylaws k")
        let seats: String
        if let s = b.overturnSeats {
            try need(!s.isEmpty, "bylaws", "overturnSeats")
            for x in s { try need(isHex(x, 32), "malformed", "overturnSeats") }
            seats = s.sorted().joined(separator: ",")
        } else { seats = "*" }
        let extra = (b.hardwareAdmins ? "|hardware-admins" : "") + (b.quorumHardware ? "" : "|browser-quorums")
        return Array("\(tagBylaws)|\(b.overturnK)|\(seats)|\(b.vetoK)\(extra)".utf8)
    }

    public static func canonicalAuthority(_ r: OrgAuthorityRecord) throws -> [UInt8] {
        try need(isHex(r.orgId, 32) && isHex(r.prevHash, 64) && isHex(r.founderSeatId, 32), "malformed", "record ids")
        try need(r.version >= 0 && r.issuedAt >= 0 && [r.kGov, r.kGrant, r.kDestroy, r.kSite].allSatisfy { $0 >= 0 }, "malformed", "numbers")
        return join([tagAuthority, r.orgId, String(r.version), r.prevHash, sha256Hex(try canonicalAdmins(r.admins)),
                     sha256Hex(try canonicalBylaws(r.bylaws)), r.founderSeatId, String(r.kGov), String(r.kGrant), String(r.kDestroy),
                     String(r.kSite), String(r.issuedAt)])
    }

    public static func authorityHash(_ r: OrgAuthorityRecord) throws -> String { sha256Hex(try canonicalAuthority(r)) }

    public static func overturnSet(_ r: OrgAuthorityRecord) -> [String] { r.bylaws.overturnSeats ?? r.authorityAdmins.map(\.seatId) }

    public static func overturnThreshold(_ r: OrgAuthorityRecord) -> Int {
        r.bylaws.overturnK == 0 ? overturnSet(r).count / 2 + 1 : r.bylaws.overturnK
    }

    /// The strictest ceremony: changing the bylaws or moving the founder role.
    public static func bylawsThreshold(_ r: OrgAuthorityRecord) -> Int {
        let n = r.authorityAdmins.count
        return min(n, max(r.kGov, r.kDestroy, r.kSite, overturnThreshold(r), Int((Double(2 * n) / 3).rounded(.up))))
    }

    public static func checkShape(_ r: OrgAuthorityRecord) throws {
        _ = try canonicalAuthority(r)
        try need(!r.admins.isEmpty && r.admins.count <= maxAdmins, "malformed", "admins")
        try need(Set(r.admins.map(\.seatId)).count == r.admins.count, "malformed", "duplicate seat")
        try need(Set(r.admins.map(\.binding.ed25519PubHex)).count == r.admins.count, "malformed", "duplicate key")
        let n = r.authorityAdmins.count
        try need(n > 0, "thresholds", "no admin")
        try need(r.admins.first { $0.seatId == r.founderSeatId }?.kind == .admin, "founder")
        for k in [r.kGov, r.kGrant, r.kDestroy, r.kSite] { try need(k >= 1 && k <= n && k <= kMax, "thresholds") }
        try need(r.kGov >= min(2, n) && r.kDestroy >= min(2, n), "thresholds", "floor")
        if let s = r.bylaws.overturnSeats {
            try need(Set(s).count == s.count, "bylaws", "duplicate seat")
            for x in s { try need(r.admins.contains { $0.seatId == x && $0.kind != .recovery }, "bylaws", "overturn seat") }
        }
        let size = overturnSet(r).count
        try need(size > 0 && overturnThreshold(r) <= size && overturnThreshold(r) <= kMax, "bylaws", "overturnK")
        try need(r.bylaws.vetoK >= 1 && r.bylaws.vetoK <= kMax, "bylaws", "vetoK")
        if r.bylaws.hardwareAdmins {
            for a in r.admins { try need(a.custody == .hardware, "custody", "\(a.seatId): the bylaws need hardware custody for admins") }
        }
    }

    /// The bylaws' quorum rule: a quorum of two or more needs a hardware-custody approval, unless turned off.
    public static func checkQuorumCustody(_ r: OrgAuthorityRecord, k: Int, signers: [String], custodyOf: (String) -> OrgCustody) throws {
        if !r.bylaws.quorumHardware || k < 2 || signers.isEmpty { return }
        try need(signers.contains { custodyOf($0) == .hardware }, "custody", "a quorum of two or more needs a hardware approval")
    }

    static func adminCustody(_ r: OrgAuthorityRecord) -> (String) -> OrgCustody {
        { s in r.admins.first { $0.seatId == s }?.custody ?? .hardware }
    }

    // MARK: approvals

    public static func canonicalApproval(orgId: String, oarVersion: Int64, purposeTag: String, orderSha256: String, seatId: String,
                                         adminKeyId: String, notAfter: Int64, issuedAt: Int64) throws -> [UInt8] {
        try need(isHex(orgId, 32) && isHex(orderSha256, 64) && isHex(seatId, 32) && isHex(adminKeyId, 64), "malformed", "approval ids")
        try need(token(purposeTag, "^flagship/[a-z0-9/-]+/v[1-9][0-9]*$"), "malformed", "purposeTag")
        try need(oarVersion >= 0 && notAfter >= 0 && issuedAt >= 0, "malformed", "numbers")
        return join([tagApproval, orgId, String(oarVersion), purposeTag, orderSha256, seatId, adminKeyId, String(notAfter), String(issuedAt)])
    }

    public static func canonicalApproval(_ a: OrgApproval) throws -> [UInt8] {
        try canonicalApproval(orgId: a.orgId, oarVersion: a.oarVersion, purposeTag: a.purposeTag, orderSha256: a.orderSha256,
                              seatId: a.seatId, adminKeyId: a.adminKeyId, notAfter: a.notAfter, issuedAt: a.issuedAt)
    }

    public static func keyIdHex(ed25519PubHex: String, mldsaPubHex: String) -> String {
        PqBin.hex(PqHybrid.pqKeyId(suite: PqHybrid.suiteHybridSigEd25519MlDsa65V1,
                                   publicKey: PqTrust.pqBindingPublicKey(ed25519PubHex: ed25519PubHex, mldsaPubHex: mldsaPubHex)))
    }

    /// One admin's approval of `order`; `sign` is the seat admin key's hybrid signer (purpose, payload).
    public static func signApproval(orgId: String, oarVersion: Int64, order: [UInt8], seatId: String, adminKeyId: String,
                                    issuedAt: Int64, notAfter: Int64,
                                    sign: (_ purpose: String, _ payload: [UInt8]) throws -> [UInt8]) throws -> OrgApproval {
        let purpose = PqTrust.messagePurpose(order)
        let digest = sha256Hex(order)
        let msg = try canonicalApproval(orgId: orgId, oarVersion: oarVersion, purposeTag: purpose, orderSha256: digest, seatId: seatId,
                                        adminKeyId: adminKeyId, notAfter: notAfter, issuedAt: issuedAt)
        return OrgApproval(orgId: orgId, oarVersion: oarVersion, purposeTag: purpose, orderSha256: digest, seatId: seatId,
                           adminKeyId: adminKeyId, notAfter: notAfter, issuedAt: issuedAt, signature: PqBin.hex(try sign(tagApproval, msg)))
    }

    static func i64(_ v: Any?) -> Int64? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d.isFinite, d == d.rounded(), d >= 0, d <= Double(PqTrust.maxSafeInteger) else { return nil }
        return Int64(d)
    }

    public static func approvalFromWire(_ w: Any?) throws -> OrgApproval {
        guard let o = w as? [String: Any],
              o.keys.sorted().joined(separator: ",") == "adminKeyId,issuedAt,notAfter,oarVersion,orderSha256,orgId,purposeTag,seatId,signature",
              let orgId = o["orgId"] as? String, let v = i64(o["oarVersion"]), let p = o["purposeTag"] as? String,
              let d = o["orderSha256"] as? String, let seat = o["seatId"] as? String, let key = o["adminKeyId"] as? String,
              let na = i64(o["notAfter"]), let ia = i64(o["issuedAt"]), let sig = o["signature"] as? String, isHex(sig, 6746)
        else { throw OrgAuthorityError("malformed", "approval") }
        let a = OrgApproval(orgId: orgId, oarVersion: v, purposeTag: p, orderSha256: d, seatId: seat, adminKeyId: key, notAfter: na,
                            issuedAt: ia, signature: sig)
        _ = try canonicalApproval(a)
        return a
    }

    // MARK: other records

    public static func canonicalDelayedChange(orgId: String, oarVersion: Int64, kind: String, nextRecordSha256: String,
                                              effectiveAt: Int64, issuedAt: Int64) throws -> [UInt8] {
        try need(isHex(orgId, 32) && isHex(nextRecordSha256, 64) && (kind == "founder-removal" || kind == "recovery"), "malformed", "notice")
        return join([tagDelayedChange, orgId, String(oarVersion), kind, nextRecordSha256, String(effectiveAt), String(issuedAt)])
    }

    public static func canonicalVeto(orgId: String, noticeSha256: String, issuedAt: Int64) throws -> [UInt8] {
        try need(isHex(orgId, 32) && isHex(noticeSha256, 64), "malformed", "veto")
        return join([tagVeto, orgId, noticeSha256, String(issuedAt)])
    }

    public static func canonicalFreeze(orgId: String, seatId: String, untilMs: Int64, oarVersion: Int64, issuedAt: Int64) throws -> [UInt8] {
        try need(isHex(orgId, 32) && isHex(seatId, 32), "malformed", "freeze")
        return join([tagSeatFreeze, orgId, seatId, String(untilMs), String(oarVersion), String(issuedAt)])
    }

    public static func canonicalOverturn(orgId: String, freezeSha256: String, oarVersion: Int64, issuedAt: Int64) throws -> [UInt8] {
        try need(isHex(orgId, 32) && isHex(freezeSha256, 64), "malformed", "overturn")
        return join([tagOverturn, orgId, freezeSha256, String(oarVersion), String(issuedAt)])
    }

    public static func canonicalSeatInvite(orgId: String, seatId: String, labelSha256: String, rolesHash: String, oarVersion: Int64,
                                           issuedAt: Int64, expiresAt: Int64) throws -> [UInt8] {
        try need(isHex(labelSha256, 64), "label-missing")
        try need(isHex(orgId, 32) && isHex(seatId, 32) && isHex(rolesHash, 64), "malformed", "invite")
        try need(expiresAt > issuedAt && expiresAt - issuedAt <= inviteMaxLifetimeMs, "malformed", "expiresAt")
        return join([tagSeatInvite, orgId, seatId, labelSha256, rolesHash, String(oarVersion), String(issuedAt), String(expiresAt)])
    }

    public static func canonicalSeatAccept(orgId: String, seatId: String, inviteSha256: String, memberKeyId: String, adminKeyId: String,
                                           issuedAt: Int64, custody: OrgCustody = .hardware) throws -> [UInt8] {
        try need(isHex(orgId, 32) && isHex(seatId, 32) && isHex(inviteSha256, 64) && isHex(memberKeyId, 64)
                 && (adminKeyId.isEmpty || isHex(adminKeyId, 64)), "malformed", "accept")
        try need(custody == .hardware || !adminKeyId.isEmpty, "malformed", "custody without an admin key")
        return join([tagSeatAccept, orgId, seatId, inviteSha256, memberKeyId, adminKeyId, String(issuedAt)]) + (custody == .browser ? Array("|browser".utf8) : [])
    }

    public static func canonicalSeatRevoke(orgId: String, seatId: String, reason: String, oarVersion: Int64, issuedAt: Int64) throws -> [UInt8] {
        try need(isHex(orgId, 32) && isHex(seatId, 32) && token(reason, "^[a-z0-9][a-z0-9-]{0,47}$"), "malformed", "revoke")
        return join([tagSeatRevoke, orgId, seatId, reason, String(oarVersion), String(issuedAt)])
    }

    /// The 6-digit code both phones show before an admin approves a seat.
    public static func seatSas(inviteSha256: String, memberKeyId: String, adminKeyId: String) throws -> String {
        try need(isHex(inviteSha256, 64) && isHex(memberKeyId, 64) && (adminKeyId.isEmpty || isHex(adminKeyId, 64)), "malformed", "sas")
        let d = Array(SHA256.hash(data: join([tagSeatSas, inviteSha256, memberKeyId, adminKeyId])))
        let n = (UInt32(d[0]) << 24) | (UInt32(d[1]) << 16) | (UInt32(d[2]) << 8) | UInt32(d[3])
        let s = String(n % 1_000_000)
        return String(repeating: "0", count: 6 - s.count) + s
    }

    /// The seat member key's seeds, from the person's UMK, for this org only.
    public static func memberSeeds(umk: [UInt8], orgId: String) throws -> (edSeed: [UInt8], mldsaSeed: [UInt8]) {
        try need(umk.count == 32 && isHex(orgId, 32), "malformed", "seeds")
        func derive(_ tag: String) -> [UInt8] {
            HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: umk), salt: [UInt8](), info: Array("\(tag)|\(orgId)".utf8),
                                   outputByteCount: 32).withUnsafeBytes { Array($0) }
        }
        return (derive(tagSeatMemberKdf), derive(tagSeatMemberPqKdf))
    }
}
