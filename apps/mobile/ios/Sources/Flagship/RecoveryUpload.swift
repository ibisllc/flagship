import Foundation
import CryptoKit
import FlagshipCore

/// Swift mirror of @flagship/protocol's `UploadRecoveryRecord` canonical
/// bytes + signer. Keep in sync with `packages/protocol/src/auth.ts`
/// (`canonicalUploadRecoveryRecord` / `signUploadRecoveryRecord`).
///
/// The phone uploads a cloud-recovery shard by POSTing a SIGNED envelope
/// to `POST /api/recovery`. The Worker base64-decodes `wrappedUmk`,
/// computes `wrappedUmkHashHex = sha256hex(those bytes)`, and verifies the
/// signature over the canonical string below under the account IRK. The
/// ciphertext is hashed (not signed directly) so the canonical bytes stay
/// small, and so .com cannot be tricked into storing attacker-substituted
/// ciphertext under a victim's passkey.
///
/// The `|`-joined field order MUST match the Worker byte-for-byte or
/// `verifyUploadRecoveryRecord` on the server fails.
public enum RecoveryUpload {
    /// `flagship/upload-recovery-record/v1`, same tag the Worker uses.
    public static let canonicalTag = "flagship/upload-recovery-record/v1"

    /// `flagship/upload-recovery-record/v1|<username>|<credentialIdHex>|<wrappedUmkHashHex>|<issuedAt>`.
    /// `credentialIdHex` and `wrappedUmkHashHex` are kept verbatim (the
    /// Worker re-derives the hash from the wire ciphertext and compares the
    /// signed value against it; the comparison is case-sensitive on the
    /// server side, so callers pass the exact hex they signed).
    public static func canonical(
        username: String,
        credentialIdHex: String,
        wrappedUmkHashHex: String,
        issuedAt: Int64
    ) -> Data {
        Data(
            [
                canonicalTag,
                username,
                credentialIdHex,
                wrappedUmkHashHex,
                String(issuedAt),
            ].joined(separator: "|").utf8
        )
    }

    /// Sign the canonical bytes with the account's CURRENT IRK and return
    /// the Ed25519 signature as lowercase hex (the wire encoding the Worker
    /// expects in the envelope's `signature` field).
    public static func sign(
        username: String,
        credentialIdHex: String,
        wrappedUmkHashHex: String,
        issuedAt: Int64,
        irk: Curve25519.Signing.PrivateKey
    ) throws -> String {
        let sig = try irk.signature(
            for: canonical(
                username: username,
                credentialIdHex: credentialIdHex,
                wrappedUmkHashHex: wrappedUmkHashHex,
                issuedAt: issuedAt
            )
        )
        return HexUtil.encode(sig)
    }

    /// SHA-256 of the wrapped-UMK ciphertext bytes, lowercase hex. The
    /// caller base64-decodes the single self-contained `wrappedUmk` blob
    /// (nonce‖ct‖tag) and feeds the raw bytes here so the hash matches what
    /// the Worker computes from the same wire value.
    public static func wrappedUmkHashHex(_ wrappedUmkBytes: Data) -> String {
        let digest = SHA256.hash(data: wrappedUmkBytes)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
