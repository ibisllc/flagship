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
    func appDetail(appId: String) async throws -> AppDetailResponse

    // P1.4 marketplace-browse
    func marketplaceBrowse() async throws -> MarketplaceBrowseResponse

    // P1.5 vibe-code/start
    func vibeCodeStart(_ req: VibeCodeStartRequest) async throws -> VibeCodeStartResponse

    // P1.7 vibe-code/:id
    func vibeCodeStatus(sessionId: String) async throws -> VibeCodeStatusResponse

    // P1.8 unlock-approvals/pending
    func unlockApprovalsPending() async throws -> UnlockApprovalsPendingResponse

    // P1.9 unlock-approvals/:requestId/approve
    func approveUnlock(requestId: String, body: UnlockApprovalApproveRequest) async throws

    // P1.10 browser-tabs/list/:appId
    func browserTabsList(appId: String) async throws -> BrowserTabsListResponse

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
