// Live phone-to-phone pairing transport over the QrRelay v2 pipe.
//
// Wire-compatible with apps/web/public/webapp/lib/pairingRelay.js: the DO
// relays one phone-role frame per session, so the pairing runs on two legs.
//
//   leg 1 (sid from the QR): admin = browser, incoming = phone. The incoming
//     hellos with its ephemeral X25519 key, then spends its one deliver on
//     { devicePubHex, deviceId, returnSid, returnPkB64u } sealed under the
//     leg-1 key.
//   leg 2 (returnSid, minted by the incoming): incoming = browser (listening
//     before it talks on leg 1), admin = phone. The admin delivers the sealed
//     bundle, sealed under the SAME leg-1 key.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.X25519
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.URLEncoder
import java.security.SecureRandom

internal data class PairingFrame(
    val kind: String,
    val phonePk: String? = null,
    val ciphertext: String? = null,
    val nonce: String? = null,
    val reason: String? = null,
)

internal class PairingSocket(
    private val client: OkHttpClient,
    private val url: String,
) {
    private val frames = Channel<PairingFrame>(Channel.UNLIMITED)
    private val opened = CompletableDeferred<Unit>()
    private var ws: WebSocket? = null

    suspend fun open() {
        ws = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                opened.complete(Unit)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val obj = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
                val kind = obj.str("kind") ?: return
                frames.trySend(PairingFrame(kind, obj.str("phonePk"), obj.str("ciphertext"), obj.str("nonce"), obj.str("reason")))
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                frames.close()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val err: PairingRelayError =
                    if (response?.code == 410) PairingRelayError.SessionExpired
                    else PairingRelayError.ConnectionFailed(t.message ?: "websocket failure")
                opened.completeExceptionally(err)
                frames.close(err)
            }
        })
        opened.await()
    }

    fun send(build: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) {
        val sock = ws ?: throw PairingRelayError.ConnectionFailed("not open")
        if (!sock.send(buildJsonObject(build).toString())) {
            throw PairingRelayError.ConnectionFailed("the relay connection dropped")
        }
    }

    suspend fun next(): PairingFrame {
        val r = frames.receiveCatching()
        r.getOrNull()?.let { return it }
        throw (r.exceptionOrNull() as? PairingRelayError)
            ?: PairingRelayError.ConnectionFailed(r.exceptionOrNull()?.message ?: "the relay closed the connection")
    }

    fun close() {
        runCatching { ws?.close(1000, "done") }
        ws = null
        frames.close()
    }

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
    }
}

internal fun PairingFrame.asTerminalError(): PairingRelayError? = when (kind) {
    "peer-missing" -> PairingRelayError.PeerMissing
    "expired" -> PairingRelayError.SessionExpired
    "error" -> PairingRelayError.RelayErr(reason ?: "unspecified")
    "rebind" -> PairingRelayError.RelayErr("that pairing code is already in use")
    else -> null
}

private fun pipeUrl(host: String, secure: Boolean, sid: String, role: String): String =
    "${if (secure) "wss" else "ws"}://$host/qr-pipe/${URLEncoder.encode(sid, "UTF-8")}?role=$role"

private val rng = SecureRandom()

private fun freshSid(): String = Base64URL.encode(ByteArray(16).also(rng::nextBytes))

private fun freshX25519Pub(): ByteArray = X25519.publicFromPrivate(X25519.generatePrivateKey())

private val HEX_PUB = Regex("^[0-9a-f]{64}$")
private val HEX_ID = Regex("^[0-9a-f]{32}$")

private const val RETURN_LEG_TIMEOUT_MS = 20_000L

private fun defaultHost(): String = Endpoints.controlHost
private fun defaultSecure(): Boolean = Endpoints.controlBaseUrl.startsWith("https")

/** The QR-showing device: listens on leg 1, then delivers the bundle on the incoming device's return leg. */
class LiveAdminPairingRelay(
    private val client: OkHttpClient = OkHttpClient(),
    private val host: () -> String = ::defaultHost,
    private val secure: () -> Boolean = ::defaultSecure,
    private val returnLegTimeoutMs: Long = RETURN_LEG_TIMEOUT_MS,
) : AdminPairingRelay {
    private var session: QrSession? = null
    private var leg1: PairingSocket? = null
    private var leg2: PairingSocket? = null
    private var returnSid: String? = null
    private var returnPk: String? = null

    override fun attachSession(session: QrSession) {
        this.session = session
    }

    override suspend fun awaitPeerHello(sid: String): ByteArray {
        val keys = session ?: error("pairing session not attached")
        close()
        returnSid = null
        returnPk = null
        val sock = PairingSocket(client, pipeUrl(host(), secure(), sid, "browser"))
        leg1 = sock
        sock.open()
        val first = sock.next()
        if (first.kind != "accepted") throw first.asTerminalError() ?: PairingRelayError.RelayErr("unexpected ${first.kind}")

        var peerPk: ByteArray? = null
        while (true) {
            val f = sock.next()
            when (f.kind) {
                "peer-hello" -> {
                    val pk = f.phonePk?.let(Base64URL::decode)
                    if (pk == null || pk.size != 32) throw PairingRelayError.RelayErr("malformed hello")
                    peerPk = pk
                    keys.pair(pk)
                }
                "peer-deliver" -> {
                    val pk = peerPk ?: throw PairingRelayError.RelayErr("deliver before hello")
                    return openHelloPayload(keys, pk, f)
                }
                else -> f.asTerminalError()?.let { throw it }
            }
        }
    }

    private fun openHelloPayload(keys: QrSession, peerPk: ByteArray, f: PairingFrame): ByteArray {
        val plain = try {
            keys.open(f.ciphertext ?: "", f.nonce ?: "")
        } catch (t: Throwable) {
            throw PairingRelayError.RelayErr("the other device's pairing message failed to open")
        }
        val obj = runCatching { Json.parseToJsonElement(plain.decodeToString()) as JsonObject }.getOrNull()
            ?: throw PairingRelayError.RelayErr("malformed pairing message")
        fun field(k: String) = (obj[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val pub = field("devicePubHex")?.trim()?.lowercase().orEmpty()
        val id = field("deviceId")?.trim()?.lowercase().orEmpty()
        if (!HEX_PUB.matches(pub) || !HEX_ID.matches(id)) throw PairingRelayError.RelayErr("malformed pairing message")
        returnSid = field("returnSid")
        returnPk = field("returnPkB64u")
        return peerPk + requireNotNull(HexUtil.decode(pub)) + requireNotNull(HexUtil.decode(id))
    }

    override suspend fun deliver(ciphertextBase64Url: String, nonceBase64Url: String) {
        val rSid = returnSid
        if (rSid.isNullOrEmpty() || returnPk.isNullOrEmpty()) throw PairingRelayError.NoReturnChannel
        val sock = PairingSocket(client, pipeUrl(host(), secure(), rSid, "phone"))
        leg2 = sock
        try {
            withTimeout(returnLegTimeoutMs) {
                sock.open()
                sock.send {
                    put("kind", "hello")
                    put("phonePk", Base64URL.encode(freshX25519Pub()))
                }
                while (true) {
                    val f = sock.next()
                    when (f.kind) {
                        "ack" -> sock.send {
                            put("kind", "deliver")
                            put("ciphertext", ciphertextBase64Url)
                            put("nonce", nonceBase64Url)
                        }
                        "delivered" -> return@withTimeout
                        else -> f.asTerminalError()?.let { throw it }
                    }
                }
            }
        } catch (_: TimeoutCancellationException) {
            throw PairingRelayError.ConnectionFailed("timed out delivering keys to the other device")
        }
    }

    override fun close() {
        leg1?.close()
        leg2?.close()
        leg1 = null
        leg2 = null
    }
}

/** The scanning device: hellos on leg 1, then listens on its own return leg for the bundle. */
class LiveIncomingPairingRelay(
    private val client: OkHttpClient = OkHttpClient(),
    private val host: () -> String = ::defaultHost,
    private val secure: () -> Boolean = ::defaultSecure,
) : IncomingPairingRelay {
    private var session: QrSession? = null
    private var adminPub: ByteArray? = null
    private var leg1: PairingSocket? = null
    private var returnLeg: PairingSocket? = null

    override fun attachSession(session: QrSession, adminPubKey: ByteArray) {
        this.session = session
        this.adminPub = adminPubKey
    }

    override suspend fun connectAndHello(sid: String, hello: ByteArray) {
        val keys = session ?: error("pairing session not attached")
        val peer = adminPub ?: error("pairing session not attached")
        require(hello.size == 80) { "hello must be x25519 pub || device pub || device id" }
        close()
        val devicePubHex = HexUtil.encode(hello.copyOfRange(32, 64))
        val deviceIdHex = HexUtil.encode(hello.copyOfRange(64, 80))

        val rSid = freshSid()
        val back = PairingSocket(client, pipeUrl(host(), secure(), rSid, "browser"))
        returnLeg = back
        back.open()
        val accepted = back.next()
        if (accepted.kind != "accepted") throw accepted.asTerminalError() ?: PairingRelayError.RelayErr("unexpected ${accepted.kind}")

        val sock = PairingSocket(client, pipeUrl(host(), secure(), sid, "phone"))
        leg1 = sock
        sock.open()
        sock.send {
            put("kind", "hello")
            put("phonePk", Base64URL.encode(hello.copyOfRange(0, 32)))
        }
        keys.pair(peer)
        while (true) {
            val f = sock.next()
            when (f.kind) {
                "ack" -> {
                    val payload = buildJsonObject {
                        put("devicePubHex", devicePubHex)
                        put("deviceId", deviceIdHex)
                        put("returnSid", rSid)
                        put("returnPkB64u", Base64URL.encode(freshX25519Pub()))
                    }.toString().toByteArray(Charsets.UTF_8)
                    val sealed = keys.seal(payload)
                    sock.send {
                        put("kind", "deliver")
                        put("ciphertext", sealed.ciphertextB64u)
                        put("nonce", sealed.nonceB64u)
                    }
                }
                "delivered" -> return
                else -> f.asTerminalError()?.let { throw it }
            }
        }
    }

    override suspend fun awaitDelivery(): Pair<String, String> {
        val sock = returnLeg ?: throw PairingRelayError.ConnectionFailed("not connected")
        while (true) {
            val f = sock.next()
            if (f.kind == "peer-deliver") {
                val ct = f.ciphertext
                val nonce = f.nonce
                if (ct == null || nonce == null) throw PairingRelayError.RelayErr("malformed delivery")
                return ct to nonce
            }
            f.asTerminalError()?.let { throw it }
        }
    }

    override fun close() {
        leg1?.close()
        returnLeg?.close()
        leg1 = null
        returnLeg = null
    }
}
