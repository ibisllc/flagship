// Kotlin mirror of FlagshipAPI/Client/ScreensClient.swift.
//
// All paired-session-gated endpoints on the user's pod
// (`<server>.<user>.flagship.services`). Two implementations:
//   - MockScreensClient — in-memory fixtures, used in tests + previews
//   - LiveScreensClient — OkHttp + `x-flagship-session` header (stub)
//
// MIRRORS: packages/server-daemon/src/screens/screensHttp.ts
// When the contract changes, update both this file AND
// apps/mobile/ios/Sources/FlagshipAPI/Client/ScreensClient.swift in
// the same commit.

package com.flagshipserver.app.api

import kotlinx.coroutines.flow.Flow

interface ScreensClient {
    // P1.1 server-detail
    suspend fun serverDetail(): ServerDetailResponse

    // P1.2 apps-list
    suspend fun appsList(): AppsListResponse

    // P1.3 app-detail
    suspend fun appDetail(serviceId: String): AppDetailResponse

    // P1.5 vibe-code/start
    suspend fun vibeCodeStart(req: VibeCodeStartRequest): VibeCodeStartResponse

    // P1.7 vibe-code/:id
    suspend fun vibeCodeStatus(sessionId: String): VibeCodeStatusResponse

    // P1.10 browser-tabs/list/:serviceId
    suspend fun browserTabsList(serviceId: String): BrowserTabsListResponse

    // P1.12 paired-sessions/list
    suspend fun pairedSessionsList(): PairedSessionsListResponse

    // P1.13 paired-sessions/:tokenPrefix
    suspend fun revokePairedSession(tokenPrefix: String)

    // P1.14 orders/send
    suspend fun ordersSend(req: OrdersSendRequest): OrdersSendResponse

    // P1.17 url-controller/owned
    suspend fun urlControllerOwned(): UrlControllerOwnedResponse

    // P1.18 url-controller/claim
    suspend fun urlControllerClaim(req: UrlControllerClaimRequest): UrlControllerClaimResponse

    // P1.19 app-backup/start
    suspend fun appBackupStart(req: AppBackupStartRequest): AppBackupStartResponse

    // P1.21 server-metrics (extension)
    suspend fun serverMetrics(podId: String): ServerMetricsResponse

    // P1.22 custom-domain verify (extension)
    suspend fun verifyCustomDomain(req: VerifyCustomDomainRequest): VerifyCustomDomainResponse

    // P1.23 post-recovery status — daemon's J.3/J.4 reattach snapshot
    suspend fun postRecoveryStatus(): PostRecoveryStatusResponse

    // W10 — per-app env-var KV editor. Values flow ONLY through /set;
    // /list returns names only; /unset removes a name.
    suspend fun serviceEnvList(appId: String): ServiceEnvListResponse
    suspend fun serviceEnvSet(appId: String, req: ServiceEnvSetRequest): ServiceEnvOpResponse
    suspend fun serviceEnvUnset(appId: String, req: ServiceEnvUnsetRequest): ServiceEnvOpResponse

    // W10 — vibe-code session public state + reply.
    suspend fun vibeCodeSessionState(sessionId: String): VibeCodeSessionPublicState
    suspend fun vibeCodeSessionReply(sessionId: String, req: VibeCodeReplyRequest): VibeCodeReplyResponse

    /** Deploy a `ready-to-deploy` scratch (vibe-code) session: builds the
     *  emitted manifest + files into a container and installs it on the box.
     *  Hits the daemon's legacy `POST /api/llm/sessions/<id>/deploy` — the only
     *  deploy trigger for scratch sessions (the WS stream is a pure relay and
     *  never auto-deploys). Returns `{ok, serviceId, url}` (same shape as the
     *  build-modes deploy). Mirror of iOS ScreensClient.vibeCodeDeploy. */
    suspend fun vibeCodeDeploy(sessionId: String): BuildDeployResponse

    // P9 — peer-backup management.
    suspend fun peerBackupStatus(): PeerBackupStatusResponse
    suspend fun peerBackupToggle(participate: Boolean): PeerBackupStatusResponse

    // P6 — collaborator-invite management. Issue mints a bearer invite +
    // returns the share secret + TTL; list / access enumerate the active
    // server-side state; revoke soft-deletes a pending invite OR an
    // active access row (discriminated by `scope`).
    suspend fun appInviteIssue(req: AppInviteIssueRequest): AppInviteIssueResponse
    suspend fun appInviteList(serviceId: String): AppInviteListResponse
    suspend fun appInviteAccess(serviceId: String): AppInviteAccessResponse
    suspend fun appInviteRevoke(req: AppInviteRevokeRequest): AppInviteRevokeResponse

    // P14 — companion-dock (60s pairing ticket → 4h read-only browser).
    suspend fun companionMintTicket(req: CompanionMintTicketRequest): CompanionMintTicketResponse
    suspend fun companionApproveDock(req: CompanionDockApproveRequest): CompanionDockApproveResponse
    suspend fun companionList(): CompanionListResponse
    suspend fun companionRevoke(req: CompanionRevokeRequest): CompanionRevokeResponse

    // P14 Phase 2 — owner-side companion write-relay queue. List the
    // pending unsigned write-requests companions have forwarded; record
    // an outcome once the owner signs + dispatches (or refuses).
    suspend fun companionPendingWrites(): CompanionPendingWritesResponse
    suspend fun companionResolvePending(req: CompanionResolvePendingRequest): CompanionResolvePendingResponse

    // P1.15 install-events SSE — streams provisioning progress
    fun installEvents(serial: String): Flow<InstallEvent>

    // P1.6 vibe-code stream — token/build-log/deploy events
    fun vibeCodeStream(sessionId: String): Flow<VibeCodeFrame>

    // P8 browser-tab framebuffer stream — opens a WS to
    // `/api/screens/browser-tabs/:tabId/stream` and returns a
    // bidirectional handle.
    fun browserTabStream(tabId: String): BrowserStream
}

sealed class ScreensError(message: String) : Throwable(message) {
    object NotPaired : ScreensError("Not paired to a server yet.")
    object NoSessionToken : ScreensError("No session token; re-pair.")
    data class Http(val status: Int, val body: String) :
        ScreensError("HTTP $status: $body"),
        com.flagshipserver.app.core.HasHttpStatus {
        override val httpStatus: Int get() = status
    }
    data class Decoding(val reason: String) : ScreensError("Could not parse response: $reason")
    data class NotImplemented(val feature: String) : ScreensError("Not implemented yet: $feature")
}

/**
 * Plain-language copy for a thrown error, mirroring iOS `ScreensClientError.userFacing`.
 * A typed [ScreensError] already carries user-safe wording; anything else (raw
 * network/IO exceptions, JSON parse throwables) must NOT reach the UI verbatim —
 * a user should never see "noSessionToken" or a stack message. Surfaces that show
 * an error to the user route it through this instead of a raw `t.message`.
 */
fun Throwable.userFacing(): String = when (this) {
    is ScreensError -> message ?: "Something went wrong. Try again."
    else -> "Couldn't reach the server. Check your connection and try again."
}
