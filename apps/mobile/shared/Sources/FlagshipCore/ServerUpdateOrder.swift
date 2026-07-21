import Foundation
import CryptoKit

/// Admin-authorized in-place server-update order — the Swift mirror of
/// `packages/protocol/src/serverUpdate.ts` (docs/server-update-mechanism.md).
///
/// The AUTHORIZATION half of the 2-of-2 update gate: an admin device signs this
/// order naming ONE box + the exact target commit. The AUTHENTICITY half (the
/// target commit is maintainer-ENDORSED) is enforced box-side by the daemon's
/// ReleaseGate — neither half alone can push code.
///
/// Canonical bytes (byte-identical to TS + the Kotlin mirror):
///
///   flagship/server-update/v1|<serverDomain>|<targetCommit>|<fromCommit>|<nonce>|<issuedAt>
///
/// ALL string fields ride VERBATIM (no lowercasing — commits are matched
/// exactly by the box), and each is guarded against `|` / control characters
/// exactly like the TS `legacyFieldGuard`, so the canonical bytes can never be
/// ambiguous. `issuedAt` is the plain decimal number (TS `String(issuedAt)`).
public struct ServerUpdateOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/server-update/v1"

    /// The box this order authorizes (its FQDN).
    public let serverDomain: String
    /// The blessed target commit (git SHA or tag) to move the box to.
    public let targetCommit: String
    /// The box's expected CURRENT commit — anti-replay of a stale order.
    public let fromCommit: String
    /// Single-use nonce (hex), consumed at-most-once by the box.
    public let nonce: String
    /// ms since epoch when the admin device minted this order.
    public let issuedAt: Int64

    public enum FieldError: Error, Equatable {
        /// A string field contains `|` or a control character.
        case reservedCharacter(field: String)
    }

    public init(
        serverDomain: String,
        targetCommit: String,
        fromCommit: String,
        nonce: String,
        issuedAt: Int64
    ) {
        self.serverDomain = serverDomain
        self.targetCommit = targetCommit
        self.fromCommit = fromCommit
        self.nonce = nonce
        self.issuedAt = issuedAt
    }

    /// Mirror of the TS `legacyFieldGuard`: reject `|` (0x7c) and control
    /// chars (0x00–0x1F, 0x7F) in any signed string field.
    private static func guarded(_ name: String, _ value: String) throws -> String {
        for scalar in value.unicodeScalars {
            let c = scalar.value
            if c == 0x7c || c <= 0x1f || c == 0x7f {
                throw FieldError.reservedCharacter(field: name)
            }
        }
        return value
    }

    public func canonicalBytes() throws -> Data {
        Data(
            try [
                Self.canonicalTag,
                Self.guarded("serverDomain", serverDomain),
                Self.guarded("targetCommit", targetCommit),
                Self.guarded("fromCommit", fromCommit),
                Self.guarded("nonce", nonce),
                String(issuedAt),
            ].joined(separator: "|").utf8
        )
    }

    /// Sign with an admin device / the admin master root key.
    public func sign(with admin: Curve25519.Signing.PrivateKey) throws -> Data {
        try admin.signature(for: canonicalBytes())
    }

    /// Verify under a candidate admin authority pubkey. Never throws — a
    /// tampered / junk order is simply rejected.
    public func verify(_ signature: Data, with adminPub: Curve25519.Signing.PublicKey) -> Bool {
        guard let bytes = try? canonicalBytes() else { return false }
        return adminPub.isValidSignature(signature, for: bytes)
    }
}
