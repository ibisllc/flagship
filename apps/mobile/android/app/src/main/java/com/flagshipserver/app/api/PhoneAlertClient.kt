// #91 — drains the daemon→phone alert outbox over the paired-session pipe
// (`GET /api/phone/alerts` + `POST /api/phone/alerts/ack`). Same auth as the
// screens client (the 32-byte hex session token in `x-flagship-session`); the
// box terminates TLS, so flagshipserver.com never sees these.
//
// Kotlin mirror of apps/mobile/shared/.../FlagshipAPI/Client/PhoneAlertClient.swift.

package com.flagshipserver.app.api

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext

interface PhoneAlertClient {
    /** Fetch alerts queued after [since] (the last-seen id; 0 = from the start). */
    suspend fun fetchAlerts(since: Int): PhoneAlertsResponse
    /** Acknowledge / drop alerts through [throughId] so they aren't re-delivered. */
    suspend fun ackAlerts(throughId: Int)
}

/** OkHttp-backed [PhoneAlertClient], mirroring [LiveScreensClient]'s request
 *  shape (and reusing its [SessionStoring] + the same OkHttp client, which the
 *  app builds with the box cert-pinning interceptor). */
class LivePhoneAlertClient(
    private val client: OkHttpClient = OkHttpClient(),
    private val store: SessionStoring,
) : PhoneAlertClient {

    private val jsonMt = "application/json; charset=utf-8".toMediaType()

    private suspend fun base(): String = store.podBaseUrl.first()?.trimEnd('/')
        ?: throw ScreensError.NotPaired

    private suspend fun token(): String = store.sessionToken.first()
        ?: throw ScreensError.NoSessionToken

    override suspend fun fetchAlerts(since: Int): PhoneAlertsResponse {
        val body = get("/api/phone/alerts?since=$since")
        return PhoneAlertsResponse.parse(body)
    }

    override suspend fun ackAlerts(throughId: Int) {
        post("/api/phone/alerts/ack", "{\"throughId\":$throughId}")
    }

    private suspend fun get(path: String): String {
        val req = Request.Builder()
            .url(base() + path)
            .header("x-flagship-session", token())
            .get()
            .build()
        return execute(req)
    }

    private suspend fun post(path: String, jsonBody: String): String {
        val req = Request.Builder()
            .url(base() + path)
            .header("x-flagship-session", token())
            .header("content-type", jsonMt.toString())
            .post(jsonBody.toRequestBody(jsonMt))
            .build()
        return execute(req)
    }

    private suspend fun execute(req: Request): String {
        val (status, bytes) = withContext(Dispatchers.IO) {
            client.newCall(req).execute().use { resp ->
                resp.code to (resp.body?.bytes() ?: ByteArray(0))
            }
        }
        if (status !in 200..299) throw ScreensError.Http(status, String(bytes, Charsets.UTF_8))
        return String(bytes, Charsets.UTF_8)
    }
}
