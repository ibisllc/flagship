// The phone endpoint served on the bare `<account>.<apex>` name (docs/architecture-v2/phone-route.md
// section 4): TLS ends here, on the phone, with its own key (SSLEngine per relayed stream), then a
// minimal HTTP/1.1 server answers: the signed hello, `.well-known/flagship-phone`, and voi.ci's `live` and
// `deliver` (docs/voici-and-messages.md §8.2), the only operations a website can reach, from the listed origins only.

package com.flagshipserver.app.phoneroute

import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLEngineResult
import javax.net.ssl.SSLException

/** One relayed visitor stream, TLS-terminated with SSLEngine. Bytes from the relay go in `feed`; plaintext comes out. */
class TlsServerStream(
    private val engine: SSLEngine,
    private val toNetwork: (ByteArray) -> Unit,
    private val onPlain: (ByteArray) -> Unit,
    private val onClosed: () -> Unit,
) {
    private var netIn: ByteBuffer = ByteBuffer.allocate(engine.session.packetBufferSize)
    private var appIn: ByteBuffer = ByteBuffer.allocate(engine.session.applicationBufferSize)
    private var done = false

    init {
        engine.useClientMode = false
    }

    @Synchronized
    fun feed(bytes: ByteArray) {
        if (done) return
        if (netIn.remaining() < bytes.size) {
            val bigger = ByteBuffer.allocate(netIn.position() + bytes.size + engine.session.packetBufferSize)
            netIn.flip()
            bigger.put(netIn)
            netIn = bigger
        }
        netIn.put(bytes)
        netIn.flip()
        try {
            pump()
        } catch (_: SSLException) {
            finish()
        } finally {
            netIn.compact()
        }
    }

    @Synchronized
    fun write(plain: ByteArray) {
        if (done) return
        val src = ByteBuffer.wrap(plain)
        try {
            while (src.hasRemaining()) wrap(src)
        } catch (_: SSLException) {
            finish()
        }
    }

    /** Send close_notify and end the stream. */
    @Synchronized
    fun close() {
        if (done) return
        try {
            engine.closeOutbound()
            var guard = 0
            while (!engine.isOutboundDone && guard++ < 8) wrap(EMPTY)
        } catch (_: SSLException) {
        }
        finish()
    }

    private fun finish() {
        if (done) return
        done = true
        onClosed()
    }

    private fun pump() {
        var guard = 0
        while (!done && guard++ < 1_000) {
            when (engine.handshakeStatus) {
                SSLEngineResult.HandshakeStatus.NEED_TASK -> {
                    while (true) engine.delegatedTask?.run() ?: break
                    continue
                }
                SSLEngineResult.HandshakeStatus.NEED_WRAP -> {
                    wrap(EMPTY)
                    continue
                }
                else -> {}
            }
            if (!netIn.hasRemaining()) return
            val r = engine.unwrap(netIn, appIn)
            deliver()
            when (r.status) {
                SSLEngineResult.Status.BUFFER_UNDERFLOW -> return
                SSLEngineResult.Status.BUFFER_OVERFLOW -> appIn = grow(appIn, engine.session.applicationBufferSize)
                SSLEngineResult.Status.CLOSED -> {
                    close()
                    return
                }
                else -> if (r.bytesConsumed() == 0 && r.bytesProduced() == 0 && r.handshakeStatus == SSLEngineResult.HandshakeStatus.NEED_UNWRAP) return
            }
        }
    }

    private fun deliver() {
        if (appIn.position() == 0) return
        appIn.flip()
        val out = ByteArray(appIn.remaining())
        appIn.get(out)
        appIn.clear()
        onPlain(out)
    }

    private fun wrap(src: ByteBuffer) {
        var out = ByteBuffer.allocate(engine.session.packetBufferSize)
        while (true) {
            val r = engine.wrap(src, out)
            if (r.status == SSLEngineResult.Status.BUFFER_OVERFLOW) {
                out = grow(out, engine.session.packetBufferSize)
                continue
            }
            out.flip()
            if (out.hasRemaining()) {
                val bytes = ByteArray(out.remaining())
                out.get(bytes)
                toNetwork(bytes)
            }
            if (r.handshakeStatus == SSLEngineResult.HandshakeStatus.NEED_TASK) {
                while (true) engine.delegatedTask?.run() ?: break
            }
            return
        }
    }

    private fun grow(b: ByteBuffer, min: Int): ByteBuffer {
        val n = ByteBuffer.allocate(maxOf(b.capacity() * 2, min))
        b.flip()
        n.put(b)
        return n
    }

    private companion object {
        val EMPTY: ByteBuffer = ByteBuffer.allocate(0)
    }
}

/** A parsed HTTP/1.1 request head. */
data class HttpHead(val method: String, val path: String, val headers: Map<String, String>) {
    fun header(name: String): String? = headers[name.lowercase()]

    fun cookie(name: String): String? = header("cookie")?.split(';')?.map { it.trim() }?.firstNotNullOfOrNull {
        val i = it.indexOf('=')
        if (i > 0 && it.substring(0, i) == name) it.substring(i + 1) else null
    }

    companion object {
        fun parse(head: String): HttpHead? {
            val lines = head.split("\r\n")
            val parts = lines.firstOrNull()?.split(' ') ?: return null
            if (parts.size != 3 || !parts[2].startsWith("HTTP/1.")) return null
            val headers = HashMap<String, String>()
            for (l in lines.drop(1)) {
                if (l.isEmpty()) continue
                val i = l.indexOf(':')
                if (i <= 0) return null
                headers[l.substring(0, i).trim().lowercase()] = l.substring(i + 1).trim()
            }
            return HttpHead(parts[0], parts[1], headers)
        }
    }
}

/** The voi.ci operations the endpoint serves (docs/voici-and-messages.md §8.2); VoiciCenter in the app. */
interface PhoneWebHandler {
    /** `GET /api/phone/live`: the page's owner signing key, or null when this phone isn't receiving. */
    fun live(): com.flagshipserver.app.core.voici.PhoneLiveAnswer?
    /** `POST /api/phone/deliver`: (status, JSON body). */
    fun deliver(body: ByteArray, phoneRoutePub: String): Pair<Int, String>
}

/**
 * The endpoint's answers. Pure: the tunnel feeds it whole requests and writes back what it returns. The one-time
 * code browser session (`/api/phone/session`, `/api/phone/ping`, the `__Host-` cookie) is retired (voi.ci §8.2):
 * the only operations a website reaches are voi.ci's `live` and `deliver`, with CORS for the listed origins only, and
 * no cookie is read or set.
 */
class PhoneEndpoint(
    val account: String,
    val hostname: String,
    val phoneRoutePub: String,
    private val now: () -> Long = System::currentTimeMillis,
    private val web: PhoneWebHandler? = null,
    private val origins: List<String> = com.flagshipserver.app.core.voici.VoiciPhoneWeb.PHONE_WEB_ORIGINS,
) {
    private val seen = ConcurrentHashMap<String, Long>()
    private val inFlight = java.util.concurrent.atomic.AtomicInteger()

    /** Devices that said hello (signed presence) while this phone held the name: device key → last seen (ms).
     *  A hello proves only that its own key signed it, so only keys in the account's device book are returned. */
    fun lastSeen(accountDevices: Set<String>): Map<String, Long> = seen.filterKeys { it in accountDevices }

    @Volatile private var accountDevices: Set<String> = emptySet()

    /** The account's device keys (from `/device-grants`). Hellos are recorded only from these, so hellos signed by any
     *  other key cannot push real devices out of the list (security review 2026-11-02). */
    fun setAccountDevices(devices: Set<String>) {
        val book = devices.map { it.lowercase() }.toSet()
        accountDevices = book
        seen.keys.retainAll(book)
    }

    /** Record a signed hello (`GET /` with the presence headers): a device of the account, this account's bare name,
     *  fresh, signed by the key. */
    private fun hello(head: HttpHead): Boolean {
        val device = head.header("x-flagship-presence-device")?.lowercase() ?: return false
        if (device !in accountDevices) return false
        val at = head.header("x-flagship-presence-at")?.toLongOrNull() ?: return false
        val sig = head.header("x-flagship-presence-sig") ?: return false
        if (kotlin.math.abs(at - now()) > PhoneRoute.CLAIM_SKEW_MS) return false
        val bytes = runCatching { PhoneRoute.canonicalPresence(account, device, hostname, at) }.getOrNull() ?: return false
        if (!PhoneRoute.verify(bytes, sig, device)) return false
        if (seen.size >= 32 && !seen.containsKey(device)) seen.entries.minByOrNull { it.value }?.key?.let(seen::remove)
        seen[device] = now()
        return true
    }

    fun respond(head: HttpHead, body: ByteArray): ByteArray {
        val host = head.header("host")?.substringBefore(':') ?: ""
        val path = head.path.substringBefore('?')
        val verdict = com.flagshipserver.app.core.voici.VoiciPhoneWeb.phoneWebCheck(
            com.flagshipserver.app.core.voici.PhoneWebRequest(
                method = head.method, path = path, host = host, origin = head.header("origin"),
                contentType = head.header("content-type"),
                acrMethod = head.header("access-control-request-method"), acrHeaders = head.header("access-control-request-headers"),
            ),
            hostname, origins,
        )
        return when (verdict) {
            is com.flagshipserver.app.core.voici.PhoneWebVerdict.Refuse -> answer(verdict.status, """{"error":"refused","code":"${verdict.code}"}""")
            is com.flagshipserver.app.core.voici.PhoneWebVerdict.Preflight -> answer(204, "", verdict.headers)
            is com.flagshipserver.app.core.voici.PhoneWebVerdict.Allowed -> {
                val handler = web ?: return answer(404, """{"error":"not found","code":"not-found"}""", verdict.corsHeaders)
                if (verdict.kind == "live") {
                    val live = handler.live() ?: return answer(404, """{"error":"not found","code":"not-found"}""", verdict.corsHeaders)
                    answer(200, """{"live":true,"account":"${live.account}","ownerSignPub":"${live.ownerSignPub}"}""", verdict.corsHeaders)
                } else {
                    if (inFlight.incrementAndGet() > com.flagshipserver.app.core.voici.VoiciPhoneWeb.PHONE_DELIVER_MAX_CONCURRENT) {
                        inFlight.decrementAndGet()
                        return answer(429, """{"error":"busy","code":"rate-limited","retryAfterSec":5}""", verdict.corsHeaders)
                    }
                    try {
                        val (status, json) = handler.deliver(body, phoneRoutePub)
                        answer(status, json, verdict.corsHeaders)
                    } finally {
                        inFlight.decrementAndGet()
                    }
                }
            }
            com.flagshipserver.app.core.voici.PhoneWebVerdict.Other -> {
                val policy = PhoneEndpointPolicy.check(
                    PhoneEndpointRequest(
                        method = head.method, host = host, origin = head.header("origin"), sessionCookie = null, csrf = null,
                        upgrade = head.header("upgrade") != null, establish = false,
                    ),
                    hostname, null, null,
                )
                if (policy != "allow") return answer(403, """{"code":"$policy"}""")
                when {
                    head.method == "GET" && path == "/" -> answer(200, """{"present":true,"recorded":${hello(head)}}""")
                    head.method == "GET" && path == "/.well-known/flagship-phone" ->
                        answer(200, """{"account":"$account","hostname":"$hostname","phoneRoutePub":"$phoneRoutePub"}""")
                    else -> answer(404, """{"code":"not-found"}""")
                }
            }
        }
    }

    private fun answer(status: Int, json: String, cors: Map<String, String> = emptyMap()): ByteArray {
        val reason = when (status) {
            200 -> "OK"; 204 -> "No Content"; 400 -> "Bad Request"; 403 -> "Forbidden"; 404 -> "Not Found"; 405 -> "Method Not Allowed"
            409 -> "Conflict"; 413 -> "Payload Too Large"; 415 -> "Unsupported Media Type"; 421 -> "Misdirected Request"
            429 -> "Too Many Requests"; else -> "Error"
        }
        val body = json.toByteArray(Charsets.UTF_8)
        val head = StringBuilder("HTTP/1.1 $status $reason\r\n")
        if (status != 204) head.append("content-type: application/json\r\n")
        head.append("content-length: ${body.size}\r\n")
            .append("cache-control: no-store\r\n")
            .append("x-content-type-options: nosniff\r\n")
            .append("content-security-policy: default-src 'none'; frame-ancestors 'none'\r\n")
            .append("referrer-policy: no-referrer\r\n")
        for ((k, v) in cors) head.append(k.lowercase()).append(": ").append(v).append("\r\n")
        head.append("connection: close\r\n\r\n")
        return head.toString().toByteArray(Charsets.UTF_8) + body
    }
}

/** Collects one request (head and Content-Length body) from plaintext chunks. */
class HttpRequestReader(private val maxBytes: Int = MAX_REQUEST) {
    companion object {
        /** A voici-draft envelope may be 1 MiB (voi.ci §5.2); a message stays at 64 KiB (checked by the handler). */
        const val MAX_REQUEST = 1024 * 1024 + 16 * 1024
    }

    private var buf = ByteArray(0)

    /** The request once whole; null while more is needed. Throws when it grows past `maxBytes`. */
    fun push(chunk: ByteArray): Pair<HttpHead, ByteArray>? {
        buf += chunk
        require(buf.size <= maxBytes) { "request too large" }
        val text = String(buf, Charsets.ISO_8859_1)
        val end = text.indexOf("\r\n\r\n")
        if (end < 0) return null
        val head = HttpHead.parse(text.substring(0, end)) ?: throw IllegalArgumentException("bad request")
        val length = head.header("content-length")?.toIntOrNull() ?: 0
        require(length in 0..maxBytes) { "bad length" }
        if (buf.size < end + 4 + length) return null
        return head to buf.copyOfRange(end + 4, end + 4 + length)
    }
}
