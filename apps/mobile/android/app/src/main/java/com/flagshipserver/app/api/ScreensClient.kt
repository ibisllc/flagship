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

    /** The finished archive at `fetchPath` (`/api/backups/<id>`). The box hands
     *  it out once and deletes it. */
    suspend fun appBackupFetch(fetchPath: String): ByteArray =
        throw ScreensError.NotImplemented("app backup download")

    // P1.21 server-metrics (extension)
    suspend fun serverMetrics(podId: String): ServerMetricsResponse

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

    /** `POST /api/screens/ai/models {credential}`: the model menu for this
     *  credential (the key is used for this one call). */
    suspend fun aiModels(credential: BuildCredential?): AiModelsResponse =
        throw ScreensError.NotImplemented("model menu")

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

    /** `POST /api/screens/services/:serviceId/access/draft/dismiss`: discard
     *  a suggested list (unsigned: a draft opens nothing). */
    suspend fun serviceAccessDraftDismiss(serviceId: String): Unit =
        throw ScreensError.NotImplemented("access list")

    /** `GET /api/screens/services/:serviceId/db` (docs/app-apis.md §6): each
     *  Postgres store's tables. Owner sessions only (a companion gets 403); a
     *  box without the Database section answers 404. */
    suspend fun serviceDb(serviceId: String): AppDbOverview =
        throw ScreensError.NotImplemented("database")

    /** `GET …/db/:store/tables/:table?offset&limit`: one page of rows. */
    suspend fun serviceDbTable(serviceId: String, store: String, table: String, offset: Int, limit: Int): AppDbRows =
        throw ScreensError.NotImplemented("database")

    /** `GET …/db/:store/tables/:table/export.csv`: the whole table as CSV. */
    suspend fun serviceDbExportCsv(serviceId: String, store: String, table: String): ByteArray =
        throw ScreensError.NotImplemented("database")

    /** `POST …/db/:store/query`: READ ONLY unless it carries a signed grant. */
    suspend fun serviceDbQuery(serviceId: String, store: String, req: AppDbQueryRequest): AppDbQueryResult =
        throw ScreensError.NotImplemented("database")

    /** `GET /api/screens/services/:serviceId/members` (Access control): the
     *  members, their grants and ranks. Owner sessions only (companions get 403). */
    suspend fun appMembers(serviceId: String): AppMembersResponse =
        throw ScreensError.NotImplemented("app members")

    /** `POST …/members/rank`: an admin's signed `flagship/app-rank/v1` order
     *  (409: a newer order won, sign again; 403: not an admin). */
    suspend fun setAppRank(serviceId: String, req: AppRankRequest): AppRankResponse =
        throw ScreensError.NotImplemented("app members")

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

    /** `POST /api/screens/server-order` (docs/server-order.md): the owner's
     *  signed order, the same wire posted to `.com`. 200 `{ok, adopted,
     *  heldIssuedAt}`; 422 when it doesn't verify; a box from before answers 404. */
    suspend fun deliverServerOrder(wire: com.flagshipserver.app.core.ServerOrderWire): ServerOrderDeliveryResponse =
        throw ScreensError.NotImplemented("server order")

    /** `POST /api/screens/debug-access` with `{grant, signatureHex}` (the JSON
     *  string from DebugAccess.envelopeJson). A refusal carries the box's
     *  sentence (`boxError()`); a box from before answers 404. */
    suspend fun debugAccessGrant(bodyJson: String): DebugAccessChangeResponse =
        throw ScreensError.NotImplemented("debug access")

    /** `POST /api/screens/debug-access/revoke` with `{revoke, signatureHex}`. */
    suspend fun debugAccessRevoke(bodyJson: String): DebugAccessChangeResponse =
        throw ScreensError.NotImplemented("debug access")

    /** `POST /api/screens/services/copy` (docs/app-placement.md §5), sent to
     *  the TARGET box with the owner's signed grant: 202 `{copyId}`; 400
     *  malformed, 403 bad signature / not this box / stale, 409 already there
     *  or already copying. A box from before copies answers 404. */
    suspend fun serviceCopy(req: AppCopyRequest): AppCopyResponse =
        throw ScreensError.NotImplemented("copies")

    // "Backup/clone server": the two files of a backup, the data file downloaded
    // in chunks; and the restore of one onto a server waiting for it.
    suspend fun serverArchiveStart(req: ServerArchiveStartRequest): Unit =
        throw ScreensError.NotImplemented("server backup")
    suspend fun serverArchiveStatus(): ServerArchiveStatus? =
        throw ScreensError.NotImplemented("server backup")
    /** ≤ 4 MiB of the ready backup's one `.flagship` file, from [offset]. */
    suspend fun serverArchiveBundleChunk(offset: Long): ByteArray =
        throw ScreensError.NotImplemented("server backup")
    suspend fun serverArchiveForget(): Unit =
        throw ScreensError.NotImplemented("server backup")
    /** The owner's signed approval for one browser download request. */
    suspend fun serverArchiveApprove(req: ServerArchiveApproveRequest): Unit =
        throw ScreensError.NotImplemented("server backup")
    suspend fun serverRestoreStart(req: ServerRestoreStartRequest): ServerRestoreStartResponse =
        throw ScreensError.NotImplemented("server import")
    suspend fun serverRestoreChunk(offset: Long, data: ByteArray): Unit =
        throw ScreensError.NotImplemented("server import")
    suspend fun serverRestoreCommit(req: ServerRestoreCommitRequest): Unit =
        throw ScreensError.NotImplemented("server import")
    suspend fun serverRestoreStatus(): ServerRestoreStatusResponse =
        throw ScreensError.NotImplemented("server import")

    // Saved backups (docs/server-backup-and-clone.md, "Scheduled backups"):
    // `/api/screens/server-archive/backups`, owner sessions only.
    suspend fun savedBackups(): SavedBackupsView =
        throw ScreensError.NotImplemented("saved backups")
    /** 400 `{error}` with the box's sentence when the schedule is refused. */
    suspend fun putBackupSchedule(schedule: BackupSchedule): SavedBackupsView =
        throw ScreensError.NotImplemented("saved backups")
    suspend fun depositBackupKeys(req: BackupKeysRequest): SavedBackupsView =
        throw ScreensError.NotImplemented("saved backups")
    /** 202 `{archiveId}`; 409 `code: no-keys` when the box has no keys, 409 when busy. */
    suspend fun runBackupNow(): BackupRunResponse =
        throw ScreensError.NotImplemented("saved backups")
    /** ≤ 4 MiB of a saved backup's one `.flagship` file, from [offset]. */
    suspend fun savedBackupBundleChunk(archiveId: String, offset: Long): ByteArray =
        throw ScreensError.NotImplemented("saved backups")
    suspend fun savedBackupLink(archiveId: String): SavedBackupLink =
        throw ScreensError.NotImplemented("saved backups")
    suspend fun deleteSavedBackup(archiveId: String): SavedBackupsView =
        throw ScreensError.NotImplemented("saved backups")

    // The backup policy and the size limit it puts on app data.
    suspend fun backupPolicy(): BackupPolicyView =
        throw ScreensError.NotImplemented("backup policy")
    /** 403 not an admin / another server, 409 `code: over-backup-limit` or a newer policy, all `{error}`. */
    suspend fun setBackupPolicy(req: BackupPolicyRequest): BackupPolicyView =
        throw ScreensError.NotImplemented("backup policy")

    /** What this box did, newest first (`before` is the `seq` cursor). */
    suspend fun boxActivity(limit: Int = 100, before: Int? = null): List<BoxActivityEntry> = emptyList()

    /** `GET /api/screens/services/copies`: the copies this box is receiving. */
    suspend fun serviceCopies(): AppCopiesResponse =
        throw ScreensError.NotImplemented("copies")

    /** `DELETE /api/services/:serviceId {request, signature}`: the owner-signed
     *  uninstall, verified by the box against its owner IRK. */
    suspend fun uninstallService(serviceId: String, body: UninstallServiceBody): Unit =
        throw ScreensError.NotImplemented("uninstall")

    // P9 — peer-backup management.
    suspend fun peerBackupStatus(): PeerBackupStatusResponse
    suspend fun peerBackupToggle(participate: Boolean): PeerBackupStatusResponse

    // P14 — companion-dock (60s pairing ticket → 4h read-only browser).
    suspend fun companionMintTicket(req: CompanionMintTicketRequest): CompanionMintTicketResponse
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
fun Throwable.userFacing(): String {
    com.flagshipserver.app.core.ErrorLog.caught(
        "box", this, com.flagshipserver.app.core.NetworkErrorHumanizer.errorCode(this),
    )
    return when (this) {
        is ScreensError -> message ?: "Something went wrong. Try again."
        is com.flagshipserver.app.core.RateLimitedException -> userMessage
        else -> "Couldn't reach the server. Check your connection and try again."
    }
}

/** The box's own `{error}` wording from a refused call, if it sent one. */
fun Throwable.boxError(): String? {
    if (this !is ScreensError.Http) return null
    val obj = runCatching { Json.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return null
    val err = obj["error"] as? JsonPrimitive ?: return null
    return err.content.takeIf { err.isString && it.isNotEmpty() }
}
