import Foundation
import CryptoKit
import AuthenticationServices

/// WebAuthn-PRF cloud recovery — J.3/J.4 in the architecture spec.
///
/// Setup (on the user's primary phone, after onboarding):
///   1. Register a platform passkey for `flagshipserver.com` via
///      ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest.
///   2. Run a PRF-extension assertion to derive a 32-byte secret from
///      the passkey + a fixed salt.
///   3. AES-GCM encrypt the UMK seed under the PRF-derived key.
///   4. Upload {credentialID, ciphertext, nonce} to flagshipserver.com.
///
/// Recovery (on a fresh phone — old phone lost):
///   1. PRF assertion against the registered credential.
///   2. Fetch envelope from flagshipserver.com keyed by credentialID.
///   3. AES-GCM decrypt → recover the original UMK seed.
///   4. Inject into Keystore so derived keys (BAK/IRK/SWK) match.
///
/// The PRF extension (CTAP2 hmac-secret) isn't surfaced by Apple's
/// AuthenticationServices framework prior to iOS 18, and even on 18+
/// it has caveats (requires .platformProvider with explicit PRF
/// support). This module models the round-trip API so the UI flow
/// works end-to-end against the mock surface; the live impl needs an
/// ASAuthorizationController delegate to do the actual ceremony.
public struct Recovery {

    public enum RecoveryError: Error, LocalizedError {
        case prfUnavailable
        case envelopeMissing
        case decryptionFailed(String)
        case keystoreError(String)

        public var errorDescription: String? {
            switch self {
            case .prfUnavailable:        return "Your authenticator doesn't support PRF; pick another."
            case .envelopeMissing:       return "No recovery envelope is registered for that credential."
            case .decryptionFailed(let m): return "Couldn't decrypt the UMK: \(m)"
            case .keystoreError(let m):    return "Keystore error: \(m)"
            }
        }
    }

    /// Wrap a UMK seed under a PRF-derived key. Returns the AES-GCM
    /// ciphertext + nonce as base64 strings, ready to ship.
    public static func wrap(
        umkSeed: SymmetricKey,
        prfSecret: Data
    ) throws -> (ciphertextBase64: String, nonceBase64: String) {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: prfSecret),
            salt: Data("flagship/recovery-wrap/v1".utf8),
            info: Data(),
            outputByteCount: 32
        )
        let umkBytes = umkSeed.withUnsafeBytes { Data($0) }
        let sealed = try AES.GCM.seal(umkBytes, using: key)
        guard let combined = sealed.combined else {
            throw RecoveryError.decryptionFailed("no combined ciphertext")
        }
        // Split nonce (first 12 bytes of combined) from ciphertext+tag.
        let nonce = combined.prefix(12)
        let rest = combined.dropFirst(12)
        return (rest.base64EncodedString(), Data(nonce).base64EncodedString())
    }

    /// Reverse of `wrap`. Decrypts the envelope into a UMK seed.
    public static func unwrap(
        ciphertextBase64: String,
        nonceBase64: String,
        prfSecret: Data
    ) throws -> SymmetricKey {
        guard let ct = Data(base64Encoded: ciphertextBase64),
              let nonceData = Data(base64Encoded: nonceBase64) else {
            throw RecoveryError.decryptionFailed("base64 decode")
        }
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: prfSecret),
            salt: Data("flagship/recovery-wrap/v1".utf8),
            info: Data(),
            outputByteCount: 32
        )
        do {
            let nonce = try AES.GCM.Nonce(data: nonceData)
            let box = try AES.GCM.SealedBox(combined: Data(nonceData) + ct)
            _ = nonce
            let plaintext = try AES.GCM.open(box, using: key)
            return SymmetricKey(data: plaintext)
        } catch {
            throw RecoveryError.decryptionFailed(String(describing: error))
        }
    }

    /// Fixed PRF input salt — `hmac-secret` is keyed by salt, so the
    /// daemon side and recovery side must agree. Mirrors the constant
    /// in `packages/server-daemon/src/recovery/prf.ts`.
    public static let prfSalt: Data = Data("flagship/recovery/v1".utf8)
}
