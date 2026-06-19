import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Visitor-side authorizer for web-experience gating (docs/service-access-
/// gating.md, "Web-experience gating").
///
/// A plain browser can't AID-sign Flagship's visit header, so a restricted
/// service's WEBSITE is unreachable from one. The box closes that with a
/// WhatsApp-Web-style QR-login: a browser gets a knock page with a deeplink +
/// QR; THIS phone authorizes it. This VM:
///   1. AID-signs a `KnockAuthorization { serverId, serviceRef, pageId,
///      visitorAID, issuedAt }` over the canonical knock bytes with the
///      visitor's STABLE AID (UMK-derived, survives the visitor's IRK
///      rotations) — behind ONE biometric,
///   2. POSTs it to the BOX's `/api/service-access/knock/authorize`,
///   3. on 200 the box mints the browser session + a phone-held secretId; we
///      persist a `SecuredSession` (so the owner can later refresh/stop it from
///      Settings) and tell the user to return to the website.
@Observable
@MainActor
public final class KnockAuthorizeViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case authorizing
        case authorized
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    private let client: any ServiceAccessClient
    private let store: any SecuredSessionStoring
    public let serverDomain: String
    public let svc: String
    public let serviceRef: String
    public let pageId: String
    /// Visitor's AID keypair provider (one biometric).
    private let aid: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64

    public init(
        client: any ServiceAccessClient,
        store: any SecuredSessionStoring,
        serverDomain: String,
        svc: String,
        serviceRef: String,
        pageId: String,
        aid: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.client = client
        self.store = store
        self.serverDomain = serverDomain
        self.svc = svc
        self.serviceRef = serviceRef
        self.pageId = pageId
        self.now = now
        self.aid = aid ?? { reason in try await Keystore.deriveAccountId(reason: reason) }
    }

    /// The site the owner is authorizing, e.g. `notes.home.alice.flagship.services`
    /// (or the box apex when no svc label rode the deeplink).
    public var serviceUrl: String {
        SecuredSession.serviceUrl(svc: svc, serverDomain: serverDomain)
    }

    public func authorize() async {
        if case .authorizing = phase { return }
        guard !serverDomain.isEmpty, !serviceRef.isEmpty, !pageId.isEmpty else {
            phase = .failed("This link is missing or malformed — refresh the page and try again.")
            return
        }
        phase = .authorizing
        do {
            let key = try await aid("Authorize this site")
            let aidPub = key.publicKey.rawRepresentation
            let aidHex = HexUtil.encode(aidPub)
            let ts = now()
            // AID-sign the canonical knock bytes (the pageId is IN the
            // signature, so this can't be replayed to authorize another page).
            let sig = try ServiceInvite.signKnockAuthorization(
                serverId: serverDomain,
                serviceRef: serviceRef,
                pageId: pageId,
                visitorAID: aidPub,
                issuedAt: ts,
                aid: key)
            let authorization: [String: Any] = [
                "serverId": serverDomain,
                "serviceRef": serviceRef,
                "pageId": pageId,
                "visitorAID": aidHex,
                "issuedAt": ts,
            ]
            let result = try await client.authorizeKnock(
                serverDomain: serverDomain,
                authorization: authorization,
                signatureHex: HexUtil.encode(sig))
            // Persist the session so the owner can refresh/stop it later.
            store.put(SecuredSession(
                secretId: result.secretId,
                serverId: serverDomain,
                serviceRef: result.serviceRef.isEmpty ? serviceRef : result.serviceRef,
                serviceUrl: serviceUrl,
                browserAgent: result.browserAgent,
                startedAt: result.startedAt != 0 ? result.startedAt : ts))
            phase = .authorized
        } catch ServiceAccessError.knockNotAllowed {
            phase = .failed("You don't have access to this service.")
        } catch ServiceAccessError.knockBadRequest {
            phase = .failed("Couldn't authorize — try refreshing the page.")
        } catch ServiceAccessError.knockPageExpired {
            phase = .failed("The page expired — refresh it and try again.")
        } catch let e as ScreensClientError {
            phase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
        } catch {
            phase = .failed("Couldn't reach the server. Check your connection and try again.")
        }
    }
}
