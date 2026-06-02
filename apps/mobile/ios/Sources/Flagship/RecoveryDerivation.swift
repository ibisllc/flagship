import Foundation
import CryptoKit
import Argon2Kit

/// Passphrase → (fetchToken, prfSalt) derivation for WebAuthn-PRF cloud
/// recovery (Tasks #2 + #4). This is the iOS mirror of the webapp's
/// canonical reference `apps/web/public/recovery/recovery.js`
/// (`derivePassphraseSecrets`). Any drift here breaks cross-platform
/// recovery: a passphrase enrolled on the webapp must re-derive to the
/// exact same fetchToken + prfSalt here, and vice-versa.
///
/// Contract (byte-for-byte with recovery.js):
/// ```
/// salt       = utf8("flagship.recovery.argon2.v1|" + username.lowercased())
/// masterKey  = Argon2id(passphrase_utf8, salt, t=3, m=46*1024 KiB, p=1, dkLen=32)
/// fetchToken = HKDF-SHA256(ikm=masterKey, salt=<empty>, info=utf8("flagship.recovery.fetch.v1"), L=32)
/// prfSalt    = HKDF-SHA256(ikm=masterKey, salt=<empty>, info=utf8("flagship.recovery.salt.v1"), L=32)
/// ```
///
/// - `fetchToken` is the `.com` gate: its SHA-256 is stored server-side
///   and presented (in the clear) to release the wrapped UMK. Revealing
///   it doesn't compromise `prfSalt`.
/// - `prfSalt` feeds WebAuthn's `prf.eval.first` and NEVER leaves the
///   device.
/// Domain-separating them with HKDF means even if the `.com` gate is
/// weakened, the PRF salt still depends on the full passphrase via
/// Argon2id.
///
/// The Argon2id work (46 MiB, t=3) takes ~1-2s — the flow is rare
/// (once per enrol / once per fresh-device recovery), so the latency is
/// acceptable and the offline-attack cost on a leaked ciphertext is high.
public enum RecoveryDerivation {

    /// Argon2id parameters (RFC 9106), pinned to match recovery.js.
    public static let argon2MemoryKiB: UInt32 = 46 * 1024 // 46 MiB
    public static let argon2Iterations: UInt32 = 3
    public static let argon2Parallelism: UInt32 = 1
    public static let argon2KeyBytes: UInt32 = 32

    /// `flagship.recovery.argon2.v1` — the per-user Argon2 salt namespace.
    /// The Argon2 salt itself is the lower-cased username; it only needs
    /// to be unique-per-passphrase to defeat rainbow tables, and a
    /// username is unique within Flagship + regenerable on a fresh device
    /// with no `.com` round-trip.
    public static let saltTag = "flagship.recovery.argon2.v1"

    /// HKDF `info` for the `.com` fetch gate token.
    static let fetchTokenInfo = Data("flagship.recovery.fetch.v1".utf8)
    /// HKDF `info` for the client-only PRF salt.
    static let prfSaltInfo = Data("flagship.recovery.salt.v1".utf8)

    /// The two passphrase-derived secrets. Both are exactly 32 bytes.
    public struct Secrets: Sendable, Equatable {
        /// Presented (hashed server-side) to gate the wrapped-UMK fetch.
        public let fetchToken: Data
        /// The WebAuthn PRF `eval.first` input — stays on-device.
        public let prfSalt: Data
        public init(fetchToken: Data, prfSalt: Data) {
            self.fetchToken = fetchToken
            self.prfSalt = prfSalt
        }
    }

    /// Argon2id-harden the passphrase, then HKDF-split the 32-byte master
    /// key into `(fetchToken, prfSalt)`. Mirrors recovery.js exactly; see
    /// the known-answer vector in `RecoveryDerivationTests`.
    public static func derivePassphraseSecrets(
        _ passphrase: String,
        _ username: String
    ) throws -> Secrets {
        let salt = Data("\(saltTag)|\(username.lowercased())".utf8)
        let digest = try Argon2.hash(
            password: Data(passphrase.utf8),
            salt: salt,
            iterations: argon2Iterations,
            memory: argon2MemoryKiB,
            threads: argon2Parallelism,
            length: argon2KeyBytes,
            type: .id,
            version: .v13
        )
        let masterKey = SymmetricKey(data: digest.rawData)
        // HKDF-Extract+Expand with an empty salt (RFC 5869 default), the
        // same as recovery.js's `new Uint8Array()` HKDF salt.
        let fetchToken = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: masterKey,
            salt: Data(),
            info: fetchTokenInfo,
            outputByteCount: 32
        ).withUnsafeBytes { Data($0) }
        let prfSalt = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: masterKey,
            salt: Data(),
            info: prfSaltInfo,
            outputByteCount: 32
        ).withUnsafeBytes { Data($0) }
        return Secrets(fetchToken: fetchToken, prfSalt: prfSalt)
    }

    /// Lowercase SHA-256 hex of `data` — the wire form the Worker
    /// compares against (`fetchTokenHash` / `prfSaltHash`).
    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
