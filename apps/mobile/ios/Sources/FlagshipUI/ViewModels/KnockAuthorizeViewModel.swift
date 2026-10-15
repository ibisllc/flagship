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
///   1. signs a `KnockAuthorization { serverId, serviceRef, pageId,
///      visitorAID, issuedAt }` over the canonical knock bytes behind ONE
///      biometric, with the identity the box knows us by
///      (docs/service-access-gating.md, "Who is signing in"): on one of our
///      own servers (AppState pods, refreshed once from `/pods` when the box
///      isn't listed, so a cold start from a deep link still knows it) this
///      device's account device key, so the box can tell an admin device from
///      the others (the AID only when the profile has no device id); on a
///      server shared with us, that share's member key; on a box we were
///      invited to, our id for the knock's app (owner AID remembered at
///      redeem, InviteOwnerStore). Only the pods decide "our own box": a
///      record naming our own AID came from a link its author chose, so it is
///      ignored. Any other box gets nothing: the device key or a share key
///      there would hand a stranger's box an id it could link,
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
    /// Visitor's global AID keypair provider (one biometric).
    private let aid: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    /// The visitor's id for an app, `deriveAppAccountId(UMK, serviceRef)`.
    private let appAid: @MainActor (_ serviceRef: String, _ reason: String) async throws -> Curve25519.Signing.PrivateKey
    /// This device's account device key; nil when the profile has none.
    private let deviceKey: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey?
    /// Servers shared with this account: box FQDN → shareId.
    private let sharedServers: [String: String]
    /// A share's member key, `HKDF(UMK, "flagship/server-share-member/v1|<shareId>")`.
    private let shareKey: @MainActor (_ shareId: String, _ reason: String) async throws -> Curve25519.Signing.PrivateKey
    private let owners: any InviteOwnerStoring
    /// FQDNs of the account's own servers (AppState pods).
    private var ownServers: Set<String>
    /// Re-reads the account's server list (FQDNs); nil = no refresh.
    private let refreshOwnServers: (@MainActor () async -> [String])?
    private let now: () -> Int64

    public static let notYourServerMessage =
        "This isn't one of your servers. Open its invite link on this phone first, then try again."

    public init(
        client: any ServiceAccessClient,
        store: any SecuredSessionStoring,
        serverDomain: String,
        svc: String,
        serviceRef: String,
        pageId: String,
        ownServers: [String] = [],
        refreshOwnServers: (@MainActor () async -> [String])? = nil,
        sharedServers: [String: String] = [:],
        owners: any InviteOwnerStoring = InviteOwnerStore(),
        aid: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        appAid: (@MainActor (_ serviceRef: String, _ reason: String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        deviceKey: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey?)? = nil,
        shareKey: (@MainActor (_ shareId: String, _ reason: String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        var shares: [String: String] = [:]
        for (host, shareId) in sharedServers {
            let h = InviteOwnerStore.normalizeHost(host)
            if !h.isEmpty { shares[h] = shareId }
        }
        self.sharedServers = shares
        self.deviceKey = deviceKey ?? { _ in nil }
        self.shareKey = shareKey ?? { _, _ in throw ServerShareFlowError.notSignedIn }
        self.client = client
        self.store = store
        self.serverDomain = serverDomain
        self.svc = svc
        self.serviceRef = serviceRef
        self.pageId = pageId
        self.now = now
        self.ownServers = Set(ownServers.map(InviteOwnerStore.normalizeHost).filter { !$0.isEmpty })
        self.refreshOwnServers = refreshOwnServers
        self.owners = owners
        self.aid = aid ?? { reason in try await Keystore.deriveAccountId(reason: reason) }
        self.appAid = appAid ?? { serviceRef, reason in
            try await Keystore.deriveAppAccountId(appRef: serviceRef, reason: reason)
        }
    }

    /// "Open notes on home?": the app's url label and the box's first label
    /// ("Open home?" when no svc label rode the link).
    public nonisolated static func title(svc: String, serverDomain: String) -> String {
        let server = serverDomain.split(separator: ".").first.map(String.init) ?? serverDomain
        return svc.isEmpty ? "Open \(server)?" : "Open \(svc) on \(server)?"
    }

    public var title: String { Self.title(svc: svc, serverDomain: serverDomain) }

    /// The key to sign this knock with, or nil when the box is neither ours nor
    /// one we hold an invite for. Our own servers win over a stored record; on
    /// a box we were invited to we sign with our id for the knock's app.
    private func signingKey(reason: String) async throws -> Curve25519.Signing.PrivateKey? {
        let host = InviteOwnerStore.normalizeHost(serverDomain)
        if ownServers.contains(host) {
            return try await ownServerKey(reason)
        }
        if let shareId = sharedServers[host] {
            return try await shareKey(shareId, reason)
        }
        if let ownerHex = owners.ownerAidHex(forServer: host),
           let ownerPub = HexUtil.decode(ownerHex) {
            let global = try await aid(reason)
            if ownerPub != global.publicKey.rawRepresentation, ServiceInvite.isAppRef(serviceRef) {
                return try await appAid(serviceRef, reason)
            }
        }
        if let refreshOwnServers {
            let fresh = await refreshOwnServers().map(InviteOwnerStore.normalizeHost)
            ownServers.formUnion(fresh.filter { !$0.isEmpty })
            if ownServers.contains(host) { return try await ownServerKey(reason) }
        }
        return nil
    }

    private func ownServerKey(_ reason: String) async throws -> Curve25519.Signing.PrivateKey {
        if let device = try await deviceKey(reason) { return device }
        return try await aid(reason)
    }

    /// The site being signed in to, e.g. `notes.home.alice.flagship.services`
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
            guard let key = try await signingKey(reason: "Open this app") else {
                phase = .failed(Self.notYourServerMessage)
                return
            }
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
            phase = .failed("Couldn't sign in. Try refreshing the page.")
        } catch ServiceAccessError.knockPageExpired {
            phase = .failed("The page expired — refresh it and try again.")
        } catch let e as ScreensClientError {
            phase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
        } catch {
            phase = .failed("Couldn't reach the server. Check your connection and try again.")
        }
    }
}
