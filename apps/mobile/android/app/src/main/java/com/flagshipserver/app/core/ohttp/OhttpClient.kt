// Sending one request through the private relays (OHTTP), with the owner's fallback rule: the Kotlin twin of
// sendThroughRelays in packages/protocol/src/ohttpClient.ts. Each relay is tried once, in order; a relay answer
// counts only when it is HTTP 200 `message/ohttp-res` that decrypts, and then the inner answer is final whatever
// its status (a 409 voucher-spent is never retried directly). When every relay failed (or none is set up), the
// caller decides whether the same request may go directly to `.com`, marked `x-flagship-relay-fallback: <reason>`.

package com.flagshipserver.app.core.ohttp

import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import java.io.InterruptedIOException
import java.net.URI

/** Every relay failed and the caller didn't allow a direct request. */
class RelayUnavailableException(val reason: String) : Exception("private relay unavailable ($reason)")

data class PrivateRequest(
    val url: String,
    val method: String = "POST",
    val headers: List<Pair<String, String>> = emptyList(),
    val body: ByteArray = ByteArray(0),
)

data class PrivateResponse(
    val status: Int,
    val headers: List<Pair<String, String>>,
    val body: ByteArray,
    /** "ohttp" or "direct". */
    val path: String,
    /** Why it went direct, when it did. */
    val fallbackReason: String? = null,
    /** The relay that carried it, when one did. */
    val relay: String? = null,
)

data class RawHttpResponse(val status: Int, val headers: Map<String, String>, val body: ByteArray) {
    fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
}

/** One plain HTTP exchange; throws on a network failure, returns any status. */
fun interface RawHttp {
    suspend fun send(method: String, url: String, headers: List<Pair<String, String>>, body: ByteArray?): RawHttpResponse
}

/** [RawHttp] over the app's transport (every status accepted, so the caller sees relay refusals as statuses). */
fun JsonHttpTransport.raw(): RawHttp = RawHttp { method, url, headers, body ->
    val contentType = headers.firstOrNull { it.first.equals("content-type", ignoreCase = true) }?.second
    val extra = headers.filterNot { it.first.equals("content-type", ignoreCase = true) }.toMap()
    val r = execute(method, url, body, contentType, extra, (100..599).toSet())
    RawHttpResponse(r.status, r.headers, r.body)
}

object OhttpClient {
    const val RELAY_FALLBACK_HEADER = "x-flagship-relay-fallback"
    const val TIMEOUT_MS = 15_000L

    private class RelayFailed(val reason: String) : Exception(reason)

    private suspend fun <T> timed(ms: Long, block: suspend () -> T): T = try {
        withTimeout(ms) { block() }
    } catch (e: TimeoutCancellationException) {
        throw RelayFailed("relay-timeout")
    }

    private suspend fun throughRelay(
        http: RawHttp,
        relayUrl: String,
        config: OhttpKeyConfig,
        req: PrivateRequest,
        timeoutMs: Long,
        ephemeralKey: ByteArray?,
    ): PrivateResponse {
        val u = URI(req.url)
        val path = (u.rawPath ?: "/").ifEmpty { "/" } + (u.rawQuery?.let { "?$it" } ?: "")
        val authority = if (u.port == -1) u.host else "${u.host}:${u.port}"
        val method = req.method.uppercase()
        val enc = Ohttp.encapsulateRequest(
            config,
            Ohttp.encodeBhttpRequest(BhttpRequest(method, "https", authority, path, req.headers, req.body)),
            ephemeralKey,
        )
        val res = try {
            timed(timeoutMs) { http.send("POST", relayUrl, listOf("content-type" to Ohttp.REQUEST_MEDIA_TYPE), enc.encapsulated) }
        } catch (e: RelayFailed) {
            throw e
        } catch (e: CancellationException) {
            throw e
        } catch (e: InterruptedIOException) {
            throw RelayFailed("relay-timeout")
        } catch (e: Exception) {
            throw RelayFailed("relay-unreachable")
        }
        if (res.status !in 200..299) throw RelayFailed("relay-${res.status}")
        val ct = res.header("content-type").orEmpty().substringBefore(';').trim().lowercase()
        if (ct != Ohttp.RESPONSE_MEDIA_TYPE) throw RelayFailed("relay-bad-response")
        val inner = try {
            Ohttp.decodeBhttpResponse(Ohttp.decapsulateResponse(enc.context, res.body))
        } catch (e: Exception) {
            throw RelayFailed("relay-bad-response")
        }
        return PrivateResponse(inner.status, inner.headers, inner.body, "ohttp", relay = relayUrl)
    }

    /**
     * Send [req] through the first relay that answers with an OHTTP response, else directly with
     * `x-flagship-relay-fallback: <reason>` when [mayGoDirect] allows, else throw [RelayUnavailableException].
     * With no relay set up (`unconfigured`) it always goes direct, without the marker.
     * [ephemeralKey] is a test seam.
     */
    suspend fun sendThroughRelays(
        http: RawHttp,
        req: PrivateRequest,
        keyConfig: OhttpKeyConfig?,
        relays: List<String>,
        mayGoDirect: (reason: String) -> Boolean,
        timeoutMs: Long = TIMEOUT_MS,
        ephemeralKey: ByteArray? = null,
    ): PrivateResponse {
        var reason = "unconfigured"
        if (keyConfig != null) {
            for (relay in relays) {
                try {
                    return throughRelay(http, relay, keyConfig, req, timeoutMs, ephemeralKey)
                } catch (e: RelayFailed) {
                    reason = e.reason
                }
            }
            if (relays.isEmpty()) reason = "unconfigured"
        }
        // With no relay set up the request simply goes direct, unmarked (`.com` counts the marker as a relay
        // failure); after a relay failure the caller's rule decides, and the request carries the reason.
        val unconfigured = reason == "unconfigured"
        if (!unconfigured && !mayGoDirect(reason)) throw RelayUnavailableException(reason)
        val method = req.method.uppercase()
        val r = http.send(
            method,
            req.url,
            if (unconfigured) req.headers else req.headers + (RELAY_FALLBACK_HEADER to reason),
            if (method == "GET" || method == "HEAD") null else req.body,
        )
        return PrivateResponse(r.status, r.headers.map { it.key to it.value }, r.body, "direct", fallbackReason = reason)
    }
}
