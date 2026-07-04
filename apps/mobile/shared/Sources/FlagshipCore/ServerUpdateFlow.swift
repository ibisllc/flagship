import Foundation
import CryptoKit
import FlagshipAPI

/// Pure (testable) builder for the "Update this server" deposit
/// (docs/server-update-mechanism.md). The SwiftUI VM derives the keys behind
/// the biometric, then calls this to produce the exact wire body the `.com`
/// update lane accepts — `{ auth, authSignature, deposit, order, signature }`,
/// byte-identical to the TS `handlePostUpdateDeposit` body and the webapp
/// builder.
///
/// TWO KEYS (the set-leader pattern, NOT the sealed lanes): the ORDER is
/// SENSITIVE and signs with the admin master root (`orderKey`) when this device
/// holds one, else the IRK (legacy); the mailbox AUTH envelope STAYS IRK-signed
/// — it is the account-owner deposit credential (`phoneIrkPub` MUST equal the
/// registered IRK), NOT the sensitive authority.
///
/// Split this way (like `ReplaceServerFlow` / `SetLeaderDeposit`) so the
/// crypto/canonical-bytes is `swift test`-able without the UIKit-bound VM layer.
public enum ServerUpdateFlow {

    public enum UpdateFlowError: Error, Equatable {
        /// targetCommit / fromCommit is not a full lowercase 40-hex commit SHA.
        case badCommit(field: String)
    }

    /// A full lowercase git commit SHA — the only commit form this phase
    /// accepts (the maintainer-endorsement check is box-side).
    public static func isValidCommit(_ s: String) -> Bool {
        s.count == 40 && s.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    /// Mint + sign a `ServerUpdateOrder` naming this box + the target commit,
    /// and wrap it with the IRK mailbox-auth into the deposit body.
    ///
    /// - `fromCommit` is the BOX-REPORTED current commit (server-detail
    ///   `currentCommit`) — never a guess; the box refuses a mismatch.
    /// - `nonce` / `authNonce` / `depositNonce` are fresh random 32 bytes.
    /// - `issuedAt` is minted at send time — `.com` enforces freshness on both
    ///   the auth wrapper and the order.
    public static func buildDeposit(
        serverFqdn: String,
        username: String,
        targetCommit: String,
        fromCommit: String,
        irk: Curve25519.Signing.PrivateKey,
        orderKey: Curve25519.Signing.PrivateKey? = nil,
        issuedAt: Int64,
        nonce: Data = ServerTransferFlow.random32(),
        authNonce: Data = ServerTransferFlow.random32(),
        depositNonce: Data = ServerTransferFlow.random32()
    ) throws -> UpdateDepositBody {
        let target = targetCommit.lowercased()
        let from = fromCommit.lowercased()
        guard isValidCommit(target) else { throw UpdateFlowError.badCommit(field: "targetCommit") }
        guard isValidCommit(from) else { throw UpdateFlowError.badCommit(field: "fromCommit") }

        let order = ServerUpdateOrder(
            serverDomain: serverFqdn,
            targetCommit: target,
            fromCommit: from,
            nonce: HexUtil.encode(nonce),
            issuedAt: issuedAt
        )
        // Slice D — the update ORDER is MAXIMALLY sensitive: sign with the admin
        // master root (`orderKey`) when supplied, else the IRK. The mailbox AUTH
        // below stays IRK-signed (the owner deposit credential).
        let sig = try order.sign(with: orderKey ?? irk)
        let auth = try ServerTransferFlow.buildMailboxAuth(
            username: username, irk: irk, issuedAt: issuedAt, nonce: authNonce
        )
        return UpdateDepositBody(
            auth: auth.auth,
            authSignature: auth.authSignature,
            deposit: .init(
                serverDomain: serverFqdn,
                requestNonceHex: HexUtil.encode(depositNonce)
            ),
            order: .init(
                serverDomain: order.serverDomain,
                targetCommit: order.targetCommit,
                fromCommit: order.fromCommit,
                nonce: order.nonce,
                issuedAt: order.issuedAt
            ),
            signature: HexUtil.encode(sig)
        )
    }
}
