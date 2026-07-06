// Kotlin mirror of FlagshipAPI/Client/QrRelayClient.swift.
//
// Phone-side peer of `wss://flagshipserver.com/qr-pipe/<sid>?role=phone`
// (relay-v2). Wraps an OkHttp WebSocket + the small JSON-line frame
// protocol shared with the browser counterpart in heroQr.js +
// create-server.js.
//
// Frame protocol:
//   ← from relay
//     { kind: "ack" }                  // server received our hello
//     { kind: "delivered" }            // browser AEAD-opened our payload
//     { kind: "peer-missing" }         // browser isn't on the other side
//     { kind: "expired" }              // sid TTL elapsed
//     { kind: "error", reason: ... }
//   → to relay
//     { kind: "hello", phonePk: <b64u> }
//     { kind: "deliver", ciphertext: <b64u>, nonce: <b64u> }

package com.flagshipserver.app.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.URLEncoder

interface QrRelayClient {
    /** Open the WS, send hello, await ack. Throws on close-before-ack. */
    suspend fun openAndHello(sid: String, phonePkBase64Url: String)
    /** Push a sealed payload and await the browser's AEAD-open ack. */
    suspend fun deliver(ciphertextBase64Url: String, nonceBase64Url: String)
    /** Idempotent close. */
    fun close()
}

sealed class QrRelayError(message: String) : RuntimeException(message) {
    data class ConnectionFailed(val why: String) : QrRelayError("Couldn't reach the relay: $why")
    object RelayClosedBeforeAck : QrRelayError("The relay closed before the browser acknowledged.")
    object PeerMissing : QrRelayError("The browser at flagshipserver.com isn't connected — reload it and try again.")
    object SessionExpired : QrRelayError("Session expired — refresh the homepage and try again.")
    data class RelayErr(val msg: String) : QrRelayError("Relay: $msg")
    data class UnexpectedFrame(val raw: String) : QrRelayError("Unexpected frame from relay: $raw")
    data class NotImplementedFeature(val feature: String) : QrRelayError("Not implemented yet: $feature")
}

class LiveQrRelayClient(
    private val client: OkHttpClient = OkHttpClient(),
    private val host: String = DEFAULT_HOST,
    secure: Boolean = true,
) : QrRelayClient {
    companion object {
        /** Control apex host, via [Endpoints] (prod-default + test override). */
        val DEFAULT_HOST: String get() = Endpoints.controlHost
        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    }

    private val scheme = if (secure) "wss" else "ws"
    private var ws: WebSocket? = null
    private val incoming = Channel<Frame>(capacity = Channel.UNLIMITED)
    private val openSignal = CompletableDeferred<Unit>()

    override suspend fun openAndHello(sid: String, phonePkBase64Url: String) {
        if (ws != null) return
        val encodedSid = URLEncoder.encode(sid, "UTF-8")
        val req = Request.Builder()
            .url("$scheme://$host/qr-pipe/$encodedSid?role=phone")
            .build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                openSignal.complete(Unit)
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val obj = runCatching { json.decodeFromString(JsonObject.serializer(), text) }.getOrNull()
                val kind = obj?.get("kind")?.toString()?.trim('"') ?: "unknown"
                val reason = obj?.get("reason")?.toString()?.trim('"')
                incoming.trySend(Frame(kind, reason))
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                incoming.close()
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!openSignal.isCompleted) openSignal.completeExceptionally(
                    QrRelayError.ConnectionFailed(t.message ?: "websocket failure")
                )
                incoming.close(t)
            }
        })
        openSignal.await()
        ws?.send("""{"kind":"hello","phonePk":"$phonePkBase64Url"}""")
            ?: throw QrRelayError.ConnectionFailed("no socket")
        awaitTerminalAck("ack")
    }

    override suspend fun deliver(ciphertextBase64Url: String, nonceBase64Url: String) {
        val sock = ws ?: throw QrRelayError.ConnectionFailed("not open")
        sock.send("""{"kind":"deliver","ciphertext":"$ciphertextBase64Url","nonce":"$nonceBase64Url"}""")
        awaitTerminalAck("delivered")
    }

    override fun close() {
        ws?.close(1000, null)
        ws = null
    }

    private suspend fun awaitTerminalAck(expected: String) {
        while (true) {
            val frame = incoming.receive()
            when (frame.kind) {
                expected -> return
                "peer-missing" -> throw QrRelayError.PeerMissing
                "expired" -> throw QrRelayError.SessionExpired
                "error" -> throw QrRelayError.RelayErr(frame.reason ?: "unspecified")
                else -> throw QrRelayError.UnexpectedFrame("expected $expected, got ${frame.kind}")
            }
        }
    }

    private data class Frame(val kind: String, val reason: String?)
}

/** Scripted mock relay for tests. */
class MockQrRelayClient(
    var behavior: Behavior = Behavior.AckThenDelivered,
    var simulatedLatencyMs: Long = 0,
) : QrRelayClient {
    sealed interface Behavior {
        object AckThenDelivered : Behavior
        object PeerMissing : Behavior
        object SessionExpired : Behavior
        data class RelayError(val reason: String) : Behavior
    }

    var lastHello: Pair<String, String>? = null
        private set
    var lastDeliver: Pair<String, String>? = null
        private set

    override suspend fun openAndHello(sid: String, phonePkBase64Url: String) {
        if (simulatedLatencyMs > 0) kotlinx.coroutines.delay(simulatedLatencyMs)
        lastHello = sid to phonePkBase64Url
        when (val b = behavior) {
            Behavior.AckThenDelivered -> return
            Behavior.PeerMissing -> throw QrRelayError.PeerMissing
            Behavior.SessionExpired -> throw QrRelayError.SessionExpired
            is Behavior.RelayError -> throw QrRelayError.RelayErr(b.reason)
        }
    }

    override suspend fun deliver(ciphertextBase64Url: String, nonceBase64Url: String) {
        if (simulatedLatencyMs > 0) kotlinx.coroutines.delay(simulatedLatencyMs)
        lastDeliver = ciphertextBase64Url to nonceBase64Url
        when (val b = behavior) {
            Behavior.AckThenDelivered -> return
            Behavior.PeerMissing -> throw QrRelayError.PeerMissing
            Behavior.SessionExpired -> throw QrRelayError.SessionExpired
            is Behavior.RelayError -> throw QrRelayError.RelayErr(b.reason)
        }
    }

    override fun close() {}
}
