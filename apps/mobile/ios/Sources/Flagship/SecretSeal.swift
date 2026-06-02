import Foundation
import FlagshipCore

/// #28 — SEAL-TO-BOX, the `Flagship`-module surface of the `crypto_box_seal`
/// primitive that wraps an ACME account key for a recipient box's STK.
///
/// The crypto itself — the Ed25519→X25519 birational map, the hand-rolled
/// GF(2^255 − 19) field arithmetic (Swift ships no big-integer), the
/// HKDF-SHA256 / AES-256-GCM seal envelope — lives ONCE, in
/// `FlagshipCore` (`apps/mobile/shared/.../PhoneEndpoint.swift`), where it is
/// pinned against the TypeScript `@flagship/protocol` known-answer vectors.
/// Re-implementing the bignum here would mean a SECOND copy of
/// security-critical curve math that could silently diverge from the box's
/// open path and produce blobs the box can't decrypt — exactly the failure
/// mode #28 cannot tolerate. So this file is a deliberate THIN FAÇADE: it
/// re-exports the canonical types under the `Flagship` module namespace
/// (which the producer + its tests import) without duplicating a single line
/// of field arithmetic.
///
/// `SecretSeal` exposes:
///   - `sealForEd25519Recipient(plaintext:recipientEd25519Pub:)` — seal to a
///     box STK Ed25519 pubkey (maps it to X25519 internally).
///   - `openWithEd25519Seed(blob:recipientEd25519Seed:)` — open with the
///     recipient's 32-byte Ed25519 seed (`crypto_sign_ed25519_sk_to_curve25519`).
///   - `openWithX25519(blob:recipientX25519Priv:)` — box-side open against a
///     raw X25519 scalar (test/vector path).
///
/// Verified by `SecretSealTests` against the four cross-platform KATs.
public typealias SecretSeal = FlagshipCore.SecretSeal

/// Ed25519 ⇄ X25519 birational map, re-exported from `FlagshipCore`.
/// `edwardsPubToMontgomery` is `toMontgomery` (public key:
/// `u = (1 + y) / (1 − y) mod 2^255−19`); `edwardsSeedToMontgomery` is
/// `toMontgomerySecret` (seed: `clamp(SHA512(seed)[0..<32])`).
public typealias Curve25519Map = FlagshipCore.Curve25519Map

public extension SecretSeal {
    /// `toMontgomery` — alias matching the TS/noble naming for the public-key
    /// birational map. Equivalent to `Curve25519Map.edwardsPubToMontgomery`.
    static func toMontgomery(_ ed25519Pub: Data) throws -> Data {
        try Curve25519Map.edwardsPubToMontgomery(ed25519Pub)
    }

    /// `toMontgomerySecret` — alias matching the TS/noble naming for the
    /// seed→scalar map. Equivalent to `Curve25519Map.edwardsSeedToMontgomery`.
    static func toMontgomerySecret(_ ed25519Seed: Data) -> Data {
        Curve25519Map.edwardsSeedToMontgomery(ed25519Seed)
    }
}
