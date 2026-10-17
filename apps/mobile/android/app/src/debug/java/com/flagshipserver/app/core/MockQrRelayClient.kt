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
