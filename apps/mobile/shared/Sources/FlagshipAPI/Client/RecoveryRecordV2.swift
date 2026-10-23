import Foundation
import CryptoKit

/// What a signed recovery record says about one optional escrow (the admin root, the ACME key):
/// never "omitted", always one of these. `keep` names the digest it keeps, so inheriting security
/// state is a signed act (SECURITY-HARDENING-PLAN.md 18.3, N03).
public enum RecoveryEscrowChange: Equatable, Sendable, Codable {
    case keep(digestHex: String)
    case replace(digestHex: String)
    case remove
    /// Absent before and absent after.
    case none

    private enum Keys: String, CodingKey { case change, digestHex }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .change) {
        case "keep": self = .keep(digestHex: try c.decode(String.self, forKey: .digestHex))
        case "replace": self = .replace(digestHex: try c.decode(String.self, forKey: .digestHex))
        case "remove": self = .remove
        case "none": self = .none
        default: throw DecodingError.dataCorruptedError(forKey: .change, in: c, debugDescription: "unknown escrow change")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .keep(let d): try c.encode("keep", forKey: .change); try c.encode(d, forKey: .digestHex)
        case .replace(let d): try c.encode("replace", forKey: .change); try c.encode(d, forKey: .digestHex)
        case .remove: try c.encode("remove", forKey: .change)
        case .none: try c.encode("none", forKey: .change)
        }
    }

    var canonical: String {
        switch self {
        case .keep(let d): return "keep:\(d)"
        case .replace(let d): return "replace:\(d)"
        case .remove: return "remove"
        case .none: return "none"
        }
    }

    var digest: String? {
        switch self {
        case .keep(let d), .replace(let d): return d
        case .remove, .none: return nil
        }
    }
}

/// The complete, versioned cloud-recovery record. Mirrors `@flagship/protocol` `recoveryRecord.ts`;
/// the shared vectors are `packages/protocol/test-vectors/recovery-record/vectors.json`.
public struct RecoveryRecordV2: Codable, Equatable, Sendable {
    public static let canonicalTag = "flagship/recovery-record/v2"
    public static let kdfVersion = 1
    public static let algVersion = 1
    public static let policy = "passkey-and-passphrase"

    public var op: String            // "put" | "delete"
    public var username: String
    public var irkPubHex: String
    public var adminRootPubHex: String   // 64 hex or "none"
    public var credentialIdHex: String
    public var wrappedUmkDigestHex: String
    public var adminRoot: RecoveryEscrowChange
    public var acmeKey: RecoveryEscrowChange
    public var fetchTokenHashHex: String
    public var prfSaltHashHex: String
    public var kdfVersion: Int
    public var algVersion: Int
    public var policy: String
    public var generation: Int
    public var nonceHex: String
    /// `genesis`, `legacy` (a v1 row) or the previous record's digest.
    public var priorDigestHex: String
    public var issuedAt: Int64

    public enum RecordError: Error, Equatable { case badField(String) }

    private static func isHex64(_ s: String) -> Bool {
        s.count == 64 && s.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }

    private static func guardText(_ name: String, _ v: String) throws {
        if v.isEmpty { throw RecordError.badField(name) }
        for u in v.unicodeScalars where u.value == 0x7c || u.value <= 0x1f || u.value == 0x7f { throw RecordError.badField(name) }
    }

    private func escrow(_ name: String, _ e: RecoveryEscrowChange) throws -> String {
        if let d = e.digest, !Self.isHex64(d) { throw RecordError.badField(name) }
        return e.canonical
    }

    public func canonicalBytes() throws -> Data {
        guard op == "put" || op == "delete" else { throw RecordError.badField("op") }
        try Self.guardText("username", username)
        try Self.guardText("credentialIdHex", credentialIdHex)
        guard Self.isHex64(irkPubHex) else { throw RecordError.badField("irkPubHex") }
        guard adminRootPubHex == "none" || Self.isHex64(adminRootPubHex) else { throw RecordError.badField("adminRootPubHex") }
        guard credentialIdHex.count >= 16, credentialIdHex.count <= 512,
              credentialIdHex.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { throw RecordError.badField("credentialIdHex") }
        for (n, v) in [("wrappedUmkDigestHex", wrappedUmkDigestHex), ("fetchTokenHashHex", fetchTokenHashHex), ("prfSaltHashHex", prfSaltHashHex)] where !Self.isHex64(v) {
            throw RecordError.badField(n)
        }
        guard kdfVersion == Self.kdfVersion else { throw RecordError.badField("kdfVersion") }
        guard algVersion == Self.algVersion else { throw RecordError.badField("algVersion") }
        guard policy == Self.policy else { throw RecordError.badField("policy") }
        guard generation >= 1 else { throw RecordError.badField("generation") }
        guard issuedAt >= 0 else { throw RecordError.badField("issuedAt") }
        guard nonceHex.count == 32, nonceHex.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { throw RecordError.badField("nonceHex") }
        guard priorDigestHex == "genesis" || priorDigestHex == "legacy" || Self.isHex64(priorDigestHex) else { throw RecordError.badField("priorDigestHex") }
        if priorDigestHex == "genesis" && generation != 1 { throw RecordError.badField("generation") }
        let fields: [String] = [
            Self.canonicalTag, op, username.lowercased(), irkPubHex, adminRootPubHex, credentialIdHex,
            wrappedUmkDigestHex, try escrow("adminRoot", adminRoot), try escrow("acmeKey", acmeKey),
            fetchTokenHashHex, prfSaltHashHex, String(kdfVersion), String(algVersion), policy, String(generation),
            nonceHex, priorDigestHex, String(issuedAt),
        ]
        return Data(fields.joined(separator: "|").utf8)
    }

    /// The chain link the next write must name.
    public func digestHex() throws -> String {
        SHA256.hash(data: try canonicalBytes()).map { String(format: "%02x", $0) }.joined()
    }

    public func sign(with key: Curve25519.Signing.PrivateKey) throws -> String {
        try key.signature(for: canonicalBytes()).map { String(format: "%02x", $0) }.joined()
    }

    public func verify(signatureHex: String, publicKey: Curve25519.Signing.PublicKey) -> Bool {
        guard let canon = try? canonicalBytes(), let sig = Self.unhex(signatureHex) else { return false }
        let pub = publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined()
        return pub == irkPubHex && publicKey.isValidSignature(sig, for: canon)
    }

    static func unhex(_ h: String) -> Data? {
        guard h.count % 2 == 0 else { return nil }
        var out = Data(capacity: h.count / 2)
        var i = h.startIndex
        while i < h.endIndex {
            let n = h.index(i, offsetBy: 2)
            guard let b = UInt8(h[i..<n], radix: 16) else { return nil }
            out.append(b); i = n
        }
        return out
    }

    public static func sha256Hex(ofBase64 b64: String) -> String? {
        guard let d = Data(base64Encoded: b64) else { return nil }
        return SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined()
    }

    /// Before anything is unwrapped: is each ciphertext the one this claim names? Returns the name
    /// of the first that is not, or nil.
    public func ciphertextMismatch(wrappedUmk: String?, wrappedAdminRoot: String?, wrappedAcmeAccountKey: String?) -> String? {
        guard let umk = wrappedUmk, Self.sha256Hex(ofBase64: umk) == wrappedUmkDigestHex else { return "wrappedUmk" }
        func check(_ b64: String?, _ e: RecoveryEscrowChange, _ name: String) -> String? {
            guard let want = e.digest else { return b64 == nil ? nil : name }
            guard let b64, Self.sha256Hex(ofBase64: b64) == want else { return name }
            return nil
        }
        return check(wrappedAdminRoot, adminRoot, "wrappedAdminRoot") ?? check(wrappedAcmeAccountKey, acmeKey, "wrappedAcmeAccountKey")
    }
}

/// `GET /api/recovery/by-username/:u` — where the stored record's signed history stands, with the
/// digests (never the ciphertext) a new record needs to chain onto it.
public struct RecoveryRecordState: Codable, Equatable, Sendable {
    public let credentialId: String
    public let wrappedUmkHash: String
    public let legacy: Bool
    public let generation: Int?
    public let digestHex: String?
    public let adminRootDigestHex: String?
    public let acmeKeyDigestHex: String?
    public init(credentialId: String, wrappedUmkHash: String, legacy: Bool, generation: Int? = nil, digestHex: String? = nil, adminRootDigestHex: String? = nil, acmeKeyDigestHex: String? = nil) {
        self.credentialId = credentialId; self.wrappedUmkHash = wrappedUmkHash; self.legacy = legacy
        self.generation = generation; self.digestHex = digestHex
        self.adminRootDigestHex = adminRootDigestHex; self.acmeKeyDigestHex = acmeKeyDigestHex
    }
}

/// The signed claim `.com` serves with the ciphertext on the gated fetch.
public struct SignedRecoveryRecord: Codable, Equatable, Sendable {
    public let claim: RecoveryRecordV2
    public let signatureHex: String
    public let digestHex: String
    public let generation: Int
}

public enum RecoveryRecordChain {
    /// Build and sign the next record for an account. `current` is the stored state (nil = none).
    /// Escrows not re-sent are `keep:<held digest>` when something is held, else `none`.
    public static func next(
        op: String = "put",
        username: String,
        irkPubHex: String,
        adminRootPubHex: String?,
        current: RecoveryRecordState?,
        credentialIdHex: String,
        wrappedUmk: String,
        wrappedAdminRoot: String?,
        wrappedAcmeAccountKey: String?,
        fetchTokenHashHex: String,
        prfSaltHashHex: String,
        issuedAt: Int64,
        nonce: Data = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
    ) throws -> RecoveryRecordV2 {
        func change(_ new: String?, _ held: String?) -> RecoveryEscrowChange {
            if let new, !new.isEmpty, let d = RecoveryRecordV2.sha256Hex(ofBase64: new) { return .replace(digestHex: d) }
            if let held { return .keep(digestHex: held) }
            return .none
        }
        guard let umkDigest = RecoveryRecordV2.sha256Hex(ofBase64: wrappedUmk) else { throw RecoveryRecordV2.RecordError.badField("wrappedUmk") }
        let legacy = current?.legacy ?? false
        return RecoveryRecordV2(
            op: op, username: username, irkPubHex: irkPubHex, adminRootPubHex: adminRootPubHex?.lowercased() ?? "none",
            credentialIdHex: credentialIdHex, wrappedUmkDigestHex: umkDigest,
            adminRoot: change(wrappedAdminRoot, current?.adminRootDigestHex),
            acmeKey: change(wrappedAcmeAccountKey, current?.acmeKeyDigestHex),
            fetchTokenHashHex: fetchTokenHashHex, prfSaltHashHex: prfSaltHashHex,
            kdfVersion: RecoveryRecordV2.kdfVersion, algVersion: RecoveryRecordV2.algVersion, policy: RecoveryRecordV2.policy,
            generation: (current != nil && !legacy) ? (current?.generation ?? 0) + 1 : 1,
            nonceHex: nonce.map { String(format: "%02x", $0) }.joined(),
            priorDigestHex: current == nil ? "genesis" : (legacy ? "legacy" : (current?.digestHex ?? "legacy")),
            issuedAt: issuedAt
        )
    }
}
