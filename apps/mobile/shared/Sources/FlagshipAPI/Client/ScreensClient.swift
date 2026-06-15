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

    // P6 — collaborator-invite management. Issue mints a bearer invite +
    // returns the share secret + TTL; list / access enumerate the active
    // server-side state; revoke soft-deletes a pending invite OR an
    // active access row (discriminated by `scope`).
    func appInviteIssue(_ req: AppInviteIssueRequest) async throws -> AppInviteIssueResponse
    func appInviteList(serviceId: String) async throws -> AppInviteListResponse
    func appInviteAccess(serviceId: String) async throws -> AppInviteAccessResponse
    func appInviteRevoke(_ req: AppInviteRevokeRequest) async throws -> AppInviteRevokeResponse

    // P8 — browser-tab framebuffer stream. Opens a WS to
    // `/api/screens/browser-tabs/:tabId/stream` (with the session token
    // as a query param) and returns a bidirectional handle: incoming
    // frames flow through `incoming`, outgoing pointer / key events
    // ship through `send(_:)`.
    func browserTabStream(tabId: String) -> any BrowserStream

    // P14 — companion-dock. Phone mints a 60-second ticket → desktop
    // browser scans → 4-hour read-only companion session. iOS owns
    // mint / list / revoke; the browser hits a separate `/redeem`.
    func companionMintTicket(_ req: CompanionMintTicketRequest) async throws -> CompanionMintTicketResponse
    func companionList() async throws -> CompanionListResponse
    func companionRevoke(_ req: CompanionRevokeRequest) async throws -> CompanionRevokeResponse

    // P14 Phase 2 — owner-side companion write-relay queue. List the
    // pending unsigned write-requests companions have forwarded; record
    // an outcome once the owner signs + dispatches (or refuses).
    func companionPendingWrites() async throws -> CompanionPendingWritesResponse
    func companionResolvePending(_ req: CompanionResolvePendingRequest) async throws -> CompanionResolvePendingResponse

    // Build-a-service modes — the "how do you want to build it?" chooser
    // fans into git / mcp / journal; scratch reuses the vibe-code surface.
    // All paired-session gated; mirrors buildmodes/buildModesHttp.ts.

    /// git: clone a repo + report Flagship-fitness.
    /// `POST /api/build/git`
    func buildGit(_ req: BuildGitRequest) async throws -> BuildGitResponse
    /// git (non-fit): run the AI adapt pass. 503 → "AI adapt not
    /// configured" (caller falls back to scratch).
    /// `POST /api/build/sessions/:id/adapt`
    func buildAdapt(buildId: String, _ req: BuildAdaptRequest) async throws -> BuildAdaptResponse
    /// mcp: create the per-build IDE connection (URL + bearer key + config).
    /// `POST /api/build/mcp`
    func buildMcpCreate(_ req: BuildMcpRequest) async throws -> BuildMcpResponse
    /// mcp: re-display the existing connection.
    /// `GET /api/build/sessions/:id/mcp`
    func buildMcpInfo(buildId: String) async throws -> BuildMcpConnection
    /// mcp: regenerate the bearer key (invalidates the old one).
    /// `POST /api/build/sessions/:id/mcp/rotate`
    func buildMcpRotate(buildId: String, _ req: BuildMcpRequest) async throws -> BuildMcpConnection
    /// Value-free list of env vars an authoring agent asked the owner to
    /// set on the box. NEVER a value.
    /// `GET /api/build/sessions/:id/env-requests`
    func buildEnvRequests(buildId: String) async throws -> BuildEnvRequestsResponse
    /// Deploy the build artifact (mode-agnostic) → installed service.
    /// `POST /api/build/sessions/:id/deploy`
    func buildDeploy(buildId: String) async throws -> BuildDeployResponse
    /// The list of past builds across every mode (the journal index).
    /// `GET /api/build/sessions`
    func buildSessions() async throws -> BuildSessionsResponse
    /// One build's append-only timeline.
    /// `GET /api/build/sessions/:id/journal`
    func buildJournal(buildId: String) async throws -> BuildJournalResponse
}

public enum ScreensClientError: Error, LocalizedError, Sendable {
    case notPaired
    case noSessionToken
    case http(status: Int, message: String)
    case decoding(String)
    case notImplemented(String)
    /// UX-A — the box served a cert whose fingerprint doesn't match the pin
    /// the phone recorded for it (cert-model A′ hard-fail). Distinct from an
    /// ordinary network failure: it means an active interceptor, not bad
    /// signal. `host` is the box / service host that failed to pin.
    case certPinMismatch(host: String)

    /// A short, NON-technical sentence safe to show a normal person. Never
    /// leaks a raw status code or a server-supplied message string (UX-B).
    public var errorDescription: String? {
        switch self {
        case .notPaired:
            return "This device isn't connected to a server yet."
        case .noSessionToken:
            return "Your connection to this box expired. Reconnect and try again."
        case .http(let s, _):
            return Self.plainLanguage(forStatus: s)
        case .decoding:
            return "Something came back we couldn't read. Try again in a moment."
        case .notImplemented:
            return "That isn't available yet."
        case .certPinMismatch:
            return "This box's security certificate doesn't match what we expected — "
                + "someone may be intercepting the connection. Reinstall the box, or "
                + "contact whoever runs it before continuing."
        }
    }

    /// UX-A/UX-B — the one place every surface should route a caught error
    /// through to get a string safe to show a normal person: a
    /// `ScreensClientError` yields its plain-language `errorDescription`
    /// (incl. the cert-pin-mismatch warning); anything else (a raw URLSession
    /// transport error, a `CancellationError`, …) collapses to a single
    /// honest "couldn't reach the server" rather than leaking Apple's
    /// developer-facing `localizedDescription`.
    public static func userFacing(_ error: Error) -> String {
        if let e = error as? ScreensClientError, let d = e.errorDescription {
            return d
        }
        return "Couldn't reach the server. Check your connection and try again."
    }

    /// UX-B — map a raw HTTP status to plain language. Centralised here so no
    /// surface has to interpolate a bare code into a user-facing string.
    public static func plainLanguage(forStatus status: Int) -> String {
        switch status {
        case 0:
            // No HTTP response at all — transport-level failure.
            return "Couldn't reach the server. Check your connection and try again."
        case 401, 403:
            return "You're not signed in for that. Try signing in again."
        case 404:
            return "We couldn't find that. It may have moved or been removed."
        case 408, 429:
            return "The server is busy right now. Give it a moment and try again."
        case 500...599:
            return "Service temporarily unavailable. Try again in a few minutes."
        case 400...499:
            return "That didn't work. Check your connection and try again."
        default:
            return "Something went wrong. Try again in a moment."
        }
    }
}
