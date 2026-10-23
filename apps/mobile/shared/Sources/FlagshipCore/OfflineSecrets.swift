import Foundation
import CryptoKit

/// The owner's commitment to a workload key carried in an offline recipe
/// (SECURITY-HARDENING-PLAN.md 3.13). Mirrors `@flagship/protocol` `offlineSecrets.ts`; the shared
/// vectors are `packages/protocol/test-vectors/offline-secrets/vectors.json`.
///
/// The recipe's `swkHex` is a sibling of the signed blob, so anything that can edit the file could
/// swap it. The account key signs a commitment (the key's SHA-256) bound to this server name and
/// order serial; the builder and the box refuse a key that does not match.
public struct OfflineSecretsCommitment: Codable, Equatable, Sendable {
    public static let canonicalTag = "flagship/offline-secrets/v1"

    public let serverDomain: String
    public let serial: String
    public let swkSha256Hex: String
    public let issuedAt: Int64
    public let signatureHex: String

    public init(serverDomain: String, serial: String, swkSha256Hex: String, issuedAt: Int64, signatureHex: String) {
        self.serverDomain = serverDomain; self.serial = serial; self.swkSha256Hex = swkSha256Hex
        self.issuedAt = issuedAt; self.signatureHex = signatureHex
    }

    public enum CommitmentError: Error, Equatable { case badField(String) }

    private static func guardField(_ name: String, _ v: String) throws {
        if v.isEmpty { throw CommitmentError.badField(name) }
        for u in v.unicodeScalars where u.value == 0x7c || u.value <= 0x1f || u.value == 0x7f { throw CommitmentError.badField(name) }
    }

    public static func commitment(toSwkHex swkHex: String) throws -> String {
        guard let bytes = HexUtil.decode(swkHex.lowercased()), bytes.count == 32 else { throw CommitmentError.badField("swkHex") }
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    /// `flagship/offline-secrets/v1|<serverDomain lowercase>|<serial>|<swkSha256Hex>|<issuedAt>`
    public static func canonicalBytes(serverDomain: String, serial: String, swkSha256Hex: String, issuedAt: Int64) throws -> Data {
        try guardField("serverDomain", serverDomain)
        try guardField("serial", serial)
        guard swkSha256Hex.count == 64, swkSha256Hex.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { throw CommitmentError.badField("swkSha256Hex") }
        guard issuedAt >= 0 else { throw CommitmentError.badField("issuedAt") }
        return Data([canonicalTag, serverDomain.lowercased(), serial, swkSha256Hex, String(issuedAt)].joined(separator: "|").utf8)
    }

    public static func sign(serverDomain: String, serial: String, swkHex: String, issuedAt: Int64, with key: Curve25519.Signing.PrivateKey) throws -> OfflineSecretsCommitment {
        let sha = try commitment(toSwkHex: swkHex)
        let sig = try key.signature(for: canonicalBytes(serverDomain: serverDomain, serial: serial, swkSha256Hex: sha, issuedAt: issuedAt))
        return OfflineSecretsCommitment(serverDomain: serverDomain.lowercased(), serial: serial, swkSha256Hex: sha, issuedAt: issuedAt, signatureHex: HexUtil.encode(sig))
    }
}
