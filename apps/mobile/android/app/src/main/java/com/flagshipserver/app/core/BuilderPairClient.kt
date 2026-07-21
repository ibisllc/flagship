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
 * Phone-side peer of `wss://<host>/builder-pipe/<sid>?role=phone` — the
 * one-shot deposit session with the desktop builder (relay DO:
 * apps/com/src/builderRelay.ts). Kotlin mirror of the iOS BuilderPairClient.
 */

sealed interface BuilderInbound {
    data object Accepted : BuilderInbound
    data object PeerPresent : BuilderInbound
    data object PeerJoined : BuilderInbound
    data class BuilderHello(val builderPkB64: String) : BuilderInbound
    data object RecipeAccepted : BuilderInbound
    // Phase 4 — the builder asks the phone to approve a security-sensitive
    // setting (e.g. Debug mode). Carries the box's serverDomain so the phone
    // can sign the owner-IRK debug-access grant the box verifies. Mirrors the
    // iOS BuilderInbound.consentRequest(setting, serverDomain, warning).
    data class ConsentRequest(val setting: String, val serverDomain: String, val warning: String) : BuilderInbound
    data object PeerGone : BuilderInbound
    data object Expired : BuilderInbound
    data class RelayError(val message: String) : BuilderInbound
    data object Pong : BuilderInbound
}

sealed interface BuilderOutbound {
    data class PhoneHello(val phonePkB64: String) : BuilderOutbound
    data object ConfirmPairing : BuilderOutbound
    data class Deliver(val ciphertextB64: String, val nonceB64: String) : BuilderOutbound
    data class Raw(val json: String) : BuilderOutbound

    fun toJson(): String = when (this) {
        is PhoneHello -> """{"kind":"phone-hello","phonePk":"$phonePkB64"}"""
        is ConfirmPairing -> """{"kind":"confirm-pairing"}"""
        is Deliver -> """{"kind":"deliver","ciphertext":"$ciphertextB64","nonce":"$nonceB64"}"""
        is Raw -> json
    }
}

interface BuilderPairClient {
    /** Open the WS as role=phone; returns a channel of inbound events. */
    suspend fun connect(sid: String): Channel<BuilderInbound>
    suspend fun send(frame: BuilderOutbound)
    fun close()
}

class LiveBuilderPairClient(
    private val client: OkHttpClient = OkHttpClient(),
    private val host: String = Endpoints.controlHost,
    secure: Boolean = true,
) : BuilderPairClient {
    private val scheme = if (secure) "wss" else "ws"
    private val json = Json { ignoreUnknownKeys = true }
    @Volatile private var ws: WebSocket? = null
    private var pinger: Thread? = null
    @Volatile private var closed = false
    @Volatile private var generation = 0
    private var channel = Channel<BuilderInbound>(Channel.UNLIMITED)

    override suspend fun connect(sid: String): Channel<BuilderInbound> {
        val previousWs = ws
        val previousChannel = channel
        pinger?.interrupt()
        generation += 1
        val connectionGeneration = generation
        closed = false
        val nextChannel = Channel<BuilderInbound>(Channel.UNLIMITED)
        channel = nextChannel
        val encodedSid = URLEncoder.encode(sid, "UTF-8")
        val req = Request.Builder()
            .url("$scheme://$host/builder-pipe/$encodedSid?role=phone")
            .build()
        val nextWs = client.newWebSocket(req, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (isCurrent(connectionGeneration, webSocket)) {
                    decode(text)?.let { nextChannel.trySend(it) }
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (isCurrent(connectionGeneration, webSocket)) {
                    nextChannel.trySend(BuilderInbound.RelayError("connection lost"))
                    nextChannel.close()
                }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (isCurrent(connectionGeneration, webSocket)) {
                    nextChannel.trySend(BuilderInbound.PeerGone)
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

    override suspend fun send(frame: BuilderOutbound) {
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

    private fun decode(text: String): BuilderInbound? {
        val obj = runCatching { json.decodeFromString(JsonObject.serializer(), text) }.getOrNull() ?: return null
        val kind = obj["kind"]?.jsonPrimitive?.content ?: return null
        return when (kind) {
            "accepted" -> BuilderInbound.Accepted
            "peer-present" -> BuilderInbound.PeerPresent
            "peer-joined" -> BuilderInbound.PeerJoined
            "peer-gone" -> BuilderInbound.PeerGone
            "expired" -> BuilderInbound.Expired
            "pong" -> BuilderInbound.Pong
            "error" -> BuilderInbound.RelayError(obj["reason"]?.jsonPrimitive?.content ?: "relay error")
            "peer" -> {
                val frame = obj["frame"]?.jsonObject ?: return null
                when (frame["kind"]?.jsonPrimitive?.content) {
                    "builder-hello" -> frame["builderPk"]?.jsonPrimitive?.content?.let { BuilderInbound.BuilderHello(it) }
                    "recipe-accepted" -> BuilderInbound.RecipeAccepted
                    "consent-request" -> BuilderInbound.ConsentRequest(
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
class MockBuilderPairClient : BuilderPairClient {
    var connectedSid: String? = null; private set
    var connectCount: Int = 0; private set
    val sent = mutableListOf<BuilderOutbound>()
    var didClose = false; private set
    private val channel = Channel<BuilderInbound>(Channel.UNLIMITED)

    override suspend fun connect(sid: String): Channel<BuilderInbound> {
        connectedSid = sid
        connectCount += 1
        return channel
    }
    override suspend fun send(frame: BuilderOutbound) { sent.add(frame) }
    override fun close() { didClose = true; channel.close() }

    fun emit(ev: BuilderInbound) { channel.trySend(ev) }
    val sentJson: List<String> get() = sent.map { it.toJson() }
}
