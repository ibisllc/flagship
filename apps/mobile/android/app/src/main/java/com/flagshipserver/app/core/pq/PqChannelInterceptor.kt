package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import java.io.IOException
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

/**
 * The phone's side of `flagship/pq-session/v1` (docs/architecture-v2/pq-suites.md §13), as an
 * OkHttp application interceptor: a request to a server this phone holds as strict is sealed
 * inside a session opened with this device's hybrid key to the server's pinned ML-DSA key, and is
 * never sent in the clear. A server another device made strict answers `pq-channel-required`;
 * the request is then asked again over the channel.
 */
class PqChannelInterceptor : Interceptor {
    class Identity(val binding: PqTrust.VerifiedBinding, val sign: PqSession.Signer)

    class NotReady(message: String) : IOException(message)

    @Volatile var isStrict: (String) -> Boolean = { false }
    @Volatile var responder: (String) -> PqTrust.VerifiedBinding? = { null }
    @Volatile var identity: () -> Identity? = { null }
    @Volatile var now: () -> Long = { System.currentTimeMillis() }

    private val marked = ConcurrentHashMap.newKeySet<String>()
    private val open = ConcurrentHashMap<String, PqSession.Channel>()
    private val json = Json
    private val jsonType = "application/json".toMediaType()

    fun reset() {
        for (c in open.values) c.close()
        open.clear()
        marked.clear()
    }

    private fun carries(host: String) = host in marked || isStrict(host)

    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val host = req.url.host.lowercase()
        if (req.url.encodedPath.startsWith("/api/pq-session/")) return chain.proceed(req)
        if (carries(host)) return tunnel(chain, req, host)
        val res = chain.proceed(req)
        if (res.code == 403) {
            val peek = res.peekBody(512).string()
            if (peek.contains("\"pq-channel-required\"")) {
                res.close()
                marked.add(host)
                return tunnel(chain, req, host)
            }
        }
        return res
    }

    private fun post(base: Request, path: String, body: JsonObject): Request =
        base.newBuilder().url(base.url.newBuilder().encodedPath(path).query(null).build()).headers(okhttp3.Headers.headersOf())
            .post(body.toString().toRequestBody(jsonType)).build()

    private fun connect(chain: Interceptor.Chain, req: Request, host: String): PqSession.Channel {
        val pinned = responder(host) ?: throw NotReady("This server is quantum-safe, but this phone hasn't checked its post-quantum key yet. Open the server once while online.")
        val me = identity() ?: throw NotReady("This server only accepts quantum-safe connections, and this phone's post-quantum key isn't ready. Unlock the app and try again.")
        val st = PqSession.Initiator(pinned, "device", me.binding, now())
        val h = chain.proceed(post(req, "/api/pq-session/hello", buildJsonObject { put("hello", st.hello.toJson()) }))
        val hb = h.use { if (it.code != 200) throw NotReady("The server refused this phone's quantum-safe connection.") else json.parseToJsonElement(it.body!!.string()).jsonObject }
        val (fin, channel) = st.finish(hb["accept"], now(), me.sign)
        val f = chain.proceed(post(req, "/api/pq-session/finish", buildJsonObject { put("handshake", hb["handshake"]!!); put("finish", fin) }))
        val fb = f.use { if (it.code != 200) throw NotReady("The server's quantum-safe connection did not complete.") else json.parseToJsonElement(it.body!!.string()).jsonObject }
        if (fb["session"]?.jsonPrimitive?.contentOrNull != channel.sessionIdHex) throw NotReady("The server's quantum-safe connection did not complete.")
        open[host] = channel
        return channel
    }

    private fun tunnel(chain: Interceptor.Chain, req: Request, host: String): Response {
        val body = req.body?.let { b -> Buffer().also { b.writeTo(it) }.readByteArray() } ?: ByteArray(0)
        val headers = buildJsonObject {
            for ((k, v) in req.headers) put(k.lowercase(), v)
            req.body?.contentType()?.let { put("content-type", it.toString()) }
        }
        val path = req.url.encodedPath + (req.url.encodedQuery?.let { "?$it" } ?: "")
        val inner = buildJsonObject {
            put("method", req.method); put("path", path); put("headers", headers); put("body", Base64.getEncoder().encodeToString(body))
        }.toString().toByteArray()
        repeat(2) {
            val ch = open[host] ?: connect(chain, req, host)
            val (seq, record) = ch.sealRequest(inner, now())
            val r = chain.proceed(post(req, "/api/pq-session/call", buildJsonObject {
                put("session", ch.sessionIdHex); put("record", Base64.getEncoder().encodeToString(record))
            }))
            if (r.code == 410) { r.close(); open.remove(host); return@repeat }
            if (r.code != 200) return r
            val rec = r.use { json.parseToJsonElement(it.body!!.string()).jsonObject["record"]!!.jsonPrimitive.content }
            val ans = json.parseToJsonElement(String(ch.openResponse(seq, Base64.getDecoder().decode(rec)))).jsonObject
            val b = Base64.getDecoder().decode(ans["body"]!!.jsonPrimitive.content)
            val hb = okhttp3.Headers.Builder()
            (ans["headers"] as? JsonObject)?.forEach { (k, v) -> (v as? JsonPrimitive)?.contentOrNull?.let { runCatching { hb.add(k, it) } } }
            val type = hb["content-type"]?.toMediaType()
            return Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(ans["status"]!!.jsonPrimitive.int).message("")
                .headers(hb.build()).body(b.toResponseBody(type)).build()
        }
        throw NotReady("The server keeps closing the quantum-safe connection. Try again.")
    }

    companion object {
        val shared = PqChannelInterceptor()
    }
}
