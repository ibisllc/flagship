package com.flagshipserver.app.core

import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File

class LiveDevicePairingRelayTest {
    private lateinit var relay: FakeQrRelayServer
    private val client = OkHttpClient()

    @Before fun setUp() {
        relay = FakeQrRelayServer().also { it.start() }
    }

    @After fun tearDown() {
        relay.stop()
        client.dispatcher.executorService.shutdown()
    }

    private fun admin(timeoutMs: Long = 20_000L) =
        LiveAdminPairingRelay(client, host = { relay.host }, secure = { false }, returnLegTimeoutMs = timeoutMs)

    private fun incoming() = LiveIncomingPairingRelay(client, host = { relay.host }, secure = { false })

    private fun hello(session: QrSession, devicePub: ByteArray = ByteArray(32) { (it + 1).toByte() }, deviceId: ByteArray = ByteArray(16) { (0xf0 + it).toByte() }) =
        session.phonePubKey + devicePub + deviceId

    private fun <T> blocking(block: suspend kotlinx.coroutines.CoroutineScope.() -> T): T =
        runBlocking { withTimeout(30_000) { block() } }

    private suspend fun awaitBrowser(sid: String) {
        repeat(500) {
            if (relay.hasBrowser(sid)) return
            delay(10)
        }
        fail("admin never reached the relay")
    }

    private inline fun <reified E : Throwable> assertFailsWith(block: () -> Unit): E {
        try {
            block()
        } catch (t: Throwable) {
            if (t is E) return t
            throw t
        }
        fail("expected ${E::class.simpleName}")
        error("unreachable")
    }

    @Test fun happyPath_bothRolesInteroperate_sasMatches_bundleOpens() = blocking {
        val adminKeys = QrSession.fresh()
        val incomingKeys = QrSession.fresh()
        val adminRelay = admin().also { it.attachSession(adminKeys) }
        val incomingRelay = incoming().also { it.attachSession(incomingKeys, adminKeys.phonePubKey) }
        val sid = "sid-happy"

        val adminHello: Deferred<ByteArray> = async(Dispatchers.IO) { adminRelay.awaitPeerHello(sid) }
        awaitBrowser(sid)
        val sent = hello(incomingKeys)
        incomingRelay.connectAndHello(sid, sent)
        val received = adminHello.await()

        assertArrayEquals("admin sees x25519 || device pub || device id", sent, received)
        val incomingSas = incomingKeys.pair(adminKeys.phonePubKey)
        assertEquals(adminKeys.matchCode, incomingSas)
        assertEquals(6, incomingSas.length)

        val bundle = """{"umkSeedHex":"${"cd".repeat(32)}"}""".toByteArray()
        val sealed = adminKeys.seal(bundle)
        adminRelay.deliver(sealed.ciphertextB64u, sealed.nonceB64u)
        val (ct, nonce) = incomingRelay.awaitDelivery()
        assertArrayEquals(bundle, incomingKeys.open(ct, nonce))

        val leg1Deliver = relay.frameLog.single { it.startsWith("$sid/phone:") && "\"deliver\"" in it }
        assertFalse("the relay must only ever see ciphertext", "devicePubHex" in leg1Deliver)
        adminRelay.close()
        incomingRelay.close()
    }

    @Test fun leg1DeliverCarriesTheWebPayloadShape() = blocking {
        val adminKeys = QrSession.fresh()
        val incomingKeys = QrSession.fresh()
        val adminRelay = admin().also { it.attachSession(adminKeys) }
        val incomingRelay = incoming().also { it.attachSession(incomingKeys, adminKeys.phonePubKey) }
        val sid = "sid-shape"
        val adminHello = async(Dispatchers.IO) { adminRelay.awaitPeerHello(sid) }
        awaitBrowser(sid)
        incomingRelay.connectAndHello(sid, hello(incomingKeys))
        adminHello.await()

        val frame = relay.frameLog.single { it.startsWith("$sid/phone:") && "\"deliver\"" in it }
        val json = Json.parseToJsonElement(frame.substringAfter(":")).jsonObject
        val plain = adminKeys.open(json["ciphertext"]!!.jsonPrimitive.content, json["nonce"]!!.jsonPrimitive.content)
        val obj = Json.parseToJsonElement(plain.decodeToString()).jsonObject
        assertEquals(setOf("devicePubHex", "deviceId", "returnSid", "returnPkB64u"), obj.keys)
        assertEquals(HexUtil.encode(ByteArray(32) { (it + 1).toByte() }), obj["devicePubHex"]!!.jsonPrimitive.content)
        assertEquals(32, obj["deviceId"]!!.jsonPrimitive.content.length)
        assertEquals(32, Base64URL.decode(obj["returnPkB64u"]!!.jsonPrimitive.content)!!.size)
        val helloFrame = relay.frameLog.single { it.startsWith("$sid/phone:") && "\"hello\"" in it }
        assertEquals(
            Base64URL.encode(incomingKeys.phonePubKey),
            Json.parseToJsonElement(helloFrame.substringAfter(":")).jsonObject["phonePk"]!!.jsonPrimitive.content,
        )
        adminRelay.close()
        incomingRelay.close()
    }

    @Test fun peerMissing_whenAdminHasNotOpenedTheSession() = blocking {
        val keys = QrSession.fresh()
        val adminKeys = QrSession.fresh()
        val incomingRelay = incoming().also { it.attachSession(keys, adminKeys.phonePubKey) }
        val err = try {
            incomingRelay.connectAndHello("sid-nobody", hello(keys))
            null
        } catch (e: PairingRelayError) {
            e
        }
        assertEquals(PairingRelayError.PeerMissing, err)
        incomingRelay.close()
    }

    @Test fun wrongKey_adminRejectsAPayloadSealedUnderADifferentSecret() = blocking {
        val adminKeys = QrSession.fresh()
        val incomingKeys = QrSession.fresh()
        val attacker = QrSession.fresh()
        val adminRelay = admin().also { it.attachSession(adminKeys) }
        val incomingRelay = incoming().also { it.attachSession(incomingKeys, attacker.phonePubKey) }
        val sid = "sid-wrongkey"
        val adminHello = async(Dispatchers.IO) { runCatching { adminRelay.awaitPeerHello(sid) } }
        awaitBrowser(sid)
        incomingRelay.connectAndHello(sid, hello(incomingKeys))
        val failure = adminHello.await().exceptionOrNull()
        assertTrue("wrong-key payload must be rejected: $failure", failure is PairingRelayError.RelayErr)
        adminRelay.close()
        incomingRelay.close()
    }

    @Test fun tamperedBundle_failsToOpenOnTheIncomingSide() = blocking {
        val adminKeys = QrSession.fresh()
        val incomingKeys = QrSession.fresh()
        val adminRelay = admin().also { it.attachSession(adminKeys) }
        val incomingRelay = incoming().also { it.attachSession(incomingKeys, adminKeys.phonePubKey) }
        val sid = "sid-tamper"
        val adminHello = async(Dispatchers.IO) { adminRelay.awaitPeerHello(sid) }
        awaitBrowser(sid)
        incomingRelay.connectAndHello(sid, hello(incomingKeys))
        adminHello.await()
        incomingKeys.pair(adminKeys.phonePubKey)

        val sealed = adminKeys.seal("""{"umkSeedHex":"00"}""".toByteArray())
        val ct = Base64URL.decode(sealed.ciphertextB64u)!!.also { it[0] = (it[0].toInt() xor 1).toByte() }
        adminRelay.deliver(Base64URL.encode(ct), sealed.nonceB64u)
        val (gotCt, gotNonce) = incomingRelay.awaitDelivery()
        assertFailsWith<Exception> { incomingKeys.open(gotCt, gotNonce) }

        val stranger = QrSession.fresh().also { it.pair(adminKeys.phonePubKey) }
        val other = QrSession.fresh().also { it.pair(incomingKeys.phonePubKey) }
        val foreign = other.seal("x".toByteArray())
        assertFailsWith<Exception> { stranger.open(foreign.ciphertextB64u, foreign.nonceB64u) }
        adminRelay.close()
        incomingRelay.close()
    }

    @Test fun expiry_liveSessionSurfacesSessionExpired() = blocking {
        val adminKeys = QrSession.fresh()
        val adminRelay = admin().also { it.attachSession(adminKeys) }
        val sid = "sid-expire"
        val waiting = async(Dispatchers.IO) { runCatching { adminRelay.awaitPeerHello(sid) } }
        awaitBrowser(sid)
        relay.expireLive()
        assertEquals(PairingRelayError.SessionExpired, waiting.await().exceptionOrNull())
        adminRelay.close()
    }

    @Test fun expiry_aSessionTheRelayAlreadyExpiredIsRefused() = blocking {
        val adminKeys = QrSession.fresh()
        val incomingKeys = QrSession.fresh()
        relay.expireSid("sid-old")
        val adminErr = runCatching { admin().also { it.attachSession(adminKeys) }.awaitPeerHello("sid-old") }.exceptionOrNull()
        assertEquals(PairingRelayError.SessionExpired, adminErr)
        val incomingErr = runCatching {
            incoming().also { it.attachSession(incomingKeys, adminKeys.phonePubKey) }.connectAndHello("sid-old", hello(incomingKeys))
        }.exceptionOrNull()
        assertEquals(PairingRelayError.SessionExpired, incomingErr)
    }

    @Test fun noReturnChannel_deliverFailsWhenTheHelloOmittedIt() = blocking {
        val adminKeys = QrSession.fresh()
        val adminRelay = admin().also { it.attachSession(adminKeys) }
        val sid = "sid-noreturn"
        val adminHello = async(Dispatchers.IO) { adminRelay.awaitPeerHello(sid) }
        awaitBrowser(sid)

        val phoneKeys = QrSession.fresh().also { it.pair(adminKeys.phonePubKey) }
        val sock = PairingSocket(client, "ws://${relay.host}/qr-pipe/$sid?role=phone")
        sock.open()
        sock.send {
            put("kind", JsonPrimitive("hello"))
            put("phonePk", JsonPrimitive(Base64URL.encode(phoneKeys.phonePubKey)))
        }
        assertEquals("ack", sock.next().kind)
        val sealed = phoneKeys.seal(
            """{"devicePubHex":"${"ab".repeat(32)}","deviceId":"${"cd".repeat(16)}"}""".toByteArray(),
        )
        sock.send {
            put("kind", JsonPrimitive("deliver"))
            put("ciphertext", JsonPrimitive(sealed.ciphertextB64u))
            put("nonce", JsonPrimitive(sealed.nonceB64u))
        }
        adminHello.await()
        val err = runCatching { adminRelay.deliver("AAAA", "AAAA") }.exceptionOrNull()
        assertEquals(PairingRelayError.NoReturnChannel, err)
        sock.close()
        adminRelay.close()
    }

    @Test fun malformedDeviceIdentity_isRejectedByTheAdmin() = blocking {
        val adminKeys = QrSession.fresh()
        val adminRelay = admin().also { it.attachSession(adminKeys) }
        val sid = "sid-malformed"
        val adminHello = async(Dispatchers.IO) { runCatching { adminRelay.awaitPeerHello(sid) } }
        awaitBrowser(sid)
        val phoneKeys = QrSession.fresh().also { it.pair(adminKeys.phonePubKey) }
        val sock = PairingSocket(client, "ws://${relay.host}/qr-pipe/$sid?role=phone")
        sock.open()
        sock.send {
            put("kind", JsonPrimitive("hello"))
            put("phonePk", JsonPrimitive(Base64URL.encode(phoneKeys.phonePubKey)))
        }
        sock.next()
        val sealed = phoneKeys.seal("""{"devicePubHex":"zz","deviceId":"short","returnSid":"r","returnPkB64u":"k"}""".toByteArray())
        sock.send {
            put("kind", JsonPrimitive("deliver"))
            put("ciphertext", JsonPrimitive(sealed.ciphertextB64u))
            put("nonce", JsonPrimitive(sealed.nonceB64u))
        }
        assertTrue(adminHello.await().exceptionOrNull() is PairingRelayError.RelayErr)
        sock.close()
        adminRelay.close()
    }

    @Test fun returnLegNotListening_surfacesPeerMissing() = blocking {
        val adminKeys = QrSession.fresh()
        val incomingKeys = QrSession.fresh()
        val adminRelay = admin().also { it.attachSession(adminKeys) }
        val incomingRelay = incoming().also { it.attachSession(incomingKeys, adminKeys.phonePubKey) }
        val sid = "sid-gone"
        val adminHello = async(Dispatchers.IO) { adminRelay.awaitPeerHello(sid) }
        awaitBrowser(sid)
        incomingRelay.connectAndHello(sid, hello(incomingKeys))
        adminHello.await()
        incomingRelay.close()
        delay(200)
        val sealed = adminKeys.seal("x".toByteArray())
        val err = runCatching { adminRelay.deliver(sealed.ciphertextB64u, sealed.nonceB64u) }.exceptionOrNull()
        assertEquals(PairingRelayError.PeerMissing, err)
        adminRelay.close()
    }

    @Test fun unreachableRelay_isAConnectionFailure() = blocking {
        val adminKeys = QrSession.fresh()
        relay.stop()
        val err = runCatching {
            admin().also { it.attachSession(adminKeys) }.awaitPeerHello("sid-down")
        }.exceptionOrNull()
        assertTrue("got $err", err is PairingRelayError.ConnectionFailed)
        relay = FakeQrRelayServer().also { it.start() }
    }

    @Test fun goldenVectors_kotlinDerivesWhatTheWebDerived() {
        val v = Json.parseToJsonElement(vectorsFile().readText()).jsonObject
        fun str(k: String) = v[k]!!.jsonPrimitive.content
        val admin = QrSession.fromPrivateKey(requireNotNull(HexUtil.decode(str("adminPrivHex"))))
        val incoming = QrSession.fromPrivateKey(requireNotNull(HexUtil.decode(str("incomingPrivHex"))))
        assertEquals(str("adminPubB64u"), Base64URL.encode(admin.phonePubKey))
        assertEquals(str("incomingPubB64u"), Base64URL.encode(incoming.phonePubKey))

        assertEquals(str("sas"), admin.pair(incoming.phonePubKey))
        assertEquals(str("sas"), incoming.pair(admin.phonePubKey))

        for (name in listOf("leg1Payload", "bundle")) {
            val sealed = v[name]!!.jsonObject
            val plain = incoming.open(sealed["ciphertextB64u"]!!.jsonPrimitive.content, sealed["nonceB64u"]!!.jsonPrimitive.content)
            assertEquals(sealed["plaintext"]!!.jsonPrimitive.content, plain.decodeToString())
            admin.open(sealed["ciphertextB64u"]!!.jsonPrimitive.content, sealed["nonceB64u"]!!.jsonPrimitive.content)
        }

        val leg1 = (Json.parseToJsonElement(v["leg1Payload"]!!.jsonObject["plaintext"]!!.jsonPrimitive.content) as JsonObject)
        assertEquals(setOf("devicePubHex", "deviceId", "returnSid", "returnPkB64u"), leg1.keys)
    }

    private fun vectorsFile(): File {
        val rel = "test-vectors/device-pairing-relay.json"
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        repeat(12) {
            val f = dir?.let { File(it, rel) }
            if (f != null && f.isFile) return f
            dir = dir?.parentFile
        }
        fail("could not locate $rel")
        error("unreachable")
    }
}
