import Foundation
import CryptoKit
import FlagshipAPI

/// Pure (testable) builders for the "Replace this server" graceful-decommission
/// flow (docs/server-replacement-graceful-decommission.md). The SwiftUI VM
/// derives the owner IRK behind the biometric, then calls these to produce the
/// exact wire body the `.com` decommission deposit accepts —
/// `{ auth, authSignature, order, signature }`, byte-identical to the TS
/// `handlePostDecommission` body and the webapp builder.
///
/// Split this way (like `ServerTransferFlow`) so the crypto/canonical-bytes is
/// `swift test`-able without the UIKit-bound VM layer.
public enum ReplaceServerFlow {

    /// Disk disposition for the closeout (§6a). `wipeAfterHandoff` is the
    /// recommended default — it only wipes after the replacement proves a good
    /// restore; `wipeNow` accepts the backup as the sole copy (irreversible);
    /// `keep` leaves the data intact on a powered-off box.
    public enum Disposition: String, Sendable, Equatable, CaseIterable {
        case keep
        case wipeAfterHandoff = "wipe-after-handoff"
        case wipeNow = "wipe-now"
    }

    /// Mint + sign a `ServerDecommissionOrder` for the retiring box instance and
    /// wrap it with the IRK mailbox-auth into the deposit body.
    ///
    /// - `serverFqdn` is both `podCanonical` and the deposit path domain.
    /// - `retiredStkPubHex` is the retiring box's CURRENT STK pubkey hex (the
    ///   load-bearing replay guard, I2). Sourced from the pod directory.
    /// - `finalBackup` should be true only when peer-backup is enrolled (the VM
    ///   gates this); for `keep` there is nothing to flush so it is forced off.
    /// - `backupEpoch` is a fresh monotonic target (we use `issuedAt`).
    /// - `nonce` is a fresh random 32-byte hex.
    public static func buildDeposit(
        serverFqdn: String,
        username: String,
        irk: Curve25519.Signing.PrivateKey,
        orderKey: Curve25519.Signing.PrivateKey? = nil,
        retiredStkPubHex: String,
        finalBackup: Bool,
        disposition: Disposition,
        issuedAt: Int64,
        nonce: Data,
        authNonce: Data,
        backupEpoch: Int64? = nil
    ) throws -> DecommissionDepositBody {
        let nonceHex = HexUtil.encode(nonce)
        let epoch = backupEpoch ?? issuedAt
        let order = ServerDecommissionOrder(
            podCanonical: serverFqdn,
            retiredStkPubHex: retiredStkPubHex,
            finalBackup: finalBackup,
            diskDisposition: disposition.rawValue,
            backupEpoch: epoch,
            nonce: nonceHex,
            issuedAt: issuedAt
        )
        // Slice D — the decommission ORDER is SENSITIVE: sign with the admin
        // master root (`orderKey`) when supplied, else the IRK. The mailbox AUTH
        // below stays IRK-signed (the owner deposit credential).
        let sig = try order.sign(with: orderKey ?? irk)
        let auth = try ServerTransferFlow.buildMailboxAuth(
            username: username, irk: irk, issuedAt: issuedAt, nonce: authNonce
        )
        // The wire `order` carries the RAW (non-lowercased) field values; the
        // canonical bytes the signature commits to lowercase podCanonical /
        // retiredStkPubHex / nonce internally (see ServerDecommissionOrder),
        // and the backend re-derives those exact bytes when it re-verifies.
        return DecommissionDepositBody(
            auth: auth.auth,
            authSignature: auth.authSignature,
            order: .init(
                podCanonical: serverFqdn,
                retiredStkPubHex: retiredStkPubHex,
                finalBackup: finalBackup,
                diskDisposition: disposition.rawValue,
                backupEpoch: epoch,
                nonce: nonceHex,
                issuedAt: issuedAt
            ),
            signature: HexUtil.encode(sig)
        )
    }

    /// A fresh 32-byte random nonce (hex-encoded by the builder).
    public static func random32() -> Data { ServerTransferFlow.random32() }
}
