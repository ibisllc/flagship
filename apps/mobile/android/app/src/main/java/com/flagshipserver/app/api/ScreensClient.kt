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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

interface ScreensClient {
    // P1.1 server-detail
    suspend fun serverDetail(): ServerDetailResponse

    /** Endorsed releases the box verified for itself (GET /api/screens/updates). */
    suspend fun serverUpdates(refresh: Boolean): ReleaseCatalogResponse =
        throw ScreensError.NotImplemented("release list")

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

    /** `POST /api/llm/sessions/<id>/deploy {background:true}`: start the
     *  staged deploy and follow it on [vibeCodeStatus]. An older box ignores
     *  `background` and answers when it's live. Default: the waiting call. */
    /** [credential]: the owner's current AI key (relay setting included), so a
     *  retry after turning the relay off uses the new setting. */
    suspend fun vibeCodeDeployStart(sessionId: String, credential: BuildCredential? = null): VibeCodeDeployReply {
        val r = vibeCodeDeploy(sessionId)
        return VibeCodeDeployReply(ok = r.ok, serviceId = r.serviceId, url = r.url, inviteOnly = r.inviteOnly)
    }

    /** The daemon's live vibe-code sessions (legacy `GET /api/llm/sessions`,
     *  same paired-session auth as [vibeCodeDeploy]). */
    suspend fun vibeCodeSessions(): VibeCodeSessionsResponse = VibeCodeSessionsResponse()

    /** Is this name free for a new service? Boxes too old to answer say yes;
     *  they refuse a clash at deploy instead. */
    suspend fun vibeCodeNameCheck(name: String): VibeCodeNameCheck = VibeCodeNameCheck.Unknown

    /** Stop a build session and delete it, its files and its AI key, which
     *  frees its name. */
    suspend fun vibeCodeDiscard(sessionId: String): Unit =
        throw ScreensError.NotImplemented("discard")

    /** `POST /api/screens/adapter-report/:serviceId {detail}`: tell the public
     *  store the adaptation this service was built from has a problem. */
    suspend fun adapterReport(serviceId: String, detail: String): Unit =
        throw ScreensError.NotImplemented("report")

    /** `POST /api/screens/services/:serviceId/egress`: apply the owner's signed
     *  internet approval for a live app (`hosts: []` revokes). */
    suspend fun serviceEgressSet(serviceId: String, req: AppEgressRequest): AppEgressResponse =
        throw ScreensError.NotImplemented("internet approval")

    /** `GET /api/screens/services/:serviceId/access`: the app's access list
     *  and the hosts waiting for an answer (§3a). */
    suspend fun serviceAccess(serviceId: String): AppAccessState =
        throw ScreensError.NotImplemented("access list")

    /** `POST /api/screens/services/:serviceId/access`: apply the owner's
     *  signed list. */
    suspend fun serviceAccessSet(serviceId: String, req: AppAccessSetRequest): AppAccessSetResponse =
        throw ScreensError.NotImplemented("access list")

    /** `POST /api/screens/services/:serviceId/access/dismiss`: forget a
     *  pending request without changing the list (unsigned). */
    suspend fun serviceAccessDismiss(serviceId: String, host: String): Unit =
        throw ScreensError.NotImplemented("access list")

    /** `GET /api/screens/services/:serviceId/api-keys` (docs/app-apis.md §3).
     *  A box without API keys answers 404. */
    suspend fun serviceApiKeys(serviceId: String): AppApiKeysResponse =
        throw ScreensError.NotImplemented("API keys")

    /** `POST /api/screens/services/:serviceId/api-keys`: the owner's signed
     *  grant; the reply carries the full key, once. */
    suspend fun serviceApiKeyCreate(serviceId: String, req: AppApiKeyCreateRequest): AppApiKeyCreateResponse =
        throw ScreensError.NotImplemented("API keys")

    /** `DELETE /api/screens/services/:serviceId/api-keys/:keyId` (unsigned:
     *  it only removes access). */
    suspend fun serviceApiKeyRevoke(serviceId: String, keyId: String): Unit =
        throw ScreensError.NotImplemented("API keys")

    /** `GET /api/screens/access-requests`: every app's pending requests. */
    suspend fun accessRequests(): AccessRequestsResponse =
        throw ScreensError.NotImplemented("access requests")

    /** `GET /api/screens/settings/access-alerts`: whether this box pushes
     *  access requests. An older box answers 404. */
    suspend fun accessAlerts(): AccessAlertsSetting =
        throw ScreensError.NotImplemented("access alerts")

    /** `POST /api/screens/settings/access-alerts {enabled}` (unsigned: it can
     *  only reduce what the box sends). */
    suspend fun accessAlertsSet(enabled: Boolean): AccessAlertsSetting =
        throw ScreensError.NotImplemented("access alerts")

    /** `GET /api/screens/events` (WebSocket): the box's live events, e.g.
     *  `{"type":"access-request","serviceId":…}`. Ends when the socket closes;
     *  a box without the socket ends it at once. */
    fun screensEvents(): Flow<ScreensEvent> = kotlinx.coroutines.flow.emptyFlow()

    /** The FQDN of the box this client talks to, which a signed grant names. */
    suspend fun boxFqdn(): String? = null

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

/** The box's own `{error}` wording from a refused call, if it sent one. */
fun Throwable.boxError(): String? {
    if (this !is ScreensError.Http) return null
    val obj = runCatching { Json.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return null
    val err = obj["error"] as? JsonPrimitive ?: return null
    return err.content.takeIf { err.isString && it.isNotEmpty() }
}
