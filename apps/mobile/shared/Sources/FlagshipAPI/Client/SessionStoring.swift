import Foundation

/// The non-secret identity needed to restore a passwordless demo session after
/// process death. The paired-session token remains in the platform's protected
/// token store; this record only carries the public username + server block.
public struct DemoSessionRecord: Codable, Equatable, Sendable {
    public let username: String
    public let server: DemoServerBlock

    public init(username: String, server: DemoServerBlock) {
        self.username = username
        self.server = server
    }
}

/// Actor-protocol that decouples LiveScreensClient from the concrete
/// session-store implementation. Both SessionStore (UserDefaults) and
/// KeychainSessionStore (Keychain) conform, so callers pick the right
/// backend without LiveScreensClient knowing.
///
/// MULTI-POD (Fix B) — the single `sessionToken` / `podBaseUrl` slots are the
/// ACTIVE pod's, mirrored from a pod-keyed token store (`sessionToken(forPodId:)`)
/// by `PodSessionSync`. Pairing a 2nd box writes its token under its own pod id
/// — it no longer overwrites the 1st box's token. `LiveScreensClient` keeps
/// reading the single active slots, so the per-pod store is transparent to it.
public protocol SessionStoring: Actor {
    var podBaseUrl: String? { get }
    var sessionToken: String? { get }
    func setPodBaseUrl(_ url: String?) async
    func setSessionToken(_ token: String?) async
    func clear() async

    // MARK: Per-pod token store (Fix B)

    /// The stored session token for `podId` (its lower-cased FQDN), or nil.
    func sessionToken(forPodId podId: String) async -> String?
    /// Persist `token` for `podId`. nil ⇒ remove that pod's token.
    func setSessionToken(_ token: String?, forPodId podId: String) async
    /// The pod ids (FQDNs) that currently have a stored per-pod token.
    func podTokenIds() async -> [String]
    /// Best-effort one-time migration: if a legacy single `sessionToken` exists
    /// but `anchorPodId` has no per-pod token yet, attribute the legacy token to
    /// it. Idempotent — a no-op once the pod has a token or there's no legacy one.
    func migrateSingleTokenToPod(_ anchorPodId: String) async

    var demoSession: DemoSessionRecord? { get }
    func setDemoSession(_ session: DemoSessionRecord?) async
}

public extension SessionStoring {
    /// Activate `podId`: point the single base-URL + token slots at it from the
    /// per-pod store. nil ⇒ clear both (no current pod / sign-out). A pod with
    /// no stored token activates with a nil token (the BFF then 401s →
    /// `noSessionToken` → the "pair this device" affordance), never borrowing
    /// another pod's token.
    func activatePod(_ podId: String?, baseUrl: String?) async {
        await setPodBaseUrl(baseUrl)
        if let podId, !podId.isEmpty {
            await setSessionToken(await sessionToken(forPodId: podId))
        } else {
            await setSessionToken(nil)
        }
    }
}

extension SessionStore: SessionStoring {}
extension KeychainSessionStore: SessionStoring {}
