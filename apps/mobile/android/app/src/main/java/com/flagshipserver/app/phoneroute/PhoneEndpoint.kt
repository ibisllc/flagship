// The phone endpoint served on the bare `<account>.<apex>` name (docs/architecture-v2/phone-route.md
// section 4): TLS ends here, on the phone, with its own key (SSLEngine per relayed stream), then a
// minimal HTTP/1.1 server answers. Every state-changing request passes PhoneEndpointPolicy (exact
// Host and Origin, the host-only `__Host-` cookie, the CSRF header); no CORS headers are sent.

package com.flagshipserver.app.phoneroute

import com.flagshipserver.app.core.HexUtil
import java.nio.ByteBuffer
import java.security.SecureRandom
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

/** The endpoint's answers. Pure: the tunnel feeds it whole requests and writes back what it returns. */
class PhoneEndpoint(
    val account: String,
    val hostname: String,
    val phoneRoutePub: String,
    private val now: () -> Long = System::currentTimeMillis,
    private val random: SecureRandom = SecureRandom(),
) {
    private data class Code(val value: String, val expiresAt: Long)
    private data class Session(val csrf: String, val expiresAt: Long)

    @Volatile private var code: Code? = null
    private val sessions = ConcurrentHashMap<String, Session>()
    private val seen = ConcurrentHashMap<String, Long>()

    /** Devices that said hello (signed presence) while this phone held the name: device key → last seen (ms).
     *  A hello proves only that its own key signed it, so only keys in the account's device book are returned. */
    fun lastSeen(accountDevices: Set<String>): Map<String, Long> = seen.filterKeys { it in accountDevices }

    /** Record a signed hello (`GET /` with the presence headers): this account's bare name, fresh, signed by the key. */
    private fun hello(head: HttpHead): Boolean {
        val device = head.header("x-flagship-presence-device") ?: return false
        val at = head.header("x-flagship-presence-at")?.toLongOrNull() ?: return false
        val sig = head.header("x-flagship-presence-sig") ?: return false
        if (kotlin.math.abs(at - now()) > PhoneRoute.CLAIM_SKEW_MS) return false
        val bytes = runCatching { PhoneRoute.canonicalPresence(account, device, hostname, at) }.getOrNull() ?: return false
        if (!PhoneRoute.verify(bytes, sig, device)) return false
        if (seen.size >= 32 && !seen.containsKey(device)) seen.entries.minByOrNull { it.value }?.key?.let(seen::remove)
        seen[device] = now()
        return true
    }

    /** A fresh one-time code (6 digits, 5 minutes) for the owner to type in the browser that opens a session. */
    fun newCode(): String {
        val v = (random.nextInt(900_000) + 100_000).toString()
        code = Code(v, now() + 5 * 60_000)
        return v
    }

    fun respond(head: HttpHead, body: ByteArray): ByteArray {
        val host = head.header("host")?.substringBefore(':') ?: ""
        val establish = head.method == "POST" && head.path == "/api/phone/session"
        val token = head.cookie(PhoneRoute.SESSION_COOKIE)
        val session = token?.let { t -> sessions[t]?.takeIf { it.expiresAt > now() } }
        val verdict = PhoneEndpointPolicy.check(
            PhoneEndpointRequest(
                method = head.method,
                host = host,
                origin = head.header("origin"),
                sessionCookie = token,
                csrf = head.header(PhoneRoute.CSRF_HEADER),
                upgrade = head.header("upgrade") != null,
                establish = establish,
            ),
            hostname,
            if (session != null) token else null,
            session?.csrf,
        )
        if (verdict != "allow") return answer(403, """{"code":"$verdict"}""")
        return when {
            head.method == "GET" && head.path == "/" -> answer(200, """{"present":true,"recorded":${hello(head)}}""")
            head.method == "GET" && head.path == "/.well-known/flagship-phone" ->
                answer(200, """{"account":"$account","hostname":"$hostname","phoneRoutePub":"$phoneRoutePub"}""")
            establish -> {
                val typed = Regex("\"code\"\\s*:\\s*\"(\\d{6})\"").find(String(body, Charsets.UTF_8))?.groupValues?.get(1)
                val c = code
                if (typed == null || c == null || c.expiresAt <= now() || typed != c.value) return answer(403, """{"code":"bad-code"}""")
                code = null
                if (sessions.size >= 8) sessions.keys.firstOrNull()?.let(sessions::remove)
                val t = HexUtil.encode(ByteArray(32).also(random::nextBytes))
                val csrf = HexUtil.encode(ByteArray(32).also(random::nextBytes))
                sessions[t] = Session(csrf, now() + 3_600_000)
                answer(200, """{"csrf":"$csrf"}""", extra = "set-cookie: ${PhoneEndpointPolicy.sessionCookie(t)}\r\n")
            }
            head.method == "POST" && head.path == "/api/phone/ping" -> answer(200, """{"ok":true}""")
            else -> answer(404, """{"code":"not-found"}""")
        }
    }

    private fun answer(status: Int, json: String, extra: String = ""): ByteArray {
        val reason = when (status) { 200 -> "OK"; 403 -> "Forbidden"; else -> "Not Found" }
        val body = json.toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 $status $reason\r\n" +
            "content-type: application/json\r\n" +
            "content-length: ${body.size}\r\n" +
            "cache-control: no-store\r\n" +
            "x-content-type-options: nosniff\r\n" +
            "content-security-policy: default-src 'none'; frame-ancestors 'none'\r\n" +
            "referrer-policy: no-referrer\r\n" +
            extra +
            "connection: close\r\n\r\n"
        return head.toByteArray(Charsets.UTF_8) + body
    }
}

/** Collects one request (head and Content-Length body) from plaintext chunks. */
class HttpRequestReader(private val maxBytes: Int = 64 * 1024) {
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
