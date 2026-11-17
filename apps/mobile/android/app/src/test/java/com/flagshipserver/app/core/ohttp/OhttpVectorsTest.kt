// The Kotlin OHTTP client against packages/protocol/test-vectors/ohttp/ (vectors.json and spend-route.json):
// every case byte for byte, every negative, the spend routing rule and the relay fallback.

package com.flagshipserver.app.core.ohttp

import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.vectorsFile
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.bouncycastle.crypto.hpke.HPKE
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class OhttpVectorsTest {
    private val V by lazy { Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/ohttp/vectors.json").readText()).jsonObject }
    private val S by lazy { Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/ohttp/spend-route.json").readText()).jsonObject }
    private fun h(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun x(b: ByteArray) = b.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun headersOf(o: JsonObject) = o["headers"]!!.jsonArray.map { it.jsonArray[0].jsonPrimitive.content to it.jsonArray[1].jsonPrimitive.content }

    private val gw by lazy { V["gateway"]!!.jsonObject }
    private val cfg by lazy { Ohttp.keyConfigFromHex(gw.s("keyConfigHex"))!! }
    private val gwKey by lazy { Ohttp.gatewayKey(gw["keyId"]!!.jsonPrimitive.int, h(gw.s("secretHex"))) }

    @Test fun rfc9458ExampleReproduces() {
        val a = V["rfc9458"]!!.jsonObject
        val c = Ohttp.parseKeyConfig(h(a.s("keyConfigHex")))!!
        val e = Ohttp.encapsulateRequest(c, h(a.s("bhttpRequestHex")), h(a.s("ephemeralSecretHex")))
        assertEquals(a.s("encapsulatedRequestHex"), x(e.encapsulated))
        assertEquals(a.s("bhttpResponseHex"), x(Ohttp.decapsulateResponse(e.context, h(a.s("encapsulatedResponseHex")))))
        val gk = Ohttp.gatewayKey(1, h(a.s("gatewaySecretHex")))
        assertArrayEquals(c.publicKey, gk.publicKey)
        val (req, ctx) = Ohttp.decapsulateRequest(listOf(gk), e.encapsulated)
        assertEquals(a.s("bhttpRequestHex"), x(req))
        assertEquals(a.s("encapsulatedResponseHex"), x(Ohttp.encapsulateResponse(ctx, h(a.s("bhttpResponseHex")), h(a.s("responseNonceHex")))))
    }

    @Test fun gatewayKeyMatchesItsPublishedConfig() {
        assertEquals(gw.s("publicKeyHex"), x(gwKey.publicKey))
        assertEquals(gw.s("keyConfigHex"), x(Ohttp.encodeKeyConfig(OhttpKeyConfig(gwKey.keyId, gwKey.publicKey))))
    }

    @Test fun everyCaseByteForByte() {
        for (el in V["cases"]!!.jsonArray) {
            val c = el.jsonObject
            val name = c.s("name")
            val r = c["request"]!!.jsonObject
            val bhttp = Ohttp.encodeBhttpRequest(
                BhttpRequest(r.s("method"), r.s("scheme"), r.s("authority"), r.s("path"), headersOf(r), r.s("bodyText").toByteArray()),
            )
            assertEquals(name, c.s("bhttpRequestHex"), x(bhttp))
            val back = Ohttp.decodeBhttpRequest(bhttp)
            assertEquals(name, r.s("path"), back.path)
            val e = Ohttp.encapsulateRequest(cfg, bhttp, h(c.s("ephemeralSecretHex")))
            assertEquals(name, c.s("encapsulatedRequestHex"), x(e.encapsulated))
            val (inner, gctx) = Ohttp.decapsulateRequest(listOf(gwKey), e.encapsulated)
            assertArrayEquals(name, bhttp, inner)
            assertEquals(name, c.s("encapsulatedResponseHex"), x(Ohttp.encapsulateResponse(gctx, h(c.s("bhttpResponseHex")), h(c.s("responseNonceHex")))))
            val res = Ohttp.decodeBhttpResponse(Ohttp.decapsulateResponse(e.context, h(c.s("encapsulatedResponseHex"))))
            val want = c["response"]!!.jsonObject
            assertEquals(name, want["status"]!!.jsonPrimitive.int, res.status)
            assertEquals(name, want.s("bodyText"), res.body.toString(Charsets.UTF_8))
            assertEquals(name, headersOf(want), res.headers)
            assertEquals(name, c.s("bhttpResponseHex"), x(Ohttp.encodeBhttpResponse(res)))
        }
    }

    /** Cross-check: BouncyCastle's own HPKE opens what our client sealed. */
    @Test fun bouncyCastleHpkeOpensOurRequest() {
        val c = V["cases"]!!.jsonArray[0].jsonObject
        val e = Ohttp.encapsulateRequest(cfg, h(c.s("bhttpRequestHex")), h(c.s("ephemeralSecretHex")))
        val hpke = HPKE(HPKE.mode_base, HPKE.kem_X25519_SHA256, HPKE.kdf_HKDF_SHA256, HPKE.aead_AES_GCM128)
        val kp = hpke.deserializePrivateKey(gwKey.privateKey, gwKey.publicKey)
        val hdr = e.encapsulated.copyOfRange(0, 7)
        val enc = e.encapsulated.copyOfRange(7, 39)
        val info = "message/bhttp request".toByteArray() + byteArrayOf(0) + hdr
        val ctx = hpke.setupBaseR(enc, kp, info)
        val pt = ctx.open(ByteArray(0), e.encapsulated.copyOfRange(39, e.encapsulated.size))
        assertEquals(c.s("bhttpRequestHex"), x(pt))
    }

    @Test fun refusesTheNegatives() {
        val c0 = V["cases"]!!.jsonArray[0].jsonObject
        val e = Ohttp.encapsulateRequest(cfg, h(c0.s("bhttpRequestHex")), h(c0.s("ephemeralSecretHex")))
        val negs = V["negatives"]!!.jsonObject
        for (n in negs["responses"]!!.jsonArray) {
            try {
                Ohttp.decapsulateResponse(e.context, h(n.jsonObject.s("encapsulatedResponseHex")))
                fail("accepted ${n.jsonObject.s("name")}")
            } catch (_: OhttpException) {
            }
        }
        for (k in negs["keyConfigs"]!!.jsonArray) assertNull(k.jsonObject.s("name"), Ohttp.parseKeyConfig(h(k.jsonObject.s("hex"))))
    }

    @Test fun spendRoute() {
        assertEquals(S["directBeforeLapseMs"]!!.jsonPrimitive.long, OhttpPrivacy.DIRECT_BEFORE_LAPSE_MS)
        for (el in S["route"]!!.jsonArray) {
            val r = el.jsonObject
            val lapse = r["lapseInMs"].let { if (it is JsonNull) null else it!!.jsonPrimitive.long }
            assertEquals(r.toString(), r["mayGoDirect"]!!.jsonPrimitive.boolean, OhttpPrivacy.spendMayGoDirect(PrivateSpendKind.of(r.s("kind")), lapse))
        }
    }

    @Test fun lapseBackoffHostsConfig() {
        for (el in S["lapse"]!!.jsonArray) {
            val l = el.jsonObject
            val want = l["lapseInMs"].let { if (it is JsonNull) null else it!!.jsonPrimitive.long }
            assertEquals(l.toString(), want, OhttpPrivacy.planLapseInMs(l["paidUntil"]!!.jsonPrimitive.long, l["graceMs"]!!.jsonPrimitive.long, l["now"]!!.jsonPrimitive.long))
        }
        for (el in S["backoff"]!!.jsonArray) {
            val b = el.jsonObject
            assertEquals(b.toString(), b["retryAfterMs"]!!.jsonPrimitive.long, OhttpPrivacy.relayRetryAfterMs(b["failures"]!!.jsonPrimitive.int))
        }
        for (el in S["relayHosts"]!!.jsonArray) {
            val c = el.jsonObject
            assertEquals(c.s("host"), c["forbidden"]!!.jsonPrimitive.boolean, OhttpPrivacy.isForbiddenRelayHost(c.s("host"), "flagshipserver.com"))
        }
        for (el in S["config"]!!.jsonArray) {
            val c = el.jsonObject
            val got = OhttpPrivacy.parsePublicConfig(c["input"], c.s("controlApex"))
            val want = c["expected"]!!.jsonObject
            assertEquals(c.s("name"), want["keyConfigHex"].let { if (it is JsonNull) null else it!!.jsonPrimitive.content }, got.keyConfigHex)
            val relays = want["relays"]!!.jsonArray.map { r ->
                val o = r.jsonObject
                OhttpRelayEntry(o.s("url"), o.s("operator"), o["interim"]!!.jsonPrimitive.boolean)
            }
            assertEquals(c.s("name"), relays, got.relays)
        }
    }

    // ---- sendThroughRelays: failure handling (the TS suite's cases)

    private val url = "https://flagshipserver.com/api/vouchers/redeem"
    private val req = PrivateRequest(url, "POST", listOf("content-type" to "application/json"), "{}".toByteArray())

    private fun fake(down: Set<String>, seen: MutableList<String>, gatewayUp: () -> Boolean = { true }) = RawHttp { _, u, headers, body ->
        val mark = headers.firstOrNull { it.first == OhttpClient.RELAY_FALLBACK_HEADER }?.second
        seen += u + (mark?.let { "#$it" } ?: "")
        if (u in down) throw java.io.IOException("ECONNREFUSED")
        if (u.startsWith("https://relay")) {
            if (!gatewayUp()) return@RawHttp RawHttpResponse(502, mapOf("content-type" to "text/plain"), ByteArray(0))
            val (inner, ctx) = Ohttp.decapsulateRequest(listOf(gwKey), body!!)
            val r = Ohttp.decodeBhttpRequest(inner)
            assertEquals("/api/vouchers/redeem", r.path)
            assertEquals("flagshipserver.com", r.authority)
            assertEquals(listOf("content-type" to "application/json"), r.headers)
            val res = Ohttp.encodeBhttpResponse(BhttpResponse(409, listOf("content-type" to "application/json"), """{"code":"voucher-spent"}""".toByteArray()))
            return@RawHttp RawHttpResponse(200, mapOf("Content-Type" to "message/ohttp-res"), Ohttp.encapsulateResponse(ctx, res))
        }
        RawHttpResponse(200, mapOf("content-type" to "application/json"), "{}".toByteArray())
    }

    @Test fun firstRelayThatAnswersAndItsInnerAnswerIsFinal() = runBlocking {
        val seen = mutableListOf<String>()
        val r = OhttpClient.sendThroughRelays(fake(setOf("https://relay-a/"), seen), req, cfg, listOf("https://relay-a/", "https://relay-b/"), { false })
        assertEquals("ohttp", r.path)
        assertEquals("https://relay-b/", r.relay)
        assertEquals(409, r.status)
        assertEquals(listOf("https://relay-a/", "https://relay-b/"), seen)
    }

    @Test fun relayDownThrowsOrGoesDirectMarked() = runBlocking {
        val down = setOf("https://relay-a/")
        try {
            OhttpClient.sendThroughRelays(fake(down, mutableListOf()), req, cfg, listOf("https://relay-a/"), { false })
            fail("went direct")
        } catch (e: RelayUnavailableException) {
            assertEquals("relay-unreachable", e.reason)
        }
        val seen = mutableListOf<String>()
        val r = OhttpClient.sendThroughRelays(fake(down, seen), req, cfg, listOf("https://relay-a/"), { true })
        assertEquals("direct", r.path)
        assertEquals("relay-unreachable", r.fallbackReason)
        assertEquals("$url#relay-unreachable", seen[1])
    }

    @Test fun gatewayDownIsARelayFailureAndRecovers() = runBlocking {
        var up = false
        try {
            OhttpClient.sendThroughRelays(fake(emptySet(), mutableListOf()) { up }, req, cfg, listOf("https://relay-a/"), { false })
            fail("went direct")
        } catch (e: RelayUnavailableException) {
            assertEquals("relay-502", e.reason)
        }
        up = true
        assertEquals("ohttp", OhttpClient.sendThroughRelays(fake(emptySet(), mutableListOf()) { up }, req, cfg, listOf("https://relay-a/"), { false }).path)
    }

    @Test fun badResponseAndTimeout() = runBlocking {
        val garbage = RawHttp { _, u, _, _ ->
            if (u.startsWith("https://relay")) RawHttpResponse(200, mapOf("content-type" to "message/ohttp-res"), ByteArray(40)) else RawHttpResponse(200, emptyMap(), ByteArray(0))
        }
        try {
            OhttpClient.sendThroughRelays(garbage, req, cfg, listOf("https://relay-a/"), { false })
            fail()
        } catch (e: RelayUnavailableException) {
            assertEquals("relay-bad-response", e.reason)
        }
        val wrongType = RawHttp { _, _, _, _ -> RawHttpResponse(200, mapOf("content-type" to "application/json"), ByteArray(40)) }
        try {
            OhttpClient.sendThroughRelays(wrongType, req, cfg, listOf("https://relay-a/"), { false })
            fail()
        } catch (e: RelayUnavailableException) {
            assertEquals("relay-bad-response", e.reason)
        }
        val slow = RawHttp { _, _, _, _ -> kotlinx.coroutines.delay(5_000); RawHttpResponse(200, emptyMap(), ByteArray(0)) }
        try {
            OhttpClient.sendThroughRelays(slow, req, cfg, listOf("https://relay-a/"), { false }, timeoutMs = 50)
            fail()
        } catch (e: RelayUnavailableException) {
            assertEquals("relay-timeout", e.reason)
        }
    }

    @Test fun noRelayConfiguredGoesDirectUnmarkedAndAlwaysAllowed() = runBlocking {
        val seen = mutableListOf<String>()
        var asked: String? = null
        val r = OhttpClient.sendThroughRelays(fake(emptySet(), seen), req, null, emptyList(), { asked = it; false })
        assertNull(asked)
        assertEquals("direct", r.path)
        assertEquals("unconfigured", r.fallbackReason)
        assertEquals(listOf(url), seen)
        assertTrue(OhttpClient.sendThroughRelays(fake(emptySet(), mutableListOf()), req, cfg, emptyList(), { asked = it; false }).path == "direct")
        assertNull(asked)
    }
}
