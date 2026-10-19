package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/** The frame protocol of apps/com/src/buildRelay.ts, served by a local MockWebServer. */
class FakeQrRelayServer : Dispatcher() {
    private class Session {
        @Volatile var browser: WebSocket? = null
        @Volatile var phone: WebSocket? = null
        @Volatile var consumed = false
    }

    private val sessions = ConcurrentHashMap<String, Session>()
    private val expiredSids = ConcurrentHashMap.newKeySet<String>()
    private val server = MockWebServer().apply { dispatcher = this@FakeQrRelayServer }

    /** Every phone frame the relay saw, as "sid/role:text". */
    val frameLog = CopyOnWriteArrayList<String>()

    val host: String get() = "${server.hostName}:${server.port}"

    fun start() = server.start()
    fun stop() {
        runCatching { server.shutdown() }
    }

    fun expireSid(sid: String) {
        expiredSids.add(sid)
    }

    fun hasBrowser(sid: String): Boolean = sessions[sid]?.browser != null

    fun expireLive() {
        sessions.values.forEach { s ->
            s.browser?.send("""{"kind":"expired"}""")
            s.phone?.send("""{"kind":"expired"}""")
        }
    }

    override fun dispatch(request: RecordedRequest): MockResponse {
        val url = request.requestUrl ?: return MockResponse().setResponseCode(400)
        val sid = url.pathSegments.getOrNull(1) ?: return MockResponse().setResponseCode(400)
        val role = url.queryParameter("role") ?: return MockResponse().setResponseCode(400)
        if (sid in expiredSids) return MockResponse().setResponseCode(410)
        return MockResponse().withWebSocketUpgrade(listener(sid, role))
    }

    private fun listener(sid: String, role: String) = object : WebSocketListener() {
        private val session get() = sessions.getOrPut(sid) { Session() }

        override fun onOpen(webSocket: WebSocket, response: Response) {
            val s = session
            if (role == "browser") {
                if (s.consumed || s.browser != null) {
                    webSocket.send("""{"kind":"rebind"}""")
                    webSocket.close(1000, null)
                } else {
                    s.browser = webSocket
                    webSocket.send("""{"kind":"accepted"}""")
                }
            } else if (s.consumed) {
                webSocket.send("""{"kind":"error","reason":"session already consumed"}""")
                webSocket.close(1000, null)
            } else if (s.phone != null) {
                webSocket.send("""{"kind":"error","reason":"phone slot taken"}""")
                webSocket.close(1000, null)
            } else {
                s.phone = webSocket
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            frameLog.add("$sid/$role:$text")
            val s = session
            if (role == "browser") {
                webSocket.send("""{"kind":"error","reason":"browser sends nothing"}""")
                return
            }
            val msg = runCatching { Json.parseToJsonElement(text) as JsonObject }.getOrNull()
            fun field(k: String) = (msg?.get(k) as? JsonPrimitive)?.content.orEmpty()
            when (field("kind")) {
                "hello" -> {
                    val b = s.browser
                    if (b == null) {
                        webSocket.send("""{"kind":"peer-missing"}""")
                    } else {
                        b.send(buildJsonObject { put("kind", "peer-hello"); put("phonePk", field("phonePk")) }.toString())
                        webSocket.send("""{"kind":"ack"}""")
                    }
                }
                "deliver" -> {
                    val b = s.browser
                    if (b == null) {
                        webSocket.send("""{"kind":"error","reason":"browser not connected"}""")
                    } else if (s.consumed) {
                        webSocket.send("""{"kind":"error","reason":"already delivered"}""")
                    } else {
                        b.send(
                            buildJsonObject {
                                put("kind", "peer-deliver")
                                put("ciphertext", field("ciphertext"))
                                put("nonce", field("nonce"))
                            }.toString(),
                        )
                        webSocket.send("""{"kind":"delivered"}""")
                        s.consumed = true
                        b.close(1000, null)
                        webSocket.close(1000, null)
                    }
                }
                else -> webSocket.send("""{"kind":"error","reason":"unknown kind"}""")
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            onClosed(webSocket, code, reason)
            webSocket.close(code, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            val s = session
            if (s.browser === webSocket) s.browser = null
            if (s.phone === webSocket) s.phone = null
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            onClosed(webSocket, 1011, "failure")
        }
    }
}
