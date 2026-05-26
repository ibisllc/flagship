import Foundation

/// Async protocol covering every `/api/screens/*` endpoint the iOS app
/// consumes. Concrete implementations:
///   - MockScreensClient — realistic in-memory fixtures, used in dev,
///     previews, and tests.
///   - LiveScreensClient — URLSession + x-flagship-session header, talks
///     to a real paired pod (`<server>.<user>.flagship.services`).
///
/// MIRRORS: packages/server-daemon/src/screens/screensHttp.ts
public protocol ScreensClient: Sendable {
    // P1.1 server-detail
    func serverDetail() async throws -> ServerDetailResponse

    // P1.2 apps-list
    func appsList() async throws -> AppsListResponse

    // P1.3 app-detail
    func appDetail(serviceId: String) async throws -> AppDetailResponse

    // P1.4 marketplace-browse
    func marketplaceBrowse() async throws -> MarketplaceBrowseResponse

    // P1.5 vibe-code/start
    func vibeCodeStart(_ req: VibeCodeStartRequest) async throws -> VibeCodeStartResponse

    // P1.7 vibe-code/:id
    func vibeCodeStatus(sessionId: String) async throws -> VibeCodeStatusResponse

    // P1.10 browser-tabs/list/:serviceId
    func browserTabsList(serviceId: String) async throws -> BrowserTabsListResponse

    // P1.12 paired-sessions/list
    func pairedSessionsList() async throws -> PairedSessionsListResponse

    // P1.13 paired-sessions/:tokenPrefix (DELETE)
    func revokePairedSession(tokenPrefix: String) async throws

    // P1.14 orders/send
    func ordersSend(_ req: OrdersSendRequest) async throws -> OrdersSendResponse

    // P1.16 tier-status
    func tierStatus() async throws -> TierStatusResponse

    // P1.17 url-controller/owned
    func urlControllerOwned() async throws -> UrlControllerOwnedResponse

    // P1.18 url-controller/claim
    func urlControllerClaim(_ req: UrlControllerClaimRequest) async throws -> UrlControllerClaimResponse

    // P1.19 app-backup/start
    func appBackupStart(_ req: AppBackupStartRequest) async throws -> AppBackupStartResponse

    // P1.21 server-metrics (extension; daemon side pending)
    func serverMetrics(podId: String) async throws -> ServerMetricsResponse

    // P1.15 install-events (SSE) — streams provisioning progress for a
    // freshly-minted build code as it boots, registers, gets a cert,
    // and goes ready. AsyncStream ends with the terminal event.
    func installEvents(serial: String) -> AsyncStream<InstallEvent>

    // P1.6 vibe-code stream — streams build progress (tokens, manifest
    // emit, repo create, deploy) for a vibe-code session.
    func vibeCodeStream(sessionId: String) -> AsyncStream<VibeCodeFrame>

    // P1.22 custom-domain verify (extension; daemon-side pending) —
    // ask the daemon to resolve the _flagship.<fqdn> TXT record and
    // confirm the user-claimed custom URL is pointing at us.
    func verifyCustomDomain(_ req: VerifyCustomDomainRequest) async throws -> VerifyCustomDomainResponse

    // P1.23 post-recovery status — snapshot of the J.3/J.4 reattach
    // walk so the phone's recovery confirmation screen can render
    // per-app re-anchoring counts + the undo deadline.
    func postRecoveryStatus() async throws -> PostRecoveryStatusResponse

    // W10 — per-app env-var KV editor. Values flow ONLY through /set;
    // /list returns names only; /unset removes a name.
    func serviceEnvList(appId: String) async throws -> ServiceEnvListResponse
    func serviceEnvSet(appId: String, _ req: ServiceEnvSetRequest) async throws -> ServiceEnvOpResponse
    func serviceEnvUnset(appId: String, _ req: ServiceEnvUnsetRequest) async throws -> ServiceEnvOpResponse

    // W10 — vibe-code session public state + reply. The chat surface
    // polls /sessions/<id>; the owner POSTs /reply when the AI is
    // awaiting a tool response (talkToUser or requestEnvVar ack).
    func vibeCodeSessionState(sessionId: String) async throws -> VibeCodeSessionPublicState
    func vibeCodeSessionReply(sessionId: String, _ req: VibeCodeReplyRequest) async throws -> VibeCodeReplyResponse

    // P9 — peer-backup management.
    func peerBackupStatus() async throws -> PeerBackupStatusResponse
    func peerBackupToggle(participate: Bool) async throws -> PeerBackupStatusResponse

    // P8 — browser-tab framebuffer stream. Opens a WS to
    // `/api/screens/browser-tabs/:tabId/stream` (with the session token
    // as a query param) and returns a bidirectional handle: incoming
    // frames flow through `incoming`, outgoing pointer / key events
    // ship through `send(_:)`.
    func browserTabStream(tabId: String) -> any BrowserStream
}

public enum ScreensClientError: Error, LocalizedError, Sendable {
    case notPaired
    case noSessionToken
    case http(status: Int, message: String)
    case decoding(String)
    case notImplemented(String)

    public var errorDescription: String? {
        switch self {
        case .notPaired: return "Not paired to a server yet."
        case .noSessionToken: return "No session token; re-pair."
        case .http(let s, let m): return "HTTP \(s): \(m)"
        case .decoding(let m): return "Could not parse response: \(m)"
        case .notImplemented(let f): return "Not implemented yet: \(f)"
        }
    }
}
