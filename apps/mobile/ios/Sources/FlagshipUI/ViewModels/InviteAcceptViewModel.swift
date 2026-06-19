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
///   1. looks up the SIGNED create it cached at create time (`InviteCreateStore`;
///      `.com` never returns the create signature), keyed by the reply's inviteId,
///   2. confirms the reply's serviceRef matches the cached create,
///   3. POSTs `{accept, acceptSig, create, createSig}` to the AUTHOR's box, which
///      verifies BOTH the consumer's signature AND the owner's create authority,
///      then binds the contact AID. The author FINALIZES, so a link-thief who
///      never reached the author's friend-channel can't produce an acceptance the
///      author will submit.
///
/// No biometric: the AID/IRK aren't needed here (the box re-verifies the cached
/// create signature + the consumer's signature). The author is just a courier of
/// two already-signed artifacts.
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
    private let createStore: any InviteCreateStore

    public init(
        client: any ServiceAccessClient,
        serverDomain: String,
        inviteId: String,
        serviceRef: String,
        contactAidHex: String,
        acceptSigHex: String,
        acceptedAt: Int64,
        createStore: (any InviteCreateStore)? = nil
    ) {
        self.client = client
        self.serverDomain = serverDomain
        self.inviteId = inviteId.lowercased()
        self.serviceRef = serviceRef
        self.contactAidHex = contactAidHex.lowercased()
        self.acceptSigHex = acceptSigHex.lowercased()
        self.acceptedAt = acceptedAt
        self.createStore = createStore ?? UserDefaultsInviteCreateStore()
    }

    /// True iff this device created the invite (so it can finalize). The author
    /// must finalize on the device that holds the cached signed create.
    public var canFinalize: Bool { createStore.get(inviteId: inviteId) != nil }

    public func finalize() async {
        if case .submitting = phase { return }
        guard let stored = createStore.get(inviteId: inviteId) else {
            phase = .failed("This approval is for an invite created on another device. Open it on the device you sent the invite from.")
            return
        }
        guard stored.serviceRef == serviceRef else {
            phase = .failed("This approval doesn't match the invite. Ask them to resend it.")
            return
        }
        phase = .submitting
        let accept: [String: Any] = [
            "inviteId": inviteId,
            "serviceRef": serviceRef,
            "contactAID": contactAidHex,
            "acceptedAt": acceptedAt,
        ]
        do {
            let result = try await client.acceptInvite(
                serverDomain: serverDomain,
                accept: accept,
                acceptSigHex: acceptSigHex,
                create: stored.createDict,
                createSigHex: stored.createSigHex)
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
