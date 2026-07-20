package com.flagshipserver.app.core

import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.URLEncoder

/**
 * Phone-side peer of `wss://<host>/burner-pipe/<sid>?role=phone` — the
 * one-shot deposit session with the desktop burner (relay DO:
 * apps/com/src/burnerRelay.ts). Kotlin mirror of the iOS BurnerPairClient.
 */

sealed interface BurnerInbound {
    data object Accepted : BurnerInbound
    data object PeerPresent : BurnerInbound
    data object PeerJoined : BurnerInbound
    data class BurnerHello(val burnerPkB64: String) : BurnerInbound
    data object RecipeAccepted : BurnerInbound
    // Phase 4 — the burner asks the phone to approve a security-sensitive
    // setting (e.g. Debug mode). Carries the box's serverDomain so the phone
    // can sign the owner-IRK debug-access grant the box verifies. Mirrors the
    // iOS BurnerInbound.consentRequest(setting, serverDomain, warning).
    data class ConsentRequest(val setting: String, val serverDomain: String, val warning: String) : BurnerInbound
    data object PeerGone : BurnerInbound
    data object Expired : BurnerInbound
    data class RelayError(val message: String) : BurnerInbound
    data object Pong : BurnerInbound
}

sealed interface BurnerOutbound {
    data class PhoneHello(val phonePkB64: String) : BurnerOutbound
    data object ConfirmPairing : BurnerOutbound
    data class Deliver(val ciphertextB64: String, val nonceB64: String) : BurnerOutbound
    data class Raw(val json: String) : BurnerOutbound

    fun toJson(): String = when (this) {
        is PhoneHello -> """{"kind":"phone-hello","phonePk":"$phonePkB64"}"""
        is ConfirmPairing -> """{"kind":"confirm-pairing"}"""
        is Deliver -> """{"kind":"deliver","ciphertext":"$ciphertextB64","nonce":"$nonceB64"}"""
        is Raw -> json
    }
}

interface BurnerPairClient {
    /** Open the WS as role=phone; returns a channel of inbound events. */
    suspend fun connect(sid: String): Channel<BurnerInbound>
    suspend fun send(frame: BurnerOutbound)
    fun close()
}

class LiveBurnerPairClient(
    private val client: OkHttpClient = OkHttpClient(),
    private val host: String = Endpoints.controlHost,
    secure: Boolean = true,
) : BurnerPairClient {
    private val scheme = if (secure) "wss" else "ws"
    private val json = Json { ignoreUnknownKeys = true }
    @Volatile private var ws: WebSocket? = null
    private var pinger: Thread? = null
    @Volatile private var closed = false
    @Volatile private var generation = 0
    private var channel = Channel<BurnerInbound>(Channel.UNLIMITED)

    override suspend fun connect(sid: String): Channel<BurnerInbound> {
        val previousWs = ws
        val previousChannel = channel
        pinger?.interrupt()
        generation += 1
        val connectionGeneration = generation
        closed = false
        val nextChannel = Channel<BurnerInbound>(Channel.UNLIMITED)
        channel = nextChannel
        val encodedSid = URLEncoder.encode(sid, "UTF-8")
        val req = Request.Builder()
            .url("$scheme://$host/burner-pipe/$encodedSid?role=phone")
            .build()
        val nextWs = client.newWebSocket(req, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (isCurrent(connectionGeneration, webSocket)) {
                    decode(text)?.let { nextChannel.trySend(it) }
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (isCurrent(connectionGeneration, webSocket)) {
                    nextChannel.trySend(BurnerInbound.RelayError("connection lost"))
                    nextChannel.close()
                }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (isCurrent(connectionGeneration, webSocket)) {
                    nextChannel.trySend(BurnerInbound.PeerGone)
                    nextChannel.close()
                }
            }
        })
        ws = nextWs
        previousWs?.cancel()
        previousChannel.close()
        startPing(connectionGeneration, nextWs)
        return nextChannel
    }

    override suspend fun send(frame: BurnerOutbound) {
        check(ws?.send(frame.toJson()) == true) { "the pairing connection is closed" }
    }

    private fun startPing(connectionGeneration: Int, socket: WebSocket) {
        pinger = Thread {
            while (!closed && generation == connectionGeneration) {
                try { Thread.sleep(20_000) } catch (_: InterruptedException) { return@Thread }
                if (closed || generation != connectionGeneration) return@Thread
                socket.send("""{"kind":"ping"}""")
            }
        }.apply { isDaemon = true; start() }
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        generation += 1
        pinger?.interrupt()
        ws?.close(1000, null)
        ws = null
        channel.close()
    }

    @Synchronized
    private fun isCurrent(connectionGeneration: Int, socket: WebSocket): Boolean =
        !closed && generation == connectionGeneration && ws === socket

    private fun decode(text: String): BurnerInbound? {
        val obj = runCatching { json.decodeFromString(JsonObject.serializer(), text) }.getOrNull() ?: return null
        val kind = obj["kind"]?.jsonPrimitive?.content ?: return null
        return when (kind) {
            "accepted" -> BurnerInbound.Accepted
            "peer-present" -> BurnerInbound.PeerPresent
            "peer-joined" -> BurnerInbound.PeerJoined
            "peer-gone" -> BurnerInbound.PeerGone
            "expired" -> BurnerInbound.Expired
            "pong" -> BurnerInbound.Pong
            "error" -> BurnerInbound.RelayError(obj["reason"]?.jsonPrimitive?.content ?: "relay error")
            "peer" -> {
                val frame = obj["frame"]?.jsonObject ?: return null
                when (frame["kind"]?.jsonPrimitive?.content) {
                    "burner-hello" -> frame["burnerPk"]?.jsonPrimitive?.content?.let { BurnerInbound.BurnerHello(it) }
                    "recipe-accepted" -> BurnerInbound.RecipeAccepted
                    "consent-request" -> BurnerInbound.ConsentRequest(
                        frame["setting"]?.jsonPrimitive?.content ?: "",
                        frame["serverDomain"]?.jsonPrimitive?.content ?: "",
                        frame["warning"]?.jsonPrimitive?.content ?: "",
                    )
                    else -> null
                }
            }
            else -> null
        }
    }
}

/** Scripted mock for tests. emit() pushes inbound; sent captures outbound. */
class MockBurnerPairClient : BurnerPairClient {
    var connectedSid: String? = null; private set
    var connectCount: Int = 0; private set
    val sent = mutableListOf<BurnerOutbound>()
    var didClose = false; private set
    private val channel = Channel<BurnerInbound>(Channel.UNLIMITED)

    override suspend fun connect(sid: String): Channel<BurnerInbound> {
        connectedSid = sid
        connectCount += 1
        return channel
    }
    override suspend fun send(frame: BurnerOutbound) { sent.add(frame) }
    override fun close() { didClose = true; channel.close() }

    fun emit(ev: BurnerInbound) { channel.trySend(ev) }
    val sentJson: List<String> get() = sent.map { it.toJson() }
}
