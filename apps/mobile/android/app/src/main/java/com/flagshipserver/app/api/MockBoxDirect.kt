// The pod-direct clients (power, dead-man, journal, front page) talk straight
// to `https://<server>`, outside the screens session. Smoke mode swaps their
// transport for MockBoxDirect, an in-memory box that answers them, checks each
// sensitive order under the account's admin root the way the box does
// (MockSignatures) and records what it was sent, so the gym never reaches a
// real box with a made-up name.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.OkHttpJsonTransport
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json

/** Which transport the pod-direct clients use (OkHttp, or the gym's box). */
object PodDirect {
    @Volatile var transport: () -> JsonHttpTransport = { OkHttpJsonTransport() }
}

class MockBoxDirect : JsonHttpTransport {
    override val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    data class Call(val method: String, val path: String, val body: String)

    private val _calls = mutableListOf<Call>()
    val calls: List<Call> get() = synchronized(_calls) { _calls.toList() }

    /** The front page each box shows (null = Flagship's own). */
    private val frontPages = HashMap<String, String?>()

    private fun record(method: String, url: String, body: String) {
        synchronized(_calls) { _calls += Call(method, java.net.URI(url).rawPath, body) }
    }

    private fun admin(what: String, bytes: ByteArray, sig: String) {
        try {
            MockSignatures.requireAdmin(what, bytes, sig)
        } catch (e: ScreensError.Http) {
            throw HttpException(403, e.body)
        }
    }

    private fun answer(method: String, url: String, body: String): String {
        val uri = java.net.URI(url)
        val host = uri.host.orEmpty()
        return when (method to uri.rawPath) {
            "POST" to "/api/power" -> {
                val r = json.decodeFromString(PowerOffOrderRequest.serializer(), body)
                val mode = com.flagshipserver.app.core.PowerMode.fromWire(r.request.mode) ?: throw HttpException(400, "bad mode")
                admin("power", com.flagshipserver.app.core.PowerOffOrder.canonicalBytes(r.request.serverId, mode, r.request.issuedAt), r.signature)
                """{"ok":true,"mode":"${mode.wire}"}"""
            }
            "POST" to "/api/deadman/policy" -> {
                val r = json.decodeFromString(DeadManPolicyRequest.serializer(), body)
                val i = r.request
                val mode = com.flagshipserver.app.core.PowerMode.fromWire(i.lockoutMode) ?: throw HttpException(400, "bad mode")
                admin(
                    "deadman-policy",
                    com.flagshipserver.app.core.SetDeadManPolicy.canonicalBytes(i.serverId, i.enabled, i.windowMs, i.graceMs, mode, i.issuedAt),
                    r.signature,
                )
                """{"ok":true,"enabled":${i.enabled}}"""
            }
            "POST" to "/api/deadman/affirm" -> {
                val r = json.decodeFromString(DeadManAffirmRequest.serializer(), body)
                val nonce = com.flagshipserver.app.core.HexUtil.decode(r.request.nonce) ?: throw HttpException(400, "bad nonce")
                admin("deadman-affirm", com.flagshipserver.app.core.DeadManAffirmation.canonicalBytes(r.request.serverId, nonce, r.request.issuedAt), r.signature)
                """{"ok":true,"leaseExpiry":${System.currentTimeMillis() + 7L * 24 * 3600_000}}"""
            }
            "POST" to "/api/journal" -> {
                val r = json.decodeFromString(JournalRequestBody.serializer(), body)
                """{"ok":true,"unit":"${r.request.unit}","lines":["gym: ${r.request.unit} started","gym: ${r.request.unit} is healthy"]}"""
            }
            "GET" to "/api/front-page" -> {
                val label = frontPages[host]
                if (label == null) """{"active":false}""" else """{"label":"$label","active":true}"""
            }
            "GET" to "/api/services" -> """{"apps":[{"urlLabel":"plants","name":"Plants"},{"urlLabel":"wiki","name":"Wiki"}]}"""
            "POST" to "/api/front-page" -> {
                val r = json.decodeFromString(SetFrontPageRequest.serializer(), body)
                admin("front-page", com.flagshipserver.app.core.SetFrontPageOrder.canonicalBytes(r.request.serverId, r.request.label, r.request.issuedAt), r.signature)
                frontPages[host] = r.request.label.ifEmpty { null }
                """{"ok":true,"label":"${r.request.label}"}"""
            }
            else -> throw HttpException(404, """{"error":"not found"}""")
        }
    }

    override suspend fun execute(
        method: String,
        url: String,
        body: ByteArray?,
        contentType: String?,
        extraHeaders: Map<String, String>,
        accept: Set<Int>,
    ): HttpResponse {
        val text = body?.toString(Charsets.UTF_8).orEmpty()
        record(method, url, text)
        val out = answer(method, url, text)
        return HttpResponse(200, out.toByteArray(Charsets.UTF_8), emptyMap())
    }

    override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) {
        val text = json.encodeToString(serializer, body)
        record("POST", url, text)
        answer("POST", url, text)
    }

    override suspend fun <T, R> postJsonForResponse(
        url: String,
        body: T,
        serializer: KSerializer<T>,
        responseSerializer: KSerializer<R>,
        extraHeaders: Map<String, String>,
    ): R {
        val text = json.encodeToString(serializer, body)
        record("POST", url, text)
        return json.decodeFromString(responseSerializer, answer("POST", url, text))
    }

    override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R {
        record("GET", url, "")
        return json.decodeFromString(responseSerializer, answer("GET", url, ""))
    }

    override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) {
        record("DELETE", url, "")
        answer("DELETE", url, "")
    }
}
