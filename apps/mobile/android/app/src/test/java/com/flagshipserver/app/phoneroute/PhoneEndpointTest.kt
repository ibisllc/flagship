// The phone endpoint end to end on the JVM: TLS terminated by TlsServerStream (SSLEngine) with the
// phone's key and a certificate for exactly its bare name, the minimal HTTP answers, the session
// opened with the one-time code, and the sibling-app attacks of Appendix H scenario 11 refused.
// Also: certificate reuse (no order per handover) and the tunnel client's claim against a fake relay.

package com.flagshipserver.app.phoneroute

import android.content.SharedPreferences
import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.file.Files
import java.security.KeyFactory
import java.security.KeyStore
import java.security.PrivateKey
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLEngineResult
import javax.net.ssl.TrustManagerFactory

private const val HOST = "alice.flagship.services"

/** A P-256 key and a self-signed certificate for exactly `host` (openssl), or null where openssl is missing. */
private fun selfSigned(host: String = HOST): Pair<PrivateKey, Array<X509Certificate>>? {
    val dir = Files.createTempDirectory("phone-cert").toFile()
    try {
        val p = runCatching {
            ProcessBuilder(
                "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2",
                "-subj", "/CN=$host", "-addext", "subjectAltName=DNS:$host",
                "-keyout", File(dir, "k.pem").path, "-out", File(dir, "c.pem").path,
            ).redirectErrorStream(true).start()
        }.getOrNull() ?: return null
        p.inputStream.readBytes()
        if (p.waitFor() != 0) return null
        val keyPem = File(dir, "k.pem").readText()
        val der = Base64.getMimeDecoder().decode(keyPem.substringAfter("-----BEGIN PRIVATE KEY-----").substringBefore("-----END"))
        val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(der))
        return key to PhoneKeyManager.parseChain(File(dir, "c.pem").readText())
    } finally {
        dir.deleteRecursively()
    }
}

private fun clientContext(trust: X509Certificate): SSLContext {
    val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("phone", trust) }
    val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ks) }
    return SSLContext.getInstance("TLS").apply { init(null, tmf.trustManagers, null) }
}

/** Drives a client SSLEngine against a TlsServerStream in memory; returns the plaintext answer. */
private fun roundTrip(server: (toClient: (ByteArray) -> Unit) -> TlsServerStream, client: SSLEngine, request: String): String {
    val toClient = LinkedBlockingQueue<ByteArray>()
    val s = server { toClient.add(it) }
    val answer = StringBuilder()
    var netIn = ByteBuffer.allocate(64 * 1024)
    val appIn = ByteBuffer.allocate(64 * 1024)
    val empty = ByteBuffer.allocate(0)
    var sent = false
    client.beginHandshake()
    repeat(200) {
        when (client.handshakeStatus) {
            SSLEngineResult.HandshakeStatus.NEED_TASK -> while (true) client.delegatedTask?.run() ?: break
            SSLEngineResult.HandshakeStatus.NEED_WRAP -> {
                val out = ByteBuffer.allocate(client.session.packetBufferSize)
                client.wrap(empty, out)
                out.flip()
                s.feed(ByteArray(out.remaining()).also { out.get(it) })
            }
            else -> {}
        }
        if (!sent && client.handshakeStatus == SSLEngineResult.HandshakeStatus.NOT_HANDSHAKING) {
            val out = ByteBuffer.allocate(client.session.packetBufferSize)
            client.wrap(ByteBuffer.wrap(request.toByteArray()), out)
            out.flip()
            s.feed(ByteArray(out.remaining()).also { out.get(it) })
            sent = true
        }
        val chunk = toClient.poll(50, TimeUnit.MILLISECONDS)
        if (chunk != null) {
            netIn.put(chunk)
            netIn.flip()
            while (netIn.hasRemaining()) {
                val r = client.unwrap(netIn, appIn)
                if (r.status == SSLEngineResult.Status.BUFFER_UNDERFLOW || r.status == SSLEngineResult.Status.CLOSED) break
                if (client.handshakeStatus == SSLEngineResult.HandshakeStatus.NEED_TASK) while (true) client.delegatedTask?.run() ?: break
                if (client.handshakeStatus == SSLEngineResult.HandshakeStatus.NEED_WRAP) break
            }
            netIn.compact()
            appIn.flip()
            answer.append(String(ByteArray(appIn.remaining()).also { appIn.get(it) }))
            appIn.clear()
        }
        if (client.isInboundDone) return answer.toString()
    }
    return answer.toString()
}

class PhoneEndpointTest {
    private val pub = "ab".repeat(32)

    private fun req(method: String, path: String, vararg headers: Pair<String, String>, body: String = ""): Pair<HttpHead, ByteArray> {
        val h = headers.toMap().mapKeys { it.key.lowercase() }.toMutableMap()
        h.putIfAbsent("host", HOST)
        return HttpHead(method, path, h) to body.toByteArray()
    }

    private fun status(b: ByteArray) = String(b).substringBefore("\r\n").split(' ')[1].toInt()
    private fun body(b: ByteArray) = String(b).substringAfter("\r\n\r\n")

    @Test fun tlsEndsOnThePhoneWithItsOwnCertificate() {
        val (key, chain) = selfSigned() ?: return assumeTrue("openssl not available", false)
        val ep = PhoneEndpoint("alice", HOST, pub)
        val serverCtx = PhoneKeyManager.sslContext(key, chain)
        lateinit var stream: TlsServerStream
        val reader = HttpRequestReader()
        val client = clientContext(chain[0]).createSSLEngine(HOST, 443).apply { useClientMode = true }
        val answer = roundTrip({ toClient ->
            TlsServerStream(serverCtx.createSSLEngine(), toClient, onPlain = { plain ->
                reader.push(plain)?.let { (h, b) ->
                    stream.write(ep.respond(h, b))
                    stream.close()
                }
            }, onClosed = {}).also { stream = it }
        }, client, "GET /.well-known/flagship-phone HTTP/1.1\r\nhost: $HOST\r\n\r\n")
        assertTrue(answer, answer.startsWith("HTTP/1.1 200"))
        assertTrue(answer.contains("\"phoneRoutePub\":\"$pub\""))
        assertEquals(HOST, (client.session.peerCertificates[0] as X509Certificate).subjectX500Principal.name.substringAfter("CN="))
        assertFalse("no CORS header is ever sent", answer.lowercase().contains("access-control-"))
    }

    @Test fun sessionWithTheOneTimeCodeThenSiblingAttacksAreRefused() {
        val ep = PhoneEndpoint("alice", HOST, pub)
        val origin = "origin" to "https://$HOST"
        // No code issued yet / wrong code.
        assertEquals(403, status(ep.respond(req("POST", "/api/phone/session", origin, body = """{"code":"123456"}""").first, """{"code":"123456"}""".toByteArray())))
        val code = ep.newCode()
        // A sibling app (same site, different origin) cannot open a session even with the code.
        val sibling = ep.respond(req("POST", "/api/phone/session", "origin" to "https://notes.$HOST").first, """{"code":"$code"}""".toByteArray())
        assertEquals(403, status(sibling))
        assertTrue(body(sibling).contains("cross-origin"))
        val open = ep.respond(req("POST", "/api/phone/session", origin).first, """{"code":"$code"}""".toByteArray())
        assertEquals(200, status(open))
        val setCookie = String(open).lines().first { it.startsWith("set-cookie:") }
        assertTrue(setCookie.contains("__Host-flagship-phone=") && setCookie.contains("Secure") && setCookie.contains("HttpOnly") && setCookie.contains("SameSite=Strict") && setCookie.contains("Path=/"))
        assertFalse(setCookie.contains("Domain", ignoreCase = true))
        val token = setCookie.substringAfter("__Host-flagship-phone=").substringBefore(';')
        val csrf = Json.parseToJsonElement(body(open)).jsonObject["csrf"]!!.jsonPrimitive.content
        // The code is single use.
        assertEquals(403, status(ep.respond(req("POST", "/api/phone/session", origin).first, """{"code":"$code"}""".toByteArray())))
        val cookie = "cookie" to "__Host-flagship-phone=$token"
        assertEquals(200, status(ep.respond(req("POST", "/api/phone/ping", origin, cookie, PhoneRoute.CSRF_HEADER to csrf).first, ByteArray(0))))
        // CSRF: a form post from anywhere carries no header.
        assertEquals(403, status(ep.respond(req("POST", "/api/phone/ping", origin, cookie).first, ByteArray(0))))
        // Cross-origin read/write from a sibling, cookie and all.
        assertEquals(403, status(ep.respond(req("POST", "/api/phone/ping", "origin" to "https://notes.$HOST", cookie, PhoneRoute.CSRF_HEADER to csrf).first, ByteArray(0))))
        // An injected cookie (not a live session) is no session.
        assertEquals(403, status(ep.respond(req("POST", "/api/phone/ping", origin, "cookie" to "__Host-flagship-phone=${"x".repeat(64)}", PhoneRoute.CSRF_HEADER to csrf).first, ByteArray(0))))
        // A WebSocket upgrade from a sibling origin.
        assertEquals(403, status(ep.respond(req("GET", "/api/phone/ws", "origin" to "https://notes.$HOST", "upgrade" to "websocket", cookie).first, ByteArray(0))))
        // A request for a sibling's Host.
        assertEquals(403, status(ep.respond(req("GET", "/.well-known/flagship-phone", "host" to "notes.$HOST").first, ByteArray(0))))
    }

    @Test fun aSignedHelloIsRecordedAndAnythingElseIsNot() {
        var now = 1_800_000_000_000L
        val ep = PhoneEndpoint("alice", HOST, pub, now = { now })
        val seed = ByteArray(32) { 9 }
        val device = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)
        fun hello(at: Long, host: String = HOST, key: ByteArray = seed): ByteArray {
            val sig = PhoneRoute.sign(PhoneRoute.canonicalPresence("alice", device, host, at), Ed25519Sign(key))
            return ep.respond(req("GET", "/", "x-flagship-presence-device" to device, "x-flagship-presence-at" to at.toString(), "x-flagship-presence-sig" to sig).first, ByteArray(0))
        }
        val ok = hello(now)
        assertEquals(200, status(ok))
        assertTrue(body(ok).contains("\"recorded\":true"))
        assertEquals(now, ep.lastSeen()[device])
        // Stale, signed by another key, or for another name: answered (a holder exists) but not recorded.
        now += 1_000
        assertTrue(body(hello(now - 61_000)).contains("\"recorded\":false"))
        assertTrue(body(hello(now, key = ByteArray(32) { 8 })).contains("\"recorded\":false"))
        assertEquals(now - 1_000, ep.lastSeen()[device])
        // A plain GET / is a 2xx too: it only says the name has a holder.
        assertEquals(200, status(ep.respond(req("GET", "/").first, ByteArray(0))))
    }

    @Test fun framesRoundTrip() {
        val f = TunnelFrames.encode(7, TunnelFrames.DATA, byteArrayOf(1, 2, 3))
        val d = TunnelFrames.decode(f)!!
        assertEquals(7, d.streamId)
        assertEquals(TunnelFrames.DATA, d.type)
        assertTrue(d.payload.contentEquals(byteArrayOf(1, 2, 3)))
        assertTrue(TunnelFrames.decode(f + byteArrayOf(0)) == null)
        assertEquals("wss://relay.example:8443/phone-tunnel", PhoneTunnelClient.phoneTunnelUrl("wss://relay.example:8443/tunnel"))
    }
}

/** An in-memory SharedPreferences for the store. */
private class MemPrefs : SharedPreferences {
    val map = HashMap<String, Any?>()
    override fun getAll() = map
    override fun getString(k: String, d: String?) = map[k] as String? ?: d
    override fun getStringSet(k: String, d: MutableSet<String>?) = d
    override fun getInt(k: String, d: Int) = map[k] as Int? ?: d
    override fun getLong(k: String, d: Long) = map[k] as Long? ?: d
    override fun getFloat(k: String, d: Float) = d
    override fun getBoolean(k: String, d: Boolean) = map[k] as Boolean? ?: d
    override fun contains(k: String) = map.containsKey(k)
    override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
    override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        val ops = ArrayList<() -> Unit>()
        override fun putString(k: String, v: String?) = apply { ops += { map[k] = v } }
        override fun putStringSet(k: String, v: MutableSet<String>?) = this
        override fun putInt(k: String, v: Int) = apply { ops += { map[k] = v } }
        override fun putLong(k: String, v: Long) = apply { ops += { map[k] = v } }
        override fun putFloat(k: String, v: Float) = this
        override fun putBoolean(k: String, v: Boolean) = apply { ops += { map[k] = v } }
        override fun remove(k: String) = apply { ops += { map.remove(k) } }
        override fun clear() = apply { ops += { map.clear() } }
        override fun commit(): Boolean { ops.forEach { it() }; return true }
        override fun apply() { commit() }
    }
}

class PhoneCertManagerTest {
    private class FakeIssuer(var answer: PhoneCertIssuer.Answer) : PhoneCertIssuer {
        val orders = ArrayList<Pair<PhoneCertificateOrder, ByteArray>>()
        val signatures = ArrayList<String>()
        override suspend fun order(account: String, order: PhoneCertificateOrder, signature: String, csr: ByteArray): PhoneCertIssuer.Answer {
            orders += order to csr
            signatures += signature
            return answer
        }
        override suspend fun poll(orderId: String) = answer
    }

    @Test fun ordersOnceThenReusesUntilDueAndBacksOffAfterAFailure() = runBlocking {
        val (key, chain) = selfSigned() ?: return@runBlocking assumeTrue("openssl not available", false)
        val pem = "-----BEGIN CERTIFICATE-----\n" + Base64.getMimeEncoder().encodeToString(chain[0].encoded) + "\n-----END CERTIFICATE-----\n"
        val tlsKey = PhoneTlsKey(key, PhoneTlsKey.uncompressed(chain[0].publicKey as ECPublicKey), "test")
        var now = 1_800_000_000_000L
        val store = PhoneCertStore(MemPrefs())
        val issuer = FakeIssuer(PhoneCertIssuer.Answer.Issued(pem, now + 90L * 86_400_000))
        val m = PhoneCertManager(store, issuer, now = { now })
        val seed = ByteArray(32) { 6 }
        val device = Ed25519Sign(seed)
        val devicePub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)

        assertTrue(m.ensure("alice", "flagship.services", tlsKey, device, devicePub))
        assertEquals(1, issuer.orders.size)
        val (order, csr) = issuer.orders[0]
        assertEquals(PhoneRoute.sha256Hex(csr), order.csrSha256)
        assertEquals(devicePub, order.device)
        Ed25519Verify(HexUtil.decode(devicePub)!!).verify(HexUtil.decode(issuer.signatures[0])!!, PhoneRoute.canonical(order))
        assertNotNull(m.current("alice"))

        // A handover, a reconnect, day 59: no new order.
        now += 59L * 86_400_000
        assertFalse(m.ensure("alice", "flagship.services", tlsKey, device, devicePub))
        assertEquals(1, issuer.orders.size)
        // Day 61: due.
        now += 2L * 86_400_000
        issuer.answer = PhoneCertIssuer.Answer.Failed("issuance-rate-limited")
        assertFalse(m.ensure("alice", "flagship.services", tlsKey, device, devicePub))
        assertEquals(2, issuer.orders.size)
        // The held certificate is still served; the next try waits 6 h.
        assertNotNull(m.current("alice"))
        now += 3_600_000
        assertFalse(m.ensure("alice", "flagship.services", tlsKey, device, devicePub))
        assertEquals(2, issuer.orders.size)
        now += 6 * 3_600_000
        issuer.answer = PhoneCertIssuer.Answer.Issued(pem, now + 90L * 86_400_000)
        assertTrue(m.ensure("alice", "flagship.services", tlsKey, device, devicePub))
        assertEquals(3, issuer.orders.size)
    }

    @Test fun aChainForAnotherKeyIsNotKept() = runBlocking {
        val (_, chain) = selfSigned() ?: return@runBlocking assumeTrue("openssl not available", false)
        val (otherKey, otherChain) = selfSigned() ?: return@runBlocking
        val pem = "-----BEGIN CERTIFICATE-----\n" + Base64.getMimeEncoder().encodeToString(chain[0].encoded) + "\n-----END CERTIFICATE-----\n"
        val tlsKey = PhoneTlsKey(otherKey, PhoneTlsKey.uncompressed(otherChain[0].publicKey as ECPublicKey), "test")
        val store = PhoneCertStore(MemPrefs())
        val m = PhoneCertManager(store, FakeIssuer(PhoneCertIssuer.Answer.Issued(pem, 1_900_000_000_000)), now = { 1_800_000_000_000 })
        val seed = ByteArray(32) { 6 }
        assertFalse(m.ensure("alice", "flagship.services", tlsKey, Ed25519Sign(seed), HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)))
        assertEquals(null, m.current("alice"))
    }
}

class PhoneTunnelClientTest {
    @Test fun beginsSignsTheOfferedClaimAndReportsTheGrant() {
        val server = MockWebServer()
        val claims = LinkedBlockingQueue<String>()
        val claimCount = java.util.concurrent.atomic.AtomicInteger()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send("""{"type":"hello","relayId":"r","serverTime":1}""")
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = Json.parseToJsonElement(text).jsonObject
                when (m["type"]!!.jsonPrimitive.content) {
                    "begin" -> webSocket.send("""{"type":"challenge","account":"alice","hostname":"$HOST","generation":4,"sessionNonce":"${"5a".repeat(16)}","serverTime":1,"expiresAt":2}""")
                    "claim" -> {
                        claims.add(text)
                        if (claimCount.incrementAndGet() == 1) {
                            webSocket.send("""{"type":"refused","code":"route-held","generation":3}""")
                            webSocket.send("""{"type":"route-vacant","hostname":"$HOST","generation":3}""")
                        } else {
                            webSocket.send("""{"type":"granted","hostname":"$HOST","generation":4,"leaseMs":60000}""")
                        }
                    }
                    "release" -> {
                        claims.add(text)
                        webSocket.send("""{"type":"released","hostname":"$HOST","generation":4,"confirmed":true}""")
                    }
                }
            }
        }))
        server.start()
        val seed = ByteArray(32) { 6 }
        val pub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)
        val states = LinkedBlockingQueue<PhoneTunnelState>()
        val client = PhoneTunnelClient(
            okHttp = OkHttpClient(),
            url = server.url("/phone-tunnel").toString().replace("http", "ws"),
            account = "alice",
            apex = "flagship.services",
            deviceKey = Ed25519Sign(seed),
            deviceKeyPub = pub,
            tls = SSLContext.getDefault(),
            endpoint = PhoneEndpoint("alice", HOST, pub),
            now = { 1_800_000_000_000 },
            onState = { states.add(it) },
        )
        try {
            client.start()
            assertNotNull(claims.poll(5, TimeUnit.SECONDS))
            val text = claims.poll(5, TimeUnit.SECONDS)
            assertNotNull(text)
            val o = Json.parseToJsonElement(text!!).jsonObject
            val c = o["claim"]!!.jsonObject
            val claim = RouteClaim(c["account"]!!.jsonPrimitive.content, c["phoneRoutePub"]!!.jsonPrimitive.content, c["hostname"]!!.jsonPrimitive.content, c["generation"]!!.jsonPrimitive.long, c["sessionNonce"]!!.jsonPrimitive.content, c["issuedAt"]!!.jsonPrimitive.long)
            assertEquals(RouteClaim("alice", pub, HOST, 4, "5a".repeat(16), 1_800_000_000_000), claim)
            Ed25519Verify(HexUtil.decode(pub)!!).verify(HexUtil.decode(o["signature"]!!.jsonPrimitive.content)!!, PhoneRoute.canonical(claim))
            val seen = ArrayList<PhoneTunnelState>()
            repeat(20) { states.poll(250, TimeUnit.MILLISECONDS)?.let(seen::add) }
            assertTrue(seen.toString(), PhoneTunnelState.Standby(3) in seen)
            assertTrue(seen.toString(), PhoneTunnelState.Holding(4) in seen)
            // A voluntary release is signed over the held claim.
            assertTrue(client.release())
            val relText = claims.poll(5, TimeUnit.SECONDS)!!
            val rel = Json.parseToJsonElement(relText).jsonObject
            val r = rel["release"]!!.jsonObject
            val released = RouteClaim(r["account"]!!.jsonPrimitive.content, r["phoneRoutePub"]!!.jsonPrimitive.content, r["hostname"]!!.jsonPrimitive.content, r["generation"]!!.jsonPrimitive.long, r["sessionNonce"]!!.jsonPrimitive.content, r["issuedAt"]!!.jsonPrimitive.long)
            assertEquals(claim, released)
            assertTrue(PhoneRoute.verify(PhoneRoute.canonicalRelease(released), rel["signature"]!!.jsonPrimitive.content, pub))
        } finally {
            client.stop()
            runCatching { server.shutdown() }
        }
    }

    @Test fun aChallengeForAnotherNameIsNotSigned() {
        val seed = ByteArray(32) { 6 }
        val pub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey)
        val client = PhoneTunnelClient(OkHttpClient(), "ws://127.0.0.1:1/phone-tunnel", "alice", "flagship.services", Ed25519Sign(seed), pub, SSLContext.getDefault(), PhoneEndpoint("alice", HOST, pub))
        val other = Json.parseToJsonElement("""{"type":"challenge","account":"alice","hostname":"bob.flagship.services","generation":1,"sessionNonce":"${"5a".repeat(16)}"}""").jsonObject
        assertEquals(null, client.claimFor(other))
        val box = Json.parseToJsonElement("""{"type":"challenge","account":"alice","hostname":"home.alice.flagship.services","generation":1,"sessionNonce":"${"5a".repeat(16)}"}""").jsonObject
        assertEquals(null, client.claimFor(box))
    }
}
