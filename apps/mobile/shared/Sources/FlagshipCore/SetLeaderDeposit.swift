import Foundation
import CryptoKit
import FlagshipAPI

/// Phone side of the "Set as preferred server" owner vote (per-service
/// leadership Phase 6, docs/multi-pod-liveness-session-leadership.md).
///
/// The owner signs the existing `flagship/set-leader/v1` vote
/// (`CloudGossip.SetLeaderVote`: owner IRK over
/// `user|preferredStkPubHex|issuedAt|nonce`) for the chosen pod's STK and
/// deposits it ADDRESSED TO that box's domain. Unlike the SWK/CGK deposits this
/// carrier is the PUBLIC vote (no secret) — `.com` verifies the owner-IRK
/// signature before storing, and the box re-verifies on consume, riding it on
/// its gossip frame (clout). `preferredStkPubHex == "none"` clears the vote.
///
/// Body shape mirrors how `depositSwk`/`depositDecommission` build their
/// `{auth, ...}` mailbox wrapper, matching the Worker handler
/// (`handlePostSetLeaderDeposit`):
///   `{auth, authSignature, deposit:{serverDomain,requestNonceHex},
///     vote:{user,preferredStkPubHex,issuedAt,nonce}, signature}`.
public enum SetLeaderDeposit {
    public enum SetLeaderError: Error, Equatable {
        case badPreferredStkPub
    }

    /// Build the full deposit body. `preferredStkPubHex` is the chosen box's STK
    /// (32-byte hex) or `CloudGossip.setLeaderNone` to clear the vote.
    public static func buildDeposit(
        username: String,
        serverDomain: String,
        preferredStkPubHex: String,
        irk: Curve25519.Signing.PrivateKey,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        mailboxNonce: Data = SecretRequestCoordinator.randomNonce(),
        depositNonce: Data = SecretRequestCoordinator.randomNonce(),
        voteNonce: Data = SecretRequestCoordinator.randomNonce()
    ) throws -> SetLeaderDepositBody {
        let pref = preferredStkPubHex.lowercased()
        // Either the 32-byte hex pub or the "none" sentinel.
        if pref != CloudGossip.setLeaderNone {
            guard let raw = HexUtil.decode(pref), raw.count == 32 else {
                throw SetLeaderError.badPreferredStkPub
            }
        }

        let vote = CloudGossip.SetLeaderVote(
            user: username,
            preferredStkPubHex: pref,
            issuedAt: now,
            nonce: HexUtil.encode(voteNonce)
        )
        let voteSig = try vote.sign(with: irk)

        let claim = DeviceEndpointClaim(
            username: username,
            endpointLabel: "device",
            phoneIrkPub: irk.publicKey.rawRepresentation,
            issuedAt: now,
            expiresAt: now + 120_000,
            nonce: mailboxNonce
        )
        let authSig = try claim.sign(with: irk)
        let auth = MailboxAuthEnvelope.Auth(
            username: username,
            endpointLabel: "device",
            phoneIrkPub: HexUtil.encode(claim.phoneIrkPub),
            issuedAt: claim.issuedAt,
            expiresAt: claim.expiresAt,
            nonce: HexUtil.encode(claim.nonce)
        )

        return SetLeaderDepositBody(
            auth: auth,
            authSignature: HexUtil.encode(authSig),
            deposit: .init(
                serverDomain: serverDomain,
                requestNonceHex: HexUtil.encode(depositNonce)
            ),
            vote: .init(
                user: vote.user,
                preferredStkPubHex: vote.preferredStkPubHex,
                issuedAt: vote.issuedAt,
                nonce: vote.nonce
            ),
            signature: HexUtil.encode(voteSig)
        )
    }
}
