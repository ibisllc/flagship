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
 * long-lived bidirectional session with the desktop burner (relay DO:
 * apps/com/src/burnerRelay.ts). Kotlin mirror of the iOS BurnerPairClient.
 * The socket is the gate: a drop / peer-gone / expired ends the session.
 */

sealed interface BurnerInbound {
    /** The relay admitted us. `expiresAtMs` is the session deadline (ms since
     *  epoch, ~1h) — drives the resume freshness check + the countdown. */
    data class Accepted(val expiresAtMs: Long) : BurnerInbound
    data object PeerPresent : BurnerInbound
    data object PeerJoined : BurnerInbound
    data class BurnerHello(val burnerPkB64: String) : BurnerInbound
    // Phase 4 — the burner asks the phone to approve a security-sensitive
    // setting (e.g. Debug mode). Carries the box's serverDomain so the phone
    // can sign the owner-IRK debug-access grant the box verifies. Mirrors the
    // iOS BurnerInbound.consentRequest(setting, serverDomain, warning).
    data class ConsentRequest(val setting: String, val serverDomain: String, val warning: String) : BurnerInbound
    /** The burner disconnected from ITS side and wants its half wiped — leave. */
    data object SessionEnded : BurnerInbound
    /** ADVISORY — the burner stepped away / holds the session (NOT a wipe). The
     *  phone keeps the session alive and waits for the burner to rejoin. */
    data object PeerGone : BurnerInbound
    /** The session reached its lifetime — wipe + leave. */
    data object Expired : BurnerInbound
    data class RelayError(val message: String) : BurnerInbound
    data object Pong : BurnerInbound
}

sealed interface BurnerOutbound {
    data class PhoneHello(val phonePkB64: String) : BurnerOutbound
    data object ConfirmPairing : BurnerOutbound
    data class Deliver(val ciphertextB64: String, val nonceB64: String) : BurnerOutbound
    /** The user explicitly disconnected — tell the burner to wipe its half. */
    data object SessionEnded : BurnerOutbound
    data class Raw(val json: String) : BurnerOutbound

    fun toJson(): String = when (this) {
        is PhoneHello -> """{"kind":"phone-hello","phonePk":"$phonePkB64"}"""
        is ConfirmPairing -> """{"kind":"confirm-pairing"}"""
        is Deliver -> """{"kind":"deliver","ciphertext":"$ciphertextB64","nonce":"$nonceB64"}"""
        is SessionEnded -> """{"kind":"session-ended"}"""
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
    private var ws: WebSocket? = null
    private var pinger: Thread? = null
    @Volatile private var closed = false
    // Fresh channel per connect so a RESUME (reconnect with the same sid) gets a
    // live channel — a single instance can reconnect across a phone-lock drop.
    private var channel: Channel<BurnerInbound>? = null

    override suspend fun connect(sid: String): Channel<BurnerInbound> {
        closed = false
        val ch = Channel<BurnerInbound>(Channel.UNLIMITED)
        channel = ch
        val encodedSid = URLEncoder.encode(sid, "UTF-8")
        val req = Request.Builder()
            .url("$scheme://$host/burner-pipe/$encodedSid?role=phone")
            .build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                decode(text)?.let { ch.trySend(it) }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!closed) { ch.trySend(BurnerInbound.RelayError("connection lost")); ch.close() }
            }
            // A relay-side close drops the SOCKET, not the session — surface it
            // as a RelayError so the controller reconnects (resumable) rather
            // than treating it as the burner stepping away.
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!closed) { ch.trySend(BurnerInbound.RelayError("connection lost")); ch.close() }
            }
        })
        startPing()
        return ch
    }

    override suspend fun send(frame: BurnerOutbound) {
        ws?.send(frame.toJson())
    }

    private fun startPing() {
        pinger = Thread {
            while (!closed) {
                try { Thread.sleep(20_000) } catch (_: InterruptedException) { return@Thread }
                if (closed) return@Thread
                ws?.send("""{"kind":"ping"}""")
            }
        }.apply { isDaemon = true; start() }
    }

    override fun close() {
        if (closed) return
        closed = true
        pinger?.interrupt()
        ws?.close(1000, null)
        ws = null
        channel?.close()
    }

    private fun decode(text: String): BurnerInbound? {
        val obj = runCatching { json.decodeFromString(JsonObject.serializer(), text) }.getOrNull() ?: return null
        val kind = obj["kind"]?.jsonPrimitive?.content ?: return null
        return when (kind) {
            "accepted" -> {
                // expiresAt is ms-since-epoch; tolerate number or numeric string.
                val exp = obj["expiresAt"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L
                BurnerInbound.Accepted(exp)
            }
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
                    "session-ended" -> BurnerInbound.SessionEnded
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
    /** Number of times connect() was called — a resume re-opens the SAME sid,
     *  so a successful reconnect bumps this to ≥2. Mirror of iOS connectCount. */
    var connectCount = 0; private set
    val sent = mutableListOf<BurnerOutbound>()
    var didClose = false; private set
    // Fresh channel per connect (mirrors the live client + iOS Mock) so a
    // reconnect after a drop gets a live channel.
    private var channel: Channel<BurnerInbound>? = null

    override suspend fun connect(sid: String): Channel<BurnerInbound> {
        connectedSid = sid
        connectCount += 1
        val ch = Channel<BurnerInbound>(Channel.UNLIMITED)
        channel = ch
        return ch
    }
    override suspend fun send(frame: BurnerOutbound) { sent.add(frame) }
    override fun close() { didClose = true; channel?.close() }

    fun emit(ev: BurnerInbound) { channel?.trySend(ev) }
    val sentJson: List<String> get() = sent.map { it.toJson() }
}
