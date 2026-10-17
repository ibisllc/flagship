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
