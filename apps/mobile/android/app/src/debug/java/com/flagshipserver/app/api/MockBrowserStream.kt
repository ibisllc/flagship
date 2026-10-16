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
