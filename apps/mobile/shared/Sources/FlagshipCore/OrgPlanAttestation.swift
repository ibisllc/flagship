import Foundation

/// `.com`'s CA signature over an org's Business plan (packages/protocol/src/planAttestation.ts, the org variant),
/// pinned by test-vectors/org-plan/ `attestation`. An attestation that doesn't verify means "plan unknown", never
/// "lapsed".
///
///   flagship/org-plan-attestation/v1|<orgId>|<status>|<seatLimit>|<paidSeats>|<trialEndsAt>|<paidUntil>|<issuedAt>|<expiresAt>
public struct OrgPlanAttestation: Equatable, Sendable {
    public static let tag = "flagship/org-plan-attestation/v1"

    public var orgId: String
    public var status: OrgPlanStatus
    public var seatLimit: Int64
    public var paidSeats: Int64
    public var trialEndsAt: Int64
    public var paidUntil: Int64
    public var issuedAt: Int64
    public var expiresAt: Int64
    public var signedBy: String
    public var signatures: [(pubkey: String, sig: String)]

    public static func == (a: OrgPlanAttestation, b: OrgPlanAttestation) -> Bool {
        a.orgId == b.orgId && a.status == b.status && a.seatLimit == b.seatLimit && a.paidSeats == b.paidSeats && a.trialEndsAt == b.trialEndsAt
            && a.paidUntil == b.paidUntil && a.issuedAt == b.issuedAt && a.expiresAt == b.expiresAt && a.signedBy == b.signedBy
            && a.signatures.map(\.pubkey) == b.signatures.map(\.pubkey) && a.signatures.map(\.sig) == b.signatures.map(\.sig)
    }

    public struct Malformed: Error, Equatable { public let field: String }

    /// The signed bytes; throws on a field the TS refuses.
    public func canonical() throws -> [UInt8] {
        guard orgId.utf8.count == 32, CanonicalJson.isLowerHex(orgId) else { throw Malformed(field: "orgId") }
        for (k, v) in [("seatLimit", seatLimit), ("paidSeats", paidSeats), ("trialEndsAt", trialEndsAt), ("paidUntil", paidUntil),
                       ("issuedAt", issuedAt), ("expiresAt", expiresAt)] where v < 0 || v > 9_007_199_254_740_991 {
            throw Malformed(field: k)
        }
        guard expiresAt > issuedAt else { throw Malformed(field: "expiresAt") }
        return Array([Self.tag, orgId, status.rawValue, String(seatLimit), String(paidSeats), String(trialEndsAt), String(paidUntil),
                      String(issuedAt), String(expiresAt)].joined(separator: "|").utf8)
    }

    /// Shape-check an untrusted attestation (no signature check).
    public static func parse(_ v: JSONValue?) -> OrgPlanAttestation? {
        guard let o = v?.object, o["kind"]?.string == "OrgPlanAttestation", o["version"]?.isOne == true, let signedBy = o["signedBy"]?.string,
              let sigs = o["signatures"]?.array, let orgId = o["orgId"]?.string, let status = o["status"]?.string.flatMap(OrgPlanStatus.init(rawValue:)),
              let seatLimit = o["seatLimit"]?.time, let paidSeats = o["paidSeats"]?.time, let trialEndsAt = o["trialEndsAt"]?.time,
              let paidUntil = o["paidUntil"]?.time, let issuedAt = o["issuedAt"]?.time, let expiresAt = o["expiresAt"]?.time else { return nil }
        var signatures: [(pubkey: String, sig: String)] = []
        for s in sigs {
            guard let p = s["pubkey"]?.string, let g = s["sig"]?.string else { return nil }
            signatures.append((p, g))
        }
        let a = OrgPlanAttestation(orgId: orgId, status: status, seatLimit: seatLimit, paidSeats: paidSeats, trialEndsAt: trialEndsAt, paidUntil: paidUntil,
                                   issuedAt: issuedAt, expiresAt: expiresAt, signedBy: signedBy, signatures: signatures)
        return (try? a.canonical()) == nil ? nil : a
    }

    /// True when one signature by `signedBy` verifies under `pubkeyHex` (the CA key the caller already trusts) and
    /// `now` is inside the attestation's window.
    public func verify(pubkeyHex: String, now: Int64) -> Bool {
        guard now >= issuedAt, now < expiresAt, let msg = try? canonical(), let pub = try? CanonicalJson.hexToBytes(pubkeyHex.lowercased()) else { return false }
        for s in signatures where s.pubkey.lowercased() == signedBy.lowercased() && s.pubkey.lowercased() == pubkeyHex.lowercased() {
            if let sig = try? CanonicalJson.hexToBytes(s.sig.lowercased()), PqHybrid.ed25519VerifyStrict(signature: sig, message: msg, publicKey: pub) {
                return true
            }
        }
        return false
    }
}

/// Voucher files (packages/protocol/src/voucherBatch.ts): a bearer secret holding vouchers, nothing about the buyer.
/// iOS only writes them; it never imports one (App Review 3.1.1).
public enum VoucherFiles {
    public static let kind = "flagship-vouchers"
    public static let maxVouchers = 5000

    public struct FileError: Error, Equatable { public let reason: String }

    /// A voucher file's text: the vouchers deduplicated and sorted, canonical JSON.
    public static func text(_ vouchers: [Voucher]) throws -> String {
        guard !vouchers.isEmpty, vouchers.count <= maxVouchers else { throw FileError(reason: "voucher file: 1 to 5000 vouchers") }
        var seen = Set<String>()
        var out: [Voucher] = []
        for v in vouchers {
            guard let p = Vouchers.parse(v.json) else { throw FileError(reason: "voucher file: malformed voucher") }
            if seen.insert(Vouchers.nullifier(p)).inserted { out.append(p) }
        }
        out.sort(by: VoucherWalletSync.less)
        return try CanonicalJson.canonicalJson(["kind": .string(kind), "v": 1, "vouchers": .array(out.map(\.json))])
    }

    /// Files of `perFile` vouchers each; the last holds the rest.
    public static func split(_ vouchers: [Voucher], perFile: Int) throws -> [String] {
        guard perFile >= 1 else { throw FileError(reason: "voucher file: bad size") }
        return try stride(from: 0, to: vouchers.count, by: perFile).map { try text(Array(vouchers[$0..<min(vouchers.count, $0 + perFile)])) }
    }

    /// The first 8 hex of the SHA-256 of a file's text, so two people can tell files apart.
    public static func id(_ text: String) -> String { String(CanonicalJson.sha256Hex(text).prefix(8)) }
}
