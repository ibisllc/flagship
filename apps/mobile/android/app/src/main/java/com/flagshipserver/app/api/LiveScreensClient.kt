// OkHttp-backed ScreensClient. Talks to a paired pod at
// `<server>.<user>.flagship.services` and signs every request with the
// 32-byte hex session token in the `x-flagship-session` header.
//
// MIRRORS: apps/mobile/ios/Sources/FlagshipAPI/Client/LiveScreensClient.swift
// Wire format mirrors apps/web/public/webapp/lib/api.js + the daemon
// contract in packages/server-daemon/src/screens/types.ts.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.HttpException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.KSerializer
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.BufferedSource
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

class LiveScreensClient(
    private val client: OkHttpClient = OkHttpClient(),
    private val store: SessionStoring,
    private val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
        // W10 — vibe-code pendingRequest + (legacy) VibeCodeFrame use
        // `kind` as the polymorphic discriminator; the daemon shapes
        // its JSON the same way. Default kotlinx-serialization uses
        // `type`, so we explicitly opt into `kind` here.
        classDiscriminator = "kind"
    },
) : ScreensClient {

    private val jsonMt = "application/json; charset=utf-8".toMediaType()

    private suspend fun base(): String = store.podBaseUrl.first()
        ?.trimEnd('/')
        ?: throw ScreensError.NotPaired

    private suspend fun token(): String = store.sessionToken.first()
        ?: throw ScreensError.NoSessionToken

    private val octetMt = "application/octet-stream".toMediaType()

    private suspend fun <R> request(
        path: String,
        deserializer: DeserializationStrategy<R>?,
        method: String = "GET",
        body: ByteArray? = null,
        readTimeoutSeconds: Long? = null,
        binaryBody: Boolean = false,
    ): R {
        val base = base()
        val token = token()
        val req = Request.Builder()
            .url(base + path)
            .header("x-flagship-session", token)
            .apply {
                if (body != null) {
                    val mt = if (binaryBody) octetMt else jsonMt
                    method(method, body.toRequestBody(mt))
                    header("content-type", mt.toString())
                } else {
                    method(method, null)
                }
            }
            .build()
        // Run the blocking call + body read on IO and RETURN to the caller's
        // dispatcher. The old enqueue()+suspendCoroutine resumed the
        // continuation on OkHttp's background thread, so anything the caller did
        // next on the main thread (nav.navigate / Lifecycle addObserver / a
        // Compose state write) threw "must be called on the main thread". With
        // withContext(IO) the suspend point returns on the caller's dispatcher
        // (Main, from a Compose scope.launch) — main-thread work after the call
        // is safe again.
        val (status, bytes) = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val c = readTimeoutSeconds?.let {
                client.newBuilder().readTimeout(it, java.util.concurrent.TimeUnit.SECONDS).build()
            } ?: client
            c.newCall(req).execute().use { resp ->
                resp.code to (resp.body?.bytes() ?: ByteArray(0))
            }
        }
        if (status !in 200..299) throw ScreensError.Http(status, String(bytes, Charsets.UTF_8))
        // Empty-body responses (DELETE / approve / etc) map to Unit.
        @Suppress("UNCHECKED_CAST")
        if (deserializer == null) return Unit as R
        return try {
            json.decodeFromString(deserializer, String(bytes, Charsets.UTF_8))
        } catch (t: Throwable) {
            throw ScreensError.Decoding(t.message ?: "decode failed")
        }
    }

    /** A GET whose body is not JSON (a CSV download). */
    private suspend fun requestBytes(path: String, readTimeoutSeconds: Long? = null): ByteArray {
        val req = Request.Builder()
            .url(base() + path)
            .header("x-flagship-session", token())
            .get()
            .build()
        val (status, bytes) = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val c = readTimeoutSeconds?.let {
                client.newBuilder().readTimeout(it, java.util.concurrent.TimeUnit.SECONDS).build()
            } ?: client
            c.newCall(req).execute().use { resp -> resp.code to (resp.body?.bytes() ?: ByteArray(0)) }
        }
        if (status !in 200..299) throw ScreensError.Http(status, String(bytes, Charsets.UTF_8))
        return bytes
    }

    /** The box's STK-signed LAN hint, or null (204: it has none to offer). */
    suspend fun lanHint(): com.flagshipserver.app.core.LanHint.Envelope? {
        val req = Request.Builder()
            .url(base() + "/api/screens/lan-hint")
            .header("x-flagship-session", token())
            .get()
            .build()
        val body = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            client.newCall(req).execute().use { resp -> if (resp.code == 200) resp.body?.string() else null }
        } ?: return null
        return json.decodeFromString(com.flagshipserver.app.core.LanHint.Envelope.serializer(), body)
    }

    override suspend fun serverDetail(): ServerDetailResponse =
        request("/api/screens/server-detail", ServerDetailResponse.serializer())

    override suspend fun serverUpdates(refresh: Boolean): ReleaseCatalogResponse =
        request(
            if (refresh) "/api/screens/updates?refresh=1" else "/api/screens/updates",
            ReleaseCatalogResponse.serializer(),
        )

    override suspend fun appsList(): AppsListResponse =
        request("/api/screens/apps-list", AppsListResponse.serializer())

    override suspend fun appDetail(serviceId: String): AppDetailResponse =
        request("/api/screens/app-detail/$serviceId", AppDetailResponse.serializer())

    override suspend fun vibeCodeStart(req: VibeCodeStartRequest): VibeCodeStartResponse {
        val body = json.encodeToString(VibeCodeStartRequest.serializer(), req).toByteArray()
        return request("/api/screens/vibe-code/start", VibeCodeStartResponse.serializer(), "POST", body)
    }

    override suspend fun vibeCodeStatus(sessionId: String): VibeCodeStatusResponse =
        request("/api/screens/vibe-code/$sessionId", VibeCodeStatusResponse.serializer())

    override suspend fun browserTabsList(serviceId: String): BrowserTabsListResponse =
        request("/api/screens/browser-tabs/list/$serviceId", BrowserTabsListResponse.serializer())

    override suspend fun pairedSessionsList(): PairedSessionsListResponse =
        request("/api/screens/paired-sessions/list", PairedSessionsListResponse.serializer())

    override suspend fun revokePairedSession(tokenPrefix: String) {
        request<Unit>("/api/screens/paired-sessions/$tokenPrefix", null, "DELETE")
    }

    override suspend fun ordersSend(req: OrdersSendRequest): OrdersSendResponse {
        val body = json.encodeToString(OrdersSendRequest.serializer(), req).toByteArray()
        return request("/api/screens/orders/send", OrdersSendResponse.serializer(), "POST", body)
    }

    override suspend fun urlControllerOwned(): UrlControllerOwnedResponse =
        request("/api/screens/url-controller/owned", UrlControllerOwnedResponse.serializer())

    override suspend fun urlControllerClaim(req: UrlControllerClaimRequest): UrlControllerClaimResponse {
        val body = json.encodeToString(UrlControllerClaimRequest.serializer(), req).toByteArray()
        return request("/api/screens/url-controller/claim", UrlControllerClaimResponse.serializer(), "POST", body)
    }

    override suspend fun appBackupStart(req: AppBackupStartRequest): AppBackupStartResponse {
        val body = json.encodeToString(AppBackupStartRequest.serializer(), req).toByteArray()
        return request("/api/screens/app-backup/start", AppBackupStartResponse.serializer(), "POST", body)
    }

    override suspend fun serverMetrics(podId: String): ServerMetricsResponse =
        request("/api/screens/server-metrics/$podId", ServerMetricsResponse.serializer())

    override suspend fun postRecoveryStatus(): PostRecoveryStatusResponse =
        request("/api/screens/post-recovery/status", PostRecoveryStatusResponse.serializer())

    override suspend fun serviceEnvList(appId: String): ServiceEnvListResponse =
        request("/api/screens/services/$appId/env", ServiceEnvListResponse.serializer())

    override suspend fun serviceEnvSet(appId: String, req: ServiceEnvSetRequest): ServiceEnvOpResponse {
        val body = json.encodeToString(ServiceEnvSetRequest.serializer(), req).toByteArray()
        return request("/api/screens/services/$appId/env/set", ServiceEnvOpResponse.serializer(), "POST", body)
    }

    override suspend fun serviceEnvUnset(appId: String, req: ServiceEnvUnsetRequest): ServiceEnvOpResponse {
        val body = json.encodeToString(ServiceEnvUnsetRequest.serializer(), req).toByteArray()
        return request("/api/screens/services/$appId/env/unset", ServiceEnvOpResponse.serializer(), "POST", body)
    }

    override suspend fun vibeCodeSessionState(sessionId: String): VibeCodeSessionPublicState =
        request("/api/screens/llm/sessions/$sessionId", VibeCodeSessionPublicState.serializer())

    override suspend fun aiModels(credential: BuildCredential?): AiModelsResponse {
        val body = json.encodeToString(AiModelsRequest.serializer(), AiModelsRequest(credential)).toByteArray()
        return request("/api/screens/ai/models", AiModelsResponse.serializer(), "POST", body)
    }

    override suspend fun vibeCodeSessionReply(sessionId: String, req: VibeCodeReplyRequest): VibeCodeReplyResponse {
        val body = json.encodeToString(VibeCodeReplyRequest.serializer(), req).toByteArray()
        return request("/api/screens/llm/sessions/$sessionId/reply", VibeCodeReplyResponse.serializer(), "POST", body)
    }

    override suspend fun vibeCodeDeploy(sessionId: String): BuildDeployResponse {
        // The scratch deploy trigger is the daemon's legacy
        // `/api/llm/sessions/<id>/deploy` (paired-session gated, same
        // `x-flagship-session` auth the `request` helper applies) — the screens
        // BFF has no deploy route, and the WS stream is a pure relay. The vibe
        // session registry is shared between the screens-BFF start and this
        // legacy handler, so a session started via /api/screens/vibe-code/start
        // is deployable here. The box answers only once `docker build` and the
        // install finish, which takes minutes, not the client's 60 s default.
        return request(
            "/api/llm/sessions/$sessionId/deploy", BuildDeployResponse.serializer(), "POST", "{}".toByteArray(),
            readTimeoutSeconds = 15 * 60,
        )
    }

    override suspend fun vibeCodeDeployStart(sessionId: String, credential: BuildCredential?): VibeCodeDeployReply =
        // A current box answers 202 at once; an older one ignores `background`
        // and answers when the install is done, hence the long read timeout.
        request(
            "/api/llm/sessions/$sessionId/deploy", VibeCodeDeployReply.serializer(), "POST",
            json.encodeToString(VibeCodeDeployBody.serializer(), VibeCodeDeployBody(true, credential)).toByteArray(),
            readTimeoutSeconds = 15 * 60,
        )

    @kotlinx.serialization.Serializable
    private data class VibeCodeDeployBody(val background: Boolean, val credential: BuildCredential? = null)

    private fun servicePath(serviceId: String): String =
        "/api/screens/services/${java.net.URLEncoder.encode(serviceId, "UTF-8")}"

    override suspend fun serviceAccess(serviceId: String): AppAccessState =
        request("${servicePath(serviceId)}/access", AppAccessState.serializer())

    override suspend fun serviceAccessSet(serviceId: String, req: AppAccessSetRequest): AppAccessSetResponse {
        val body = json.encodeToString(AppAccessSetRequest.serializer(), req).toByteArray()
        return request("${servicePath(serviceId)}/access", AppAccessSetResponse.serializer(), "POST", body)
    }

    override suspend fun serviceAccessDismiss(serviceId: String, host: String) {
        val body = json.encodeToString(AppAccessDismissRequest.serializer(), AppAccessDismissRequest(host)).toByteArray()
        request<Unit>("${servicePath(serviceId)}/access/dismiss", null, "POST", body)
    }

    override suspend fun serviceAccessDraftDismiss(serviceId: String) {
        request<Unit>("${servicePath(serviceId)}/access/draft/dismiss", null, "POST", "{}".toByteArray())
    }

    /** A path segment for a store or table name: percent-encoded, spaces as %20
     *  (the box decodes with decodeURIComponent, which keeps a `+`). */
    private fun segment(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    private fun dbPath(serviceId: String, store: String): String = "${servicePath(serviceId)}/db/${segment(store)}"

    override suspend fun serviceDb(serviceId: String): AppDbOverview =
        request("${servicePath(serviceId)}/db", AppDbOverview.serializer())

    override suspend fun serviceDbTable(serviceId: String, store: String, table: String, offset: Int, limit: Int): AppDbRows =
        request("${dbPath(serviceId, store)}/tables/${segment(table)}?offset=$offset&limit=$limit", AppDbRows.serializer())

    override suspend fun serviceDbExportCsv(serviceId: String, store: String, table: String): ByteArray =
        requestBytes("${dbPath(serviceId, store)}/tables/${segment(table)}/export.csv", readTimeoutSeconds = 120)

    override suspend fun serviceDbQuery(serviceId: String, store: String, req: AppDbQueryRequest): AppDbQueryResult {
        val body = json.encodeToString(AppDbQueryRequest.serializer(), req).toByteArray()
        return request("${dbPath(serviceId, store)}/query", AppDbQueryResult.serializer(), "POST", body, readTimeoutSeconds = 30)
    }

    override suspend fun appMembers(serviceId: String): AppMembersResponse =
        request("${servicePath(serviceId)}/members", AppMembersResponse.serializer())

    override suspend fun setAppMemberRole(serviceId: String, req: AppMemberRoleRequest): AppMemberRoleResponse {
        val body = json.encodeToString(AppMemberRoleRequest.serializer(), req).toByteArray()
        return request("${servicePath(serviceId)}/members/role", AppMemberRoleResponse.serializer(), "POST", body)
    }

    override suspend fun serviceApiKeys(serviceId: String): AppApiKeysResponse =
        request("${servicePath(serviceId)}/api-keys", AppApiKeysResponse.serializer())

    override suspend fun serviceApiKeyCreate(serviceId: String, req: AppApiKeyCreateRequest): AppApiKeyCreateResponse {
        val body = json.encodeToString(AppApiKeyCreateRequest.serializer(), req).toByteArray()
        return request("${servicePath(serviceId)}/api-keys", AppApiKeyCreateResponse.serializer(), "POST", body)
    }

    override suspend fun serviceApiKeyRevoke(serviceId: String, keyId: String) {
        request<Unit>(
            "${servicePath(serviceId)}/api-keys/${java.net.URLEncoder.encode(keyId, "UTF-8")}",
            null,
            "DELETE",
        )
    }

    override suspend fun accessRequests(): AccessRequestsResponse =
        request("/api/screens/access-requests", AccessRequestsResponse.serializer())

    override suspend fun accessAlerts(): AccessAlertsSetting =
        request("/api/screens/settings/access-alerts", AccessAlertsSetting.serializer())

    override suspend fun accessAlertsSet(enabled: Boolean): AccessAlertsSetting {
        val body = json.encodeToString(AccessAlertsBody.serializer(), AccessAlertsBody(enabled)).toByteArray()
        return request("/api/screens/settings/access-alerts", AccessAlertsSetting.serializer(), "POST", body)
    }

    @kotlinx.serialization.Serializable
    private data class AccessAlertsBody(val enabled: Boolean)

    override suspend fun serviceEgressSet(serviceId: String, req: AppEgressRequest): AppEgressResponse {
        val body = json.encodeToString(AppEgressRequest.serializer(), req).toByteArray()
        return request(
            "/api/screens/services/${java.net.URLEncoder.encode(serviceId, "UTF-8")}/egress",
            AppEgressResponse.serializer(), "POST", body,
        )
    }

    override suspend fun boxFqdn(): String? =
        store.podBaseUrl.first()?.toHttpUrlOrNull()?.host

    override suspend fun deliverServerOrder(wire: com.flagshipserver.app.core.ServerOrderWire): ServerOrderDeliveryResponse {
        val body = json.encodeToString(com.flagshipserver.app.core.ServerOrderWire.serializer(), wire).toByteArray()
        return request("/api/screens/server-order", ServerOrderDeliveryResponse.serializer(), "POST", body)
    }

    override suspend fun serviceCopy(req: AppCopyRequest): AppCopyResponse {
        val body = json.encodeToString(AppCopyRequest.serializer(), req).toByteArray()
        return request("/api/screens/services/copy", AppCopyResponse.serializer(), "POST", body)
    }

    override suspend fun serviceCopies(): AppCopiesResponse =
        request("/api/screens/services/copies", AppCopiesResponse.serializer())

    override suspend fun serverArchiveStart(req: ServerArchiveStartRequest) {
        val body = json.encodeToString(ServerArchiveStartRequest.serializer(), req).toByteArray()
        request<Unit>("/api/screens/server-archive/start", null, "POST", body, readTimeoutSeconds = 30)
    }

    override suspend fun serverArchiveStatus(): ServerArchiveStatus? =
        request("/api/screens/server-archive", ServerArchiveStatusResponse.serializer()).archive

    override suspend fun serverArchiveChunk(offset: Long): ByteArray =
        requestBytes("/api/screens/server-archive/chunk?offset=$offset", readTimeoutSeconds = 300)

    override suspend fun serverArchiveForget() {
        request<Unit>("/api/screens/server-archive", null, "DELETE", null, readTimeoutSeconds = 30)
    }

    override suspend fun serverRestoreStart(req: ServerRestoreStartRequest) {
        val body = json.encodeToString(ServerRestoreStartRequest.serializer(), req).toByteArray()
        request<Unit>("/api/screens/server-restore/start", null, "POST", body, readTimeoutSeconds = 30)
    }

    override suspend fun serverRestoreChunk(offset: Long, data: ByteArray) {
        request<Unit>("/api/screens/server-restore/chunk?offset=$offset", null, "POST", data, readTimeoutSeconds = 300, binaryBody = true)
    }

    override suspend fun serverRestoreCommit(req: ServerRestoreCommitRequest) {
        val body = json.encodeToString(ServerRestoreCommitRequest.serializer(), req).toByteArray()
        request<Unit>("/api/screens/server-restore/commit", null, "POST", body, readTimeoutSeconds = 60)
    }

    override suspend fun serverRestoreStatus(): ServerRestoreStatus? =
        request("/api/screens/server-restore", ServerRestoreStatusResponse.serializer()).restore

    override suspend fun boxActivity(limit: Int, before: Int?): List<BoxActivityEntry> {
        val q = if (before != null) "&before=$before" else ""
        return request("/api/screens/activity?limit=$limit$q", BoxActivityResponse.serializer()).entries
    }

    override suspend fun uninstallService(serviceId: String, body: UninstallServiceBody) {
        val bytes = json.encodeToString(UninstallServiceBody.serializer(), body).toByteArray()
        request<Unit>("/api/services/${segment(serviceId)}", null, "DELETE", bytes)
    }

    override suspend fun vibeCodeSessions(): VibeCodeSessionsResponse =
        request("/api/llm/sessions", VibeCodeSessionsResponse.serializer())

    override suspend fun vibeCodeNameCheck(name: String): VibeCodeNameCheck =
        try {
            request(
                "/api/screens/vibe-code/name-check?name=${java.net.URLEncoder.encode(name, "UTF-8")}",
                VibeCodeNameCheck.serializer(),
            )
        } catch (e: ScreensError.Http) {
            if (e.status == 404) VibeCodeNameCheck.Unknown else throw e
        }

    override suspend fun vibeCodeDiscard(sessionId: String) {
        request(
            "/api/llm/sessions/${java.net.URLEncoder.encode(sessionId, "UTF-8")}/discard",
            DiscardResponse.serializer(), "POST", "{}".toByteArray(),
        )
    }

    @kotlinx.serialization.Serializable
    private data class DiscardResponse(val ok: Boolean = false)

    override suspend fun adapterReport(serviceId: String, detail: String) {
        val body = json.encodeToString(AdapterReportRequest.serializer(), AdapterReportRequest(detail)).toByteArray()
        request(
            "/api/screens/adapter-report/${java.net.URLEncoder.encode(serviceId, "UTF-8")}",
            DiscardResponse.serializer(), "POST", body,
        )
    }

    @kotlinx.serialization.Serializable
    private data class AdapterReportRequest(val detail: String)

    override suspend fun peerBackupStatus(): PeerBackupStatusResponse =
        request("/api/screens/peer-backup/status", PeerBackupStatusResponse.serializer())

    override suspend fun peerBackupToggle(participate: Boolean): PeerBackupStatusResponse {
        val body = json.encodeToString(
            PeerBackupToggleRequest.serializer(),
            PeerBackupToggleRequest(participate = participate),
        ).toByteArray()
        return request("/api/screens/peer-backup/toggle", PeerBackupStatusResponse.serializer(), "POST", body)
    }

    override suspend fun companionMintTicket(req: CompanionMintTicketRequest): CompanionMintTicketResponse {
        val body = json.encodeToString(CompanionMintTicketRequest.serializer(), req).toByteArray()
        return request("/api/screens/companion/mint-ticket", CompanionMintTicketResponse.serializer(), "POST", body)
    }

    override suspend fun companionList(): CompanionListResponse =
        request("/api/screens/companion/list", CompanionListResponse.serializer())

    override suspend fun companionRevoke(req: CompanionRevokeRequest): CompanionRevokeResponse {
        val body = json.encodeToString(CompanionRevokeRequest.serializer(), req).toByteArray()
        return request("/api/screens/companion/revoke", CompanionRevokeResponse.serializer(), "POST", body)
    }

    override suspend fun companionPendingWrites(): CompanionPendingWritesResponse =
        request("/api/screens/companion/pending-writes", CompanionPendingWritesResponse.serializer())

    override suspend fun companionResolvePending(req: CompanionResolvePendingRequest): CompanionResolvePendingResponse {
        val body = json.encodeToString(CompanionResolvePendingRequest.serializer(), req).toByteArray()
        return request("/api/screens/companion/resolve-pending", CompanionResolvePendingResponse.serializer(), "POST", body)
    }

    /** SSE stream of install events. Frame format: `data: <json>\n\n` */
    override fun installEvents(serial: String): Flow<InstallEvent> = channelFlow {
        val base = base()
        val token = token()
        val req = Request.Builder()
            .url("$base/api/screens/install-events/$serial")
            .header("x-flagship-session", token)
            .header("accept", "text/event-stream")
            .build()
        val call = client.newCall(req)
        val response = try {
            suspendCoroutine<okhttp3.Response> { cont ->
                call.enqueue(object : okhttp3.Callback {
                    override fun onFailure(c: okhttp3.Call, e: IOException) { cont.resumeWithException(e) }
                    override fun onResponse(c: okhttp3.Call, r: okhttp3.Response) { cont.resume(r) }
                })
            }
        } catch (e: IOException) {
            close(); return@channelFlow
        }
        try {
            if (response.code !in 200..299) {
                close(ScreensError.Http(response.code, "install-events open failed"))
                return@channelFlow
            }
            val source: BufferedSource = response.body?.source() ?: run { close(); return@channelFlow }
            while (!source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                if (!line.startsWith("data:")) continue
                val payload = line.removePrefix("data:").trim()
                if (payload.isEmpty()) continue
                val event = try { json.decodeFromString(InstallEvent.serializer(), payload) }
                    catch (_: Throwable) { continue }
                send(event)
                if (event is InstallEvent.Ready || event is InstallEvent.Failed) break
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            // network error → silently close
        } finally {
            response.close()
            call.cancel()
        }
        awaitClose { call.cancel() }
    }

    /** WebSocket stream of vibe-code frames. */
    override fun vibeCodeStream(sessionId: String): Flow<VibeCodeFrame> = channelFlow {
        val base = base()
        val token = token()
        val wsUrl = base
            .replaceFirst("https://", "wss://")
            .replaceFirst("http://", "ws://") + "/api/screens/vibe-code/$sessionId/stream"
        val req = Request.Builder()
            .url(wsUrl)
            .header("x-flagship-session", token)
            .build()
        var ws: WebSocket? = null
        try {
            ws = client.newWebSocket(req, object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = try { json.decodeFromString(VibeCodeFrame.serializer(), text) }
                        catch (_: Throwable) { return }
                    val ok = trySend(frame).isSuccess
                    if (!ok || frame is VibeCodeFrame.Done || frame is VibeCodeFrame.Err) {
                        webSocket.close(1000, null)
                    }
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { close() }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) { close() }
            })
            awaitClose { ws?.close(1000, null) }
        } catch (_: Throwable) {
            ws?.close(1000, null)
            close()
        }
    }

    /** The box's event socket. The token rides the query (the box's contract)
     *  and the header (what the paired-session gate reads first). */
    override fun screensEvents(): Flow<ScreensEvent> = channelFlow {
        val base = base()
        val token = token()
        val wsUrl = base
            .replaceFirst("https://", "wss://")
            .replaceFirst("http://", "ws://") +
            "/api/screens/events?sessionToken=" + java.net.URLEncoder.encode(token, "UTF-8")
        val req = Request.Builder()
            .url(wsUrl)
            .header("x-flagship-session", token)
            .build()
        val ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val event = try { json.decodeFromString(ScreensEvent.serializer(), text) }
                    catch (_: Throwable) { return }
                trySend(event)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { close() }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) { close() }
        })
        awaitClose { ws.close(1000, null) }
    }

    override fun browserTabStream(tabId: String): BrowserStream =
        OkHttpBrowserStream(client = client, store = store, tabId = tabId)
}
