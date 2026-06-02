import Foundation
import CryptoKit

/// #28 — ACME account-key recovery crypto.
///
/// The ACME account key is the authority to mint a user's TLS certs. It
/// is an ECDSA P-256 key (Let's Encrypt account keys are ES256, NOT
/// Ed25519), generated on-device, held by the admin, stored exportably,
/// and ESCROWED into the existing WebAuthn-PRF recovery envelope so
/// losing every device doesn't brick cert issuance.
///
/// This enum is the pure crypto half: deriving the cross-platform
/// `accountKeyId`, and wrapping / unwrapping the raw 32-byte private
/// scalar for escrow. Storage + keygen live in `Keystore`.
///
/// The wire/derivation contract is shared verbatim with Android and the
/// TypeScript control plane — see the known-answer vector in
/// `AcmeAccountKeyTests`. Any drift here breaks recovery across surfaces.
public enum AcmeAccountKey {

    public enum AcmeAccountKeyError: Error, LocalizedError {
        case base64Decode
        case unwrapFailed(String)

        public var errorDescription: String? {
            switch self {
            case .base64Decode:         return "Couldn't base64-decode the escrowed account key."
            case .unwrapFailed(let m):  return "Couldn't decrypt the escrowed account key: \(m)"
            }
        }
    }

    /// Domain-separated HKDF salt for the account-key escrow wrap. DELIBERATELY
    /// different from the UMK wrap salt (`flagship/recovery-wrap/v1`) — the two
    /// secrets ride the same PRF-derived input keying material, so they MUST
    /// derive distinct AES keys. Mirrored on Android + the TS daemon.
    private static let escrowSalt = Data("flagship/recovery-acme-wrap/v1".utf8)

    /// The stable cross-platform identifier for an ACME account key:
    /// lowercase sha256-hex of the uncompressed SEC1 public point
    /// (0x04‖X‖Y, 65 bytes for P-256). CryptoKit's `x963Representation`
    /// returns exactly that uncompressed encoding.
    public static func accountKeyId(publicKey: P256.Signing.PublicKey) -> String {
        let digest = SHA256.hash(data: publicKey.x963Representation)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Wrap the raw 32-byte private scalar for escrow. Derives an AES key
    /// via HKDF-SHA256 over the PRF secret (under `escrowSalt`), seals the
    /// scalar with AES-GCM, and returns `sealed.combined` (nonce‖ct‖tag) as
    /// a single self-contained base64 blob.
    public static func wrapForEscrow(scalar: Data, prfSecret: Data) throws -> String {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: prfSecret),
            salt: escrowSalt,
            info: Data(),
            outputByteCount: 32
        )
        let sealed = try AES.GCM.seal(scalar, using: key)
        guard let combined = sealed.combined else {
            throw AcmeAccountKeyError.unwrapFailed("no combined ciphertext")
        }
        return combined.base64EncodedString()
    }

    /// Reverse of `wrapForEscrow`. Base64-decodes the combined blob,
    /// reconstructs the sealed box, and opens it under the PRF-derived key.
    /// Returns the recovered 32-byte private scalar.
    public static func unwrapFromEscrow(base64: String, prfSecret: Data) throws -> Data {
        guard let combined = Data(base64Encoded: base64) else {
            throw AcmeAccountKeyError.base64Decode
        }
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: prfSecret),
            salt: escrowSalt,
            info: Data(),
            outputByteCount: 32
        )
        do {
            let box = try AES.GCM.SealedBox(combined: combined)
            return try AES.GCM.open(box, using: key)
        } catch {
            throw AcmeAccountKeyError.unwrapFailed(String(describing: error))
        }
    }
}
