// P8 — browser-viewer bidirectional stream.
//
// Wraps a single OkHttp WebSocket session against
// `/api/screens/browser-tabs/:tabId/stream`. The viewer collects
// `incoming` for `frame` / `error` events and calls `send(input)` for
// each pointer / scroll / key event the user makes. `close()` ends the
// session.

package com.flagshipserver.app.api

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.first
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

interface BrowserStream {
    val incoming: Flow<BrowserFrame>
    suspend fun send(input: BrowserInput)
    fun close()
}

/** In-memory stream for tests + previews. */
class MockBrowserStream : BrowserStream {
    val sent = mutableListOf<BrowserInput>()
    private val flow = MutableSharedFlow<BrowserFrame>(
        replay = 0, extraBufferCapacity = 64,
    )
    override val incoming: Flow<BrowserFrame> = flow

    fun emit(frame: BrowserFrame) {
        flow.tryEmit(frame)
    }

    override suspend fun send(input: BrowserInput) {
        sent.add(input)
    }

    override fun close() {
        // No-op for the mock; consumers handle their own cancellation.
    }
}

/** OkHttp WebSocket-backed stream. Reconnects up to maxReconnects with
 *  exponential backoff on transient close. */
class OkHttpBrowserStream(
    private val client: OkHttpClient,
    private val store: SessionStoring,
    private val tabId: String,
    private val maxReconnects: Int = 3,
) : BrowserStream {

    @Volatile private var ws: WebSocket? = null
    @Volatile private var closed: Boolean = false

    override val incoming: Flow<BrowserFrame> = callbackFlow {
        var attempt = 0
        while (!closed && attempt <= maxReconnects) {
            val base = store.podBaseUrl.first()?.trimEnd('/') ?: break
            val token = store.sessionToken.first() ?: break
            val wsBase = base
                .replaceFirst("https://", "wss://")
                .replaceFirst("http://", "ws://")
            val encodedToken = java.net.URLEncoder.encode(token, "UTF-8")
            val encodedTabId = java.net.URLEncoder.encode(tabId, "UTF-8")
                .replace("+", "%20")
            val url = "$wsBase/api/screens/browser-tabs/$encodedTabId/stream?sessionToken=$encodedToken"
            val req = Request.Builder().url(url).build()
            val closeLatch = CompletableDeferred<Boolean>()
            val socket = client.newWebSocket(req, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    ws = webSocket
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = BrowserFrame.decode(text) ?: return
                    trySend(frame)
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (!closeLatch.isCompleted) closeLatch.complete(true)
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (!closeLatch.isCompleted) closeLatch.complete(false)
                }
            })
            ws = socket
            closeLatch.await()
            ws = null
            if (closed) break
            attempt += 1
            if (attempt > maxReconnects) break
            val backoffMs = (250L shl attempt).coerceAtMost(8000L)
            delay(backoffMs)
        }
        awaitClose {
            ws?.close(1000, null)
            ws = null
        }
    }

    override suspend fun send(input: BrowserInput) {
        val text = input.toWireJson()
        ws?.send(text)
    }

    override fun close() {
        closed = true
        ws?.close(1000, null)
        ws = null
    }
}
