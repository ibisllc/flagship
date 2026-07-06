import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Friend-side redeem orchestrator (docs/service-access-gating.md, "## v2 hardening").
///
/// The owner shares `https://<server>/invite#<secret>&a=<authorAID>[&i=…]`.
/// The friend opens it (deep-link → InviteRedeem screen); this VM:
///   1. derives the friend's PER-AUTHOR contact AID
///      (`deriveContactAccountId(UMK, authorAID)`) from the link's authorAID —
///      a pseudonym UNLINKABLE across authors (NOT the global AID). For a v1
///      bare link (no authorAID) it falls back to the global AID.
///   2. AID-signs the redeem over { secretHash, visitorAID=contactAID,
///      redeemedAt } and POSTs the raw secret to the BOX's redeem endpoint,
///   3a. AUTO-approve → the box binds the contact AID + confirms — the friend
///       now has access (and gets a `Flagship-App-Session` cookie),
///   3b. MANUAL-approve → the box returns {pending}; the VM signs an
///       `AcceptServiceInvite` (with the SAME contact AID + the link's inviteId)
///       and surfaces a REPLY link/QR the friend sends back through the same
///       private channel for the AUTHOR to finalize.
@Observable
@MainActor
public final class InviteRedeemViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case redeeming
        case done(serviceRef: String, firstBind: Bool)
        /// MANUAL-approve: the friend must send `replyLink` back to the author,
        /// who finalizes the bind. The reply embeds the friend's contact-AID
        /// acceptance signature.
        case pendingApproval(serviceRef: String, replyLink: String)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    private let client: any ServiceAccessClient
    private let serverDomain: String
    private let secretHex: String
    /// Author's stable AID from the link (hex). Drives the per-author contact AID.
    /// nil for a v1 bare link ⇒ fall back to the global AID.
    private let authorAidHex: String?
    /// The inviteId from the link — REQUIRED to sign a manual-approve acceptance.
    private let inviteId: String?
    /// Redemption-AID provider for a given author (one biometric): the per-author
    /// contact AID when `authorAID` is present, else the global AID.
    private let redeemAid: @MainActor (_ authorAidHex: String?, _ reason: String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64

    public init(
        client: any ServiceAccessClient,
        serverDomain: String,
        secretHex: String,
        authorAidHex: String? = nil,
        inviteId: String? = nil,
        redeemAid: (@MainActor (_ authorAidHex: String?, _ reason: String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.client = client
        self.serverDomain = serverDomain
        self.secretHex = secretHex.lowercased()
        self.authorAidHex = authorAidHex?.lowercased()
        self.inviteId = inviteId?.lowercased()
        self.now = now
        self.redeemAid = redeemAid ?? { authorAidHex, reason in
            if let a = authorAidHex, let authorPub = HexUtil.decode(a) {
                return try await Keystore.deriveContactAccountId(authorAidPub: authorPub, reason: reason)
            }
            // v1 fallback: a bare link with no authorAID ⇒ the global AID.
            return try await Keystore.deriveAccountId(reason: reason)
        }
    }

    public var serverHost: String { serverDomain }

    public func redeem() async {
        if case .redeeming = phase { return }
        guard secretHex.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            phase = .failed("This invite link is missing or malformed.")
            return
        }
        phase = .redeeming
        do {
            let key = try await redeemAid(authorAidHex, "Accept this invite")
            let aidPub = key.publicKey.rawRepresentation
            guard let secret = HexUtil.decode(secretHex) else {
                phase = .failed("This invite link is malformed."); return
            }
            let secretHash = ServiceInvite.secretHash(secret: secret)
            let ts = now()
            let bytes = try ServiceInvite.canonicalRedeem(secretHash: secretHash, visitorAID: aidPub, redeemedAt: ts)
            let sig = try ServiceInvite.sign(bytes, with: key)
            let result = try await client.redeemInvite(
                serverDomain: serverDomain,
                secretHex: secretHex,
                visitorAidHex: HexUtil.encode(aidPub),
                aidSigHex: HexUtil.encode(sig),
                redeemedAt: ts)
            if result.pending {
                await handlePending(serviceRef: result.serviceRef, contactAid: key)
            } else {
                phase = .done(serviceRef: result.serviceRef, firstBind: result.firstBind)
            }
        } catch ServiceAccessError.inviteUnknown {
            phase = .failed("This invite link is unknown or was withdrawn.")
        } catch ServiceAccessError.inviteAlreadyBound {
            phase = .failed("This invite is already linked to another account.")
        } catch ServiceAccessError.inviteRevoked {
            phase = .failed("This invite has been revoked.")
        } catch ServiceAccessError.inviteExpiredOrFull {
            phase = .failed("This invite has expired or is full.")
        } catch let e as ScreensClientError {
            phase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
        } catch {
            phase = .failed("Couldn't reach the server. Check your connection and try again.")
        }
    }

    /// MANUAL-approve: sign the acceptance with the SAME contact AID + the link's
    /// inviteId, and build the reply link/QR the friend sends back to the author.
    private func handlePending(serviceRef: String, contactAid: Curve25519.Signing.PrivateKey) async {
        guard let inviteId, !inviteId.isEmpty else {
            // A manual invite whose link omitted the inviteId can't be accepted.
            phase = .failed("This invite needs the owner's approval, but the link is missing information. Ask them to resend it.")
            return
        }
        do {
            let contactPub = contactAid.publicKey.rawRepresentation
            let acceptedAt = now()
            let sig = try ServiceInvite.signAcceptServiceInvite(
                inviteId: inviteId, serviceRef: serviceRef, contactAID: contactPub,
                acceptedAt: acceptedAt, contactAid: contactAid)
            guard let reply = ServiceInviteLinks.acceptReplyLink(
                serverDomain: serverDomain, inviteId: inviteId, serviceRef: serviceRef,
                contactAidHex: HexUtil.encode(contactPub), acceptSigHex: HexUtil.encode(sig),
                acceptedAt: acceptedAt) else {
                phase = .failed("Couldn't prepare the approval reply.")
                return
            }
            phase = .pendingApproval(serviceRef: serviceRef, replyLink: reply)
        } catch {
            phase = .failed("Couldn't prepare the approval reply.")
        }
    }
}
