import Foundation
import CryptoKit

/// Slice D (docs/device-admin-tier-spec.md §5.3, decision D-3) — escrow crypto
/// for the ADMIN MASTER ROOT under the WebAuthn-PRF recovery credential.
///
/// The admin root is NOT UMK-derived, so a UMK backup alone cannot reconstruct
/// it: to survive "lost every admin device, kept the recovery credential" it
/// must be wrapped under the SAME PRF secret the UMK escrow uses, alongside the
/// existing wrapped-UMK and ACME-account-key escrow blobs (see
/// `AcmeAccountKey.wrapForEscrow`). Credential recovery can then unwrap the old
/// root, mint a new one, and sign the `admin-root-rotation/v1` proof.
///
/// This CORE phase only INCLUDES the root in the escrow upload; the
/// recovery-rotation SIGNING is deferred to a later phase. The pure crypto here
/// mirrors `AcmeAccountKey` verbatim (a distinct HKDF salt so it derives a
/// different AES key from the shared PRF secret).
public enum AdminRootEscrow {

    public enum AdminRootEscrowError: Error, LocalizedError {
        case base64Decode
        case unwrapFailed(String)

        public var errorDescription: String? {
            switch self {
            case .base64Decode:        return "Couldn't base64-decode the escrowed admin key."
            case .unwrapFailed(let m): return "Couldn't decrypt the escrowed admin key: \(m)"
            }
        }
    }

    /// Domain-separated HKDF salt for the admin-root escrow wrap. DELIBERATELY
    /// distinct from the UMK wrap salt (`flagship/recovery-wrap/v1`) and the ACME
    /// wrap salt (`flagship/recovery-acme-wrap/v1`): all three secrets ride the
    /// same PRF-derived input keying material, so they MUST derive distinct AES
    /// keys. Mirror on Android + the TS control plane when those land.
    private static let escrowSalt = Data("flagship/recovery-admin-root-wrap/v1".utf8)

    /// Wrap the raw 32-byte admin-root Ed25519 seed for escrow. Derives an AES
    /// key via HKDF-SHA256 over the PRF secret (under `escrowSalt`), seals the
    /// seed with AES-GCM, and returns `sealed.combined` (nonce‖ct‖tag) as a
    /// single self-contained base64 blob.
    public static func wrapForEscrow(seed: Data, prfSecret: Data) throws -> String {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: prfSecret),
            salt: escrowSalt,
            info: Data(),
            outputByteCount: 32
        )
        let sealed = try AES.GCM.seal(seed, using: key)
        guard let combined = sealed.combined else {
            throw AdminRootEscrowError.unwrapFailed("no combined ciphertext")
        }
        return combined.base64EncodedString()
    }

    /// Reverse of `wrapForEscrow` — recover the raw 32-byte admin-root seed.
    /// (Used by the deferred recovery-rotation path; provided now so the escrow
    /// round-trips end-to-end and is unit-testable.)
    public static func unwrapFromEscrow(base64: String, prfSecret: Data) throws -> Data {
        guard let combined = Data(base64Encoded: base64) else {
            throw AdminRootEscrowError.base64Decode
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
            throw AdminRootEscrowError.unwrapFailed(String(describing: error))
        }
    }
}
