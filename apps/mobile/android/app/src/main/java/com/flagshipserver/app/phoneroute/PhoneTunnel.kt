// The phone's outbound tunnel to the relay (`/phone-tunnel`, docs/architecture-v2/phone-route.md
// section 2), held only while the app is in the foreground: it begins, signs the route claim the
// relay offers with the account device key, and serves each relayed visitor stream with TLS
// terminated here (TlsServerStream) and the minimal endpoint (PhoneEndpoint). It never re-acquires
// on its own after losing the route or a refusal: the next foreground does.

package com.flagshipserver.app.phoneroute

import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.nio.ByteBuffer
import java.util.Timer
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLContext
import kotlin.concurrent.fixedRateTimer

/** Tunnel-protocol v1 frames: u32 streamId, u8 type, u32 length, payload (big-endian). */
object TunnelFrames {
    const val OPEN = 0x01
    const val DATA = 0x02
    const val CLOSE = 0x03
    const val CLOSE_REMOTE = 0x04
    const val MAX_PAYLOAD = 1 shl 20

    data class Frame(val streamId: Int, val type: Int, val payload: ByteArray)

    fun encode(streamId: Int, type: Int, payload: ByteArray = ByteArray(0)): ByteArray {
        require(payload.size <= MAX_PAYLOAD)
        return ByteBuffer.allocate(9 + payload.size).putInt(streamId).put(type.toByte()).putInt(payload.size).put(payload).array()
    }

    /** Exactly one whole frame, or null. */
    fun decode(b: ByteArray): Frame? {
        if (b.size < 9) return null
        val bb = ByteBuffer.wrap(b)
        val id = bb.int
        val type = bb.get().toInt() and 0xff
        val len = bb.int
        if (len < 0 || len > MAX_PAYLOAD || b.size != 9 + len) return null
        return Frame(id, type, b.copyOfRange(9, 9 + len))
    }
}

sealed class PhoneTunnelState {
    data object Connecting : PhoneTunnelState()
    data object Claiming : PhoneTunnelState()
    data class Holding(val generation: Long) : PhoneTunnelState()
    data class Lost(val reason: String) : PhoneTunnelState()
    data class Refused(val code: String) : PhoneTunnelState()
    data class Closed(val code: Int) : PhoneTunnelState()
}

class PhoneTunnelClient(
    private val okHttp: OkHttpClient,
    private val url: String,
    private val account: String,
    private val apex: String,
    private val deviceKey: Ed25519Sign,
    private val deviceKeyPub: String,
    private val tls: SSLContext,
    private val endpoint: PhoneEndpoint,
    private val now: () -> Long = System::currentTimeMillis,
    private val onState: (PhoneTunnelState) -> Unit = {},
) {
    private class Stream(val tls: TlsServerStream, val reader: HttpRequestReader = HttpRequestReader())

    private val streams = ConcurrentHashMap<Int, Stream>()
    private val json = Json { ignoreUnknownKeys = true }
    @Volatile private var ws: WebSocket? = null
    @Volatile private var beat: Timer? = null
    private val hostname = PhoneRoute.hostname(account, apex)

    fun start() {
        onState(PhoneTunnelState.Connecting)
        ws = okHttp.newWebSocket(Request.Builder().url(url).build(), listener)
    }

    /** Leaving the foreground: give the route up and close. */
    fun stop() {
        beat?.cancel()
        beat = null
        ws?.let {
            it.send("""{"type":"release"}""")
            it.close(1000, "background")
        }
        ws = null
        for (s in streams.values) s.tls.close()
        streams.clear()
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            beat = fixedRateTimer("phone-tunnel-beat", daemon = true, initialDelay = PhoneRoute.BEAT_MS, period = PhoneRoute.BEAT_MS) {
                webSocket.send("""{"type":"beat"}""")
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val m = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
            handleControl(webSocket, m)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            handleFrame(webSocket, bytes.toByteArray())
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = closed(code)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = closed(-1)
    }

    private fun closed(code: Int) {
        beat?.cancel()
        beat = null
        for (s in streams.values) s.tls.close()
        streams.clear()
        onState(PhoneTunnelState.Closed(code))
    }

    private fun JsonObject.str(k: String) = this[k]?.jsonPrimitive?.content

    internal fun handleControl(socket: WebSocket, m: JsonObject) {
        when (m.str("type")) {
            "hello" -> {
                onState(PhoneTunnelState.Claiming)
                socket.send(buildJsonObject { put("type", "begin"); put("account", account) }.toString())
            }
            "challenge" -> {
                val claim = claimFor(m) ?: return onState(PhoneTunnelState.Refused("bad-challenge"))
                val sig = PhoneRoute.sign(PhoneRoute.canonical(claim), deviceKey)
                socket.send(buildJsonObject {
                    put("type", "claim")
                    put("claim", buildJsonObject {
                        put("account", claim.account)
                        put("phoneRoutePub", claim.phoneRoutePub)
                        put("hostname", claim.hostname)
                        put("generation", claim.generation)
                        put("sessionNonce", claim.sessionNonce)
                        put("issuedAt", claim.issuedAt)
                    })
                    put("signature", sig)
                }.toString())
            }
            "granted" -> onState(PhoneTunnelState.Holding(m["generation"]?.jsonPrimitive?.longOrNull ?: 0))
            "refused" -> onState(PhoneTunnelState.Refused(m.str("code") ?: "refused"))
            "lost" -> onState(PhoneTunnelState.Lost(m.str("reason") ?: "lost"))
        }
    }

    /** The claim for a challenge, only if it names exactly this account's bare name. */
    internal fun claimFor(m: JsonObject): RouteClaim? {
        if (m.str("account") != account || m.str("hostname") != hostname) return null
        val generation = m["generation"]?.jsonPrimitive?.longOrNull ?: return null
        val nonce = m.str("sessionNonce") ?: return null
        return runCatching {
            RouteClaim(account, deviceKeyPub, hostname, generation, nonce, now()).also { PhoneRoute.canonical(it) }
        }.getOrNull()
    }

    internal fun handleFrame(socket: WebSocket, bytes: ByteArray) {
        val f = TunnelFrames.decode(bytes) ?: return
        when (f.type) {
            TunnelFrames.OPEN -> {
                val sni = String(f.payload, Charsets.UTF_8)
                if (sni.lowercase() != hostname || streams.size >= 64) {
                    socket.send(TunnelFrames.encode(f.streamId, TunnelFrames.CLOSE).toByteString())
                    return
                }
                streams[f.streamId] = openStream(socket, f.streamId)
            }
            TunnelFrames.DATA -> streams[f.streamId]?.tls?.feed(f.payload)
            TunnelFrames.CLOSE, TunnelFrames.CLOSE_REMOTE -> streams.remove(f.streamId)?.tls?.close()
        }
    }

    private fun openStream(socket: WebSocket, id: Int): Stream {
        lateinit var stream: Stream
        val engine = tls.createSSLEngine().apply { useClientMode = false }
        val t = TlsServerStream(
            engine,
            toNetwork = { b -> socket.send(TunnelFrames.encode(id, TunnelFrames.DATA, b).toByteString()) },
            onPlain = { plain ->
                val req = runCatching { stream.reader.push(plain) }.getOrElse {
                    stream.tls.close()
                    null
                }
                if (req != null) {
                    stream.tls.write(endpoint.respond(req.first, req.second))
                    stream.tls.close()
                }
            },
            onClosed = {
                if (streams.remove(id) != null) socket.send(TunnelFrames.encode(id, TunnelFrames.CLOSE).toByteString())
            },
        )
        stream = Stream(t)
        return stream
    }

    companion object {
        /** `wss://…/tunnel` (what `.com`'s `/api/services/endpoints` names) → its `/phone-tunnel` twin. */
        fun phoneTunnelUrl(tunnelHub: String): String = tunnelHub.removeSuffix("/tunnel") + "/phone-tunnel"

        fun hex(b: ByteArray): String = HexUtil.encode(b)
    }
}
