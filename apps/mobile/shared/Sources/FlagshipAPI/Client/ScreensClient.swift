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
    /// Endorsed releases the box verified for itself (GET /api/screens/updates).
    func serverUpdates(refresh: Bool) async throws -> ReleaseCatalogResponse

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
    func vibeCodeSessions() async throws -> VibeCodeSessionsResponse
    /// Is this name free for a new service? Boxes too old to answer say yes;
    /// they refuse a clash at deploy instead.
    func vibeCodeNameCheck(name: String) async throws -> VibeCodeNameCheck
    /// Stop a build session and delete it, its files and its AI key.
    func vibeCodeDiscard(sessionId: String) async throws
    func vibeCodeSessionReply(sessionId: String, _ req: VibeCodeReplyRequest) async throws -> VibeCodeReplyResponse
    /// Deploy a `ready-to-deploy` scratch (vibe-code) session: builds the
    /// emitted manifest + files into a container and installs it on the box.
    /// Hits the daemon's legacy `POST /api/llm/sessions/<id>/deploy` (the only
    /// deploy trigger for scratch sessions — the WS stream is a pure relay and
    /// never auto-deploys). Returns `{ok, serviceId, url}` (same shape as the
    /// build-modes deploy).
    func vibeCodeDeploy(sessionId: String) async throws -> BuildDeployResponse
    /// `POST /api/llm/sessions/<id>/deploy {background:true}`: a current box
    /// answers `{ok, started}` at once (follow `vibeCodeStatus`); an older one
    /// ignores `background` and answers when the app is live.
    func vibeCodeDeployStart(sessionId: String) async throws -> VibeCodeDeployReply
    /// The same, carrying the chat's current key (`credential`, with its relay
    /// setting) so the box's fix-up AI uses what the owner has now.
    func vibeCodeDeployStart(sessionId: String, credential: LlmProviderCredential?) async throws -> VibeCodeDeployReply
    /// `POST /api/screens/services/<id>/egress`: apply the owner's signed
    /// internet grant for a live app (`hosts: []` revokes).
    func serviceEgressSet(serviceId: String, _ req: AppEgressSetRequest) async throws -> AppEgressSetResponse

    // App access lists (docs/ai-privacy-and-staging.md §3a).
    /// The box these calls go to (its server FQDN): what a signed order for
    /// it must name as `serverDomain`. Nil when not known.
    func boxDomain() async -> String?
    /// `GET /api/screens/services/<id>/access`.
    func serviceAccess(serviceId: String) async throws -> AppAccessState
    /// `POST /api/screens/services/<id>/access`: the owner's signed list.
    func serviceAccessSet(serviceId: String, _ req: AppAccessSetRequest) async throws -> AppAccessSetResponse
    /// `POST /api/screens/services/<id>/access/dismiss {host}`: forget a
    /// request without changing the list. Returns the box's `access` (nil
    /// when it sends none).
    @discardableResult
    func serviceAccessDismiss(serviceId: String, host: String) async throws -> AppAccessState?
    /// `POST /api/screens/services/<id>/access/draft/dismiss`: discard the
    /// suggested list (no signature: a draft opens nothing). Returns the
    /// box's `access` (nil when it sends none).
    @discardableResult
    func serviceAccessDraftDismiss(serviceId: String) async throws -> AppAccessState?
    /// `GET /api/screens/access-requests`: every app's suggested lists and
    /// waiting hosts.
    func accessRequests() async throws -> AppAccessRequestsResponse
    /// `GET /api/screens/events` (WebSocket): one value per
    /// `{"type":"access-request"}` frame. Finishes when the socket closes.
    func accessRequestEvents() -> AsyncStream<Void>
    /// `GET /api/screens/settings/access-alerts`. An older box answers 404.
    func accessAlertsSetting() async throws -> AccessAlertsSetting
    /// `POST /api/screens/settings/access-alerts {enabled}` (owner session;
    /// no signature: it can only quiet the box).
    @discardableResult
    func setAccessAlerts(enabled: Bool) async throws -> AccessAlertsSetting

    // App API keys (docs/app-apis.md §3).
    /// `GET /api/screens/services/<id>/api-keys`. A box without API keys
    /// answers 404.
    func serviceApiKeys(serviceId: String) async throws -> AppApiKeysResponse
    /// `POST /api/screens/services/<id>/api-keys`: the owner's signed grant.
    /// The answer carries the full key, once.
    func serviceApiKeyCreate(serviceId: String, _ req: AppApiKeyCreateRequest) async throws -> AppApiKeyCreateResponse
    /// `DELETE /api/screens/services/<id>/api-keys/<keyId>` (owner session, no
    /// signature: it only removes access).
    func serviceApiKeyRevoke(serviceId: String, keyId: String) async throws

    // The owner's Database section (docs/app-apis.md §6). Owner sessions
    // only: companions get 403; a box without it answers 404.
    /// `GET /api/screens/services/<id>/db`: each Postgres store's tables.
    func serviceDb(serviceId: String) async throws -> AppDbStoresResponse
    /// `GET …/db/<store>/tables/<table>?offset&limit` (limit at most 1000).
    func serviceDbTableRows(serviceId: String, store: String, table: String,
                            offset: Int, limit: Int) async throws -> AppDbTableRows
    /// `GET …/db/<store>/tables/<table>/export.csv`: the whole table as CSV.
    func serviceDbExportCsv(serviceId: String, store: String, table: String) async throws -> Data
    /// `POST …/db/<store>/query`: read-only unsigned; with a signed
    /// `flagship/app-db-write/v1` order, read-write.
    func serviceDbQuery(serviceId: String, store: String, _ req: AppDbQueryRequest) async throws -> AppDbQueryResult

    // Access control — members' roles (docs/service-access-gating.md, "Open
    // mode + members"). Owner sessions only: companions get 403.
    /// `GET /api/screens/services/<id>/members`: the members, their grants and ranks.
    func appMembers(serviceId: String) async throws -> AppMembersResponse
    /// `POST …/members/role`: the owner's signed `flagship/app-member-role/v1` order.
    func setAppMemberRole(serviceId: String, _ req: AppMemberRoleRequest) async throws -> AppMemberRoleResponse

    // Copying an app between the owner's servers (docs/app-placement.md §5).
    /// `POST /api/screens/services/copy` to the TARGET box: the owner's signed
    /// `flagship/app-copy/v1` order. 202 `{copyId}`; an older box answers 404.
    func serviceCopy(_ req: AppCopyRequest) async throws -> AppCopyStartResponse
    /// `GET /api/screens/services/copies`: copies onto this box and how far
    /// each has got.
    func serviceCopies() async throws -> AppCopiesResponse

    // P9 — peer-backup management.
    func peerBackupStatus() async throws -> PeerBackupStatusResponse
    func peerBackupToggle(participate: Bool) async throws -> PeerBackupStatusResponse

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
    func companionApproveDock(_ req: CompanionDockApproveRequest) async throws -> CompanionDockApproveResponse
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
    /// `POST …/adapt {background:true}`: start the AI adapt, then poll `buildState`.
    func buildAdaptStart(buildId: String, _ req: BuildAdaptRequest) async throws -> BuildAdaptReply
    /// `GET /api/build/sessions/:id`: the build's state, with `adapt` progress.
    func buildState(buildId: String) async throws -> BuildStateResponse
    /// `POST …/discard`: forget an open git or IDE build, freeing its name.
    func buildDiscard(buildId: String) async throws
    /// `GET …/adapter`: the flagship.app.json that makes a git import's repo
    /// run the way this build does, for the repo's author to commit.
    func buildAdapterFile(buildId: String) async throws -> String
    /// `POST /api/screens/adapter-report/:serviceId {detail}`: tell the public
    /// store the adaptation this service was built from has a problem.
    func adapterReport(serviceId: String, detail: String) async throws
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
    /// The control server (`.com`) failed maintainer-trust verification and the
    /// owner has not granted an exception — every backend call is short-
    /// circuited until the blessing verifies or the owner overrides. Distinct
    /// from a network error (we never halt on the absence of a verdict).
    case controlServerUntrusted

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
        case .controlServerUntrusted:
            return "We can't currently verify the Flagship control server. Connecting "
                + "is paused until it checks out — or you can choose to continue anyway."
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
        if let e = error as? FreeAiError, let d = e.errorDescription { return d }
        return "Couldn't reach the server. Check your connection and try again."
    }

    /// The box's own explanation (`{"error": "…"}`) of a refused request, for
    /// the build flows whose refusals are written for the owner (a repo that
    /// won't clone, an invalid name, a failed deploy). Nil for anything else.
    public static func boxReason(_ error: Error) -> String? {
        guard case let ScreensClientError.http(status, message) = error, (400...599).contains(status),
              let obj = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any],
              let reason = obj["error"] as? String, !reason.isEmpty else { return nil }
        return reason
    }

    /// The build-a-service `/api/build/*` surface is mounted only when the box
    /// has its service platform wired. When it isn't, the ENTIRE prefix 404s —
    /// so a 404 on a build ENTRY call (git "Check repo", MCP create, the build
    /// list) unambiguously means "this box can't build services", not "that
    /// thing was removed". Surfaces should route those entry-call failures
    /// through here so the user sees the truth instead of the generic
    /// "couldn't find that" copy. Returns nil for anything but a 404 so the
    /// caller falls back to the normal plain-language mapping.
    public static func buildPlatformAbsent(_ error: Error) -> String? {
        if case let ScreensClientError.http(status, _) = error, status == 404 {
            return "This server isn't set up to build services yet. "
                + "Building services needs the services feature enabled on this box."
        }
        return nil
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

public extension ScreensClient {
    func serverUpdates(refresh: Bool) async throws -> ReleaseCatalogResponse {
        throw ScreensClientError.decoding("release list unavailable")
    }
    func vibeCodeSessions() async throws -> VibeCodeSessionsResponse {
        VibeCodeSessionsResponse(sessions: [])
    }
    func vibeCodeNameCheck(name: String) async throws -> VibeCodeNameCheck { .unknown }
    func vibeCodeDiscard(sessionId: String) async throws {
        throw ScreensClientError.notImplemented("discard")
    }
    /// Start the AI adapt without waiting for it. Default: the waiting call.
    func buildAdaptStart(buildId: String, _ req: BuildAdaptRequest) async throws -> BuildAdaptReply {
        let r = try await buildAdapt(buildId: buildId, req)
        return BuildAdaptReply(ok: r.ok, fileCount: r.fileCount)
    }
    func buildState(buildId: String) async throws -> BuildStateResponse {
        throw ScreensClientError.notImplemented("build state")
    }
    /// Default: the waiting deploy, reported as finished.
    func vibeCodeDeployStart(sessionId: String) async throws -> VibeCodeDeployReply {
        let r = try await vibeCodeDeploy(sessionId: sessionId)
        return VibeCodeDeployReply(ok: r.ok, serviceId: r.serviceId, url: r.url, inviteOnly: r.inviteOnly)
    }
    func serviceEgressSet(serviceId: String, _ req: AppEgressSetRequest) async throws -> AppEgressSetResponse {
        throw ScreensClientError.notImplemented("app internet access")
    }
    func vibeCodeDeployStart(sessionId: String, credential: LlmProviderCredential?) async throws -> VibeCodeDeployReply {
        try await vibeCodeDeployStart(sessionId: sessionId)
    }
    func boxDomain() async -> String? { nil }
    func serviceAccess(serviceId: String) async throws -> AppAccessState {
        throw ScreensClientError.notImplemented("app access list")
    }
    func serviceAccessSet(serviceId: String, _ req: AppAccessSetRequest) async throws -> AppAccessSetResponse {
        throw ScreensClientError.notImplemented("app access list")
    }
    func serviceAccessDismiss(serviceId: String, host: String) async throws -> AppAccessState? {
        throw ScreensClientError.notImplemented("app access list")
    }
    func serviceAccessDraftDismiss(serviceId: String) async throws -> AppAccessState? {
        throw ScreensClientError.notImplemented("app access list")
    }
    func accessRequests() async throws -> AppAccessRequestsResponse {
        throw ScreensClientError.notImplemented("app access requests")
    }
    func serviceDb(serviceId: String) async throws -> AppDbStoresResponse {
        throw ScreensClientError.notImplemented("app database")
    }
    func serviceDbTableRows(serviceId: String, store: String, table: String,
                            offset: Int, limit: Int) async throws -> AppDbTableRows {
        throw ScreensClientError.notImplemented("app database")
    }
    func serviceDbExportCsv(serviceId: String, store: String, table: String) async throws -> Data {
        throw ScreensClientError.notImplemented("app database")
    }
    func serviceDbQuery(serviceId: String, store: String, _ req: AppDbQueryRequest) async throws -> AppDbQueryResult {
        throw ScreensClientError.notImplemented("app database")
    }
    func appMembers(serviceId: String) async throws -> AppMembersResponse {
        throw ScreensClientError.notImplemented("app members")
    }
    func setAppMemberRole(serviceId: String, _ req: AppMemberRoleRequest) async throws -> AppMemberRoleResponse {
        throw ScreensClientError.notImplemented("app members")
    }
    func accessRequestEvents() -> AsyncStream<Void> {
        AsyncStream { $0.finish() }
    }
    func accessAlertsSetting() async throws -> AccessAlertsSetting {
        throw ScreensClientError.notImplemented("access alerts setting")
    }
    func setAccessAlerts(enabled: Bool) async throws -> AccessAlertsSetting {
        throw ScreensClientError.notImplemented("access alerts setting")
    }
    func serviceApiKeys(serviceId: String) async throws -> AppApiKeysResponse {
        throw ScreensClientError.notImplemented("app API keys")
    }
    func serviceApiKeyCreate(serviceId: String, _ req: AppApiKeyCreateRequest) async throws -> AppApiKeyCreateResponse {
        throw ScreensClientError.notImplemented("app API keys")
    }
    func serviceApiKeyRevoke(serviceId: String, keyId: String) async throws {
        throw ScreensClientError.notImplemented("app API keys")
    }
    func buildDiscard(buildId: String) async throws {
        throw ScreensClientError.notImplemented("discard")
    }
    func serviceCopy(_ req: AppCopyRequest) async throws -> AppCopyStartResponse {
        throw ScreensClientError.notImplemented("app copy")
    }
    func serviceCopies() async throws -> AppCopiesResponse {
        throw ScreensClientError.notImplemented("app copy")
    }
    func buildAdapterFile(buildId: String) async throws -> String {
        throw ScreensClientError.notImplemented("flagship.app.json")
    }
    func adapterReport(serviceId: String, detail: String) async throws {
        throw ScreensClientError.notImplemented("report")
    }
}
