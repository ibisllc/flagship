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

    private suspend fun <R> request(
        path: String,
        deserializer: DeserializationStrategy<R>?,
        method: String = "GET",
        body: ByteArray? = null,
    ): R {
        val base = base()
        val token = token()
        val req = Request.Builder()
            .url(base + path)
            .header("x-flagship-session", token)
            .apply {
                if (body != null) {
                    method(method, body.toRequestBody(jsonMt))
                    header("content-type", jsonMt.toString())
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
            client.newCall(req).execute().use { resp ->
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

    override suspend fun serverDetail(): ServerDetailResponse =
        request("/api/screens/server-detail", ServerDetailResponse.serializer())

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

    override suspend fun verifyCustomDomain(req: VerifyCustomDomainRequest): VerifyCustomDomainResponse {
        val body = json.encodeToString(VerifyCustomDomainRequest.serializer(), req).toByteArray()
        return request("/api/screens/url-controller/verify", VerifyCustomDomainResponse.serializer(), "POST", body)
    }

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
        // is deployable here.
        return request("/api/llm/sessions/$sessionId/deploy", BuildDeployResponse.serializer(), "POST", "{}".toByteArray())
    }

    override suspend fun peerBackupStatus(): PeerBackupStatusResponse =
        request("/api/screens/peer-backup/status", PeerBackupStatusResponse.serializer())

    override suspend fun peerBackupToggle(participate: Boolean): PeerBackupStatusResponse {
        val body = json.encodeToString(
            PeerBackupToggleRequest.serializer(),
            PeerBackupToggleRequest(participate = participate),
        ).toByteArray()
        return request("/api/screens/peer-backup/toggle", PeerBackupStatusResponse.serializer(), "POST", body)
    }

    override suspend fun appInviteIssue(req: AppInviteIssueRequest): AppInviteIssueResponse {
        val body = json.encodeToString(AppInviteIssueRequest.serializer(), req).toByteArray()
        return request("/api/screens/app-invite/issue", AppInviteIssueResponse.serializer(), "POST", body)
    }

    override suspend fun appInviteList(serviceId: String): AppInviteListResponse =
        request("/api/screens/app-invite/list/$serviceId", AppInviteListResponse.serializer())

    override suspend fun appInviteAccess(serviceId: String): AppInviteAccessResponse =
        request("/api/screens/app-invite/access/$serviceId", AppInviteAccessResponse.serializer())

    override suspend fun appInviteRevoke(req: AppInviteRevokeRequest): AppInviteRevokeResponse {
        val body = json.encodeToString(AppInviteRevokeRequest.serializer(), req).toByteArray()
        return request("/api/screens/app-invite/revoke", AppInviteRevokeResponse.serializer(), "POST", body)
    }

    override suspend fun companionMintTicket(req: CompanionMintTicketRequest): CompanionMintTicketResponse {
        val body = json.encodeToString(CompanionMintTicketRequest.serializer(), req).toByteArray()
        return request("/api/screens/companion/mint-ticket", CompanionMintTicketResponse.serializer(), "POST", body)
    }

    override suspend fun companionApproveDock(req: CompanionDockApproveRequest): CompanionDockApproveResponse {
        val body = json.encodeToString(CompanionDockApproveRequest.serializer(), req).toByteArray()
        return request("/api/screens/companion/dock/approve", CompanionDockApproveResponse.serializer(), "POST", body)
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

    override fun browserTabStream(tabId: String): BrowserStream =
        OkHttpBrowserStream(client = client, store = store, tabId = tabId)
}
