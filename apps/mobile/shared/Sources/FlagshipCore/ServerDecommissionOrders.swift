import Foundation
import CryptoKit

/// Server-decommission order — the Swift mirror of the `server-decommission`
/// envelope in `packages/protocol/src/legacyEnvelopes.ts`
/// (docs/server-replacement-graceful-decommission.md §6).
///
/// Owner-IRK-signed "this box instance is replaced — retire yourself" order: a
/// SELF-AUTHORIZING eviction notice. A box that receives it (by any channel) and
/// verifies the signature + the STK-match runs the WHOLE closeout directly.
///
/// - `retiredStkPubHex` binds the order to ONE specific box instance (its STK
///   pubkey). The replacement box has a different STK and ignores it, so a
///   replayed old order can never retire the new tenant.
/// - `diskDisposition` ∈ {"keep","wipe-after-handoff","wipe-now"} (§6a) — never
///   the unconditional account-deletion wipe.
///
/// Canonical bytes (byte-identical to TS + the Kotlin mirror):
///
///   flagship/server-decommission/v1|<podCanonical>|<retiredStkPubHex>|<finalBackup as "1"|"0">|<diskDisposition>|<backupEpoch>|<nonce>|<issuedAt>
///
/// `podCanonical`, `retiredStkPubHex`, and `nonce` are lowercased into the
/// canonical bytes (matching the TS `.toLowerCase()`); `diskDisposition` is an
/// enum literal carried verbatim. `finalBackup` encodes as the string "1" or
/// "0"; `backupEpoch` and `issuedAt` are the plain decimal numbers (matching the
/// TS template-literal `${number}` stringification).
public struct ServerDecommissionOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/server-decommission/v1"

    public let podCanonical: String
    public let retiredStkPubHex: String
    public let finalBackup: Bool
    /// One of "keep" | "wipe-after-handoff" | "wipe-now".
    public let diskDisposition: String
    public let backupEpoch: Int64
    public let nonce: String
    public let issuedAt: Int64

    public init(
        podCanonical: String,
        retiredStkPubHex: String,
        finalBackup: Bool,
        diskDisposition: String,
        backupEpoch: Int64,
        nonce: String,
        issuedAt: Int64
    ) {
        self.podCanonical = podCanonical
        self.retiredStkPubHex = retiredStkPubHex
        self.finalBackup = finalBackup
        self.diskDisposition = diskDisposition
        self.backupEpoch = backupEpoch
        self.nonce = nonce
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() -> Data {
        Data(
            [
                Self.canonicalTag,
                podCanonical.lowercased(),
                retiredStkPubHex.lowercased(),
                finalBackup ? "1" : "0",
                diskDisposition,
                String(backupEpoch),
                nonce.lowercased(),
                String(issuedAt),
            ].joined(separator: "|").utf8
        )
    }

    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }

    public func verify(_ signature: Data, with irkPub: Curve25519.Signing.PublicKey) -> Bool {
        irkPub.isValidSignature(signature, for: canonicalBytes())
    }
}
