import Foundation
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// Author-side MANUAL-approve finalize (docs/service-access-gating.md, "## v2
/// hardening", tier 2).
///
/// The CONSUMER sent back a reply link (`flagship://invite-accept?…`) carrying
/// their contact-AID-signed `AcceptServiceInvite`. THIS phone is the AUTHOR: it
/// POSTs ONLY `{accept, acceptSig}` to the AUTHOR's box, which FETCHES the owner's
/// signed create from `.com` by the acceptance's inviteId (STK-signed), verifies
/// BOTH the consumer's signature AND the owner's create authority, then binds the
/// contact AID. The author FINALIZES, so a link-thief who never reached the
/// author's friend-channel can't produce an acceptance the author will submit —
/// and can finalize this from ANY of their devices (no local create cache).
///
/// No biometric: the AID/IRK aren't needed here. The author is just a courier of
/// the consumer's already-signed acceptance.
@Observable
@MainActor
public final class InviteAcceptViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case submitting
        case done(serviceRef: String)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    private let client: any ServiceAccessClient
    private let serverDomain: String
    private let inviteId: String
    private let serviceRef: String
    private let contactAidHex: String
    private let acceptSigHex: String
    private let acceptedAt: Int64

    public init(
        client: any ServiceAccessClient,
        serverDomain: String,
        inviteId: String,
        serviceRef: String,
        contactAidHex: String,
        acceptSigHex: String,
        acceptedAt: Int64
    ) {
        self.client = client
        self.serverDomain = serverDomain
        self.inviteId = inviteId.lowercased()
        self.serviceRef = serviceRef
        self.contactAidHex = contactAidHex.lowercased()
        self.acceptSigHex = acceptSigHex.lowercased()
        self.acceptedAt = acceptedAt
    }

    public func finalize() async {
        if case .submitting = phase { return }
        phase = .submitting
        let accept: [String: Any] = [
            "inviteId": inviteId,
            "serviceRef": serviceRef,
            "contactAID": contactAidHex,
            "acceptedAt": acceptedAt,
        ]
        do {
            // ONLY {accept, acceptSig} — the box fetches the owner's create from .com.
            let result = try await client.acceptInvite(
                serverDomain: serverDomain,
                accept: accept,
                acceptSigHex: acceptSigHex)
            if result.bound {
                phase = .done(serviceRef: result.serviceRef.isEmpty ? serviceRef : result.serviceRef)
            } else {
                phase = .failed("The server didn't confirm the approval. Try again in a moment.")
            }
        } catch ServiceAccessError.acceptRejected {
            phase = .failed("Couldn't verify this approval. Ask them to open the invite again and resend.")
        } catch ServiceAccessError.acceptNotForThisBox {
            phase = .failed("This invite is for a service that isn't on this server anymore.")
        } catch let e as ScreensClientError {
            phase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
        } catch {
            phase = .failed("Couldn't reach the server. Check your connection and try again.")
        }
    }
}
