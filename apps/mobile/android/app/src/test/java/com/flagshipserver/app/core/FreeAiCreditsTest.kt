// Free AI credits client: the token formatter shared with the webapp + iOS,
// the .com answers (credential / used up / unavailable), the signed body,
// on-by-default and the re-mint before a reply.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.BuildCredential
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FreeAiCreditsTest {

    /** Answers every request with one programmed status + body. */
    private class FakeTransport(var status: Int, var body: String) : JsonHttpTransport {
        override val json: Json = OkHttpJsonTransport.defaultJson
        val urls = mutableListOf<String>()
        val bodies = mutableListOf<String>()

        override suspend fun execute(
            method: String, url: String, body: ByteArray?, contentType: String?,
            extraHeaders: Map<String, String>, accept: Set<Int>,
        ): HttpResponse {
            urls += url
            bodies += body?.toString(Charsets.UTF_8) ?: ""
            if (status !in accept) throw HttpException(status, this.body)
            return HttpResponse(status, this.body.toByteArray(), emptyMap())
        }

        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) {
            execute("POST", url, json.encodeToString(serializer, body).toByteArray(), "application/json", extraHeaders, accept)
        }

        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R {
            val r = execute("POST", url, json.encodeToString(serializer, body).toByteArray(), "application/json", extraHeaders, setOf(200))
            return json.decodeFromString(responseSerializer, String(r.body))
        }

        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R =
            error("unused")

        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }

    private val seed = ByteArray(32) { 7 }
    private val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey

    private fun service(t: FakeTransport, user: String? = "harry") = FreeAiService(
        client = FreeAiClient(t) { "https://flagshipserver.com" },
        signer = { Ed25519Sign(seed) },
        username = { user },
        now = { 1_700_000_000_000 },
    )

    private val okBody = """{"ok":true,"credential":{"provider":"flagship","apiKey":"v1.abc.def","baseUrl":"https://inference.flagshipserver.com","source":"promo","relay":true},"model":"flagship-free","expiresAt":1700043200000,"credits":{"usedTokens":180000,"allowanceTokens":1000000,"remainingTokens":820000}}"""

    @After fun tearDown() = FreeAiSessions.clear()

    @Test fun formatsTokenCounts() {
        assertEquals("0", FreeAiCopy.tokens(0))
        assertEquals("999", FreeAiCopy.tokens(999))
        assertEquals("1k", FreeAiCopy.tokens(1_000))
        assertEquals("820k", FreeAiCopy.tokens(820_000))
        assertEquals("1M", FreeAiCopy.tokens(1_000_000))
        assertEquals("1.5M", FreeAiCopy.tokens(1_500_000))
        assertEquals("2M", FreeAiCopy.tokens(2_000_000))
        assertEquals("0", FreeAiCopy.tokens(-5))
        assertEquals(
            "820k of 1M free AI tokens left",
            FreeAiCopy.leftLine(FreeAiCreditsInfo(180_000, 1_000_000, 820_000)),
        )
    }

    @Test fun copyNeverSellsAnything() {
        for (s in listOf(FreeAiCopy.TITLE, FreeAiCopy.NOTE, FreeAiCopy.USED_UP, FreeAiCopy.UNAVAILABLE, FreeAiCopy.ADD_OWN_KEY)) {
            val l = s.lowercase()
            assertFalse(s, l.contains("buy") || l.contains("purchase") || l.contains("upgrade") || l.contains("subscri"))
        }
    }

    @Test fun mintReturnsAPromoCredentialForTheBox() = runTest {
        val t = FakeTransport(200, okBody)
        val r = service(t).mint("home.harry.flagship.services")
        r as FreeAiMint.Ok
        assertEquals("flagship", r.credential.provider)
        assertEquals("promo", r.credential.source)
        assertTrue(r.credential.isFreeAi)
        assertEquals("flagship-free", r.credential.model)
        assertEquals("https://inference.flagshipserver.com", r.credential.baseUrl)
        assertEquals(820_000L, r.credits?.remainingTokens)
        assertEquals("https://flagshipserver.com/api/free-ai/token", t.urls.single())
        // The signed body verifies under the signer's key over the canonical bytes.
        val sent = Json.decodeFromString(FreeAiSignedBody.serializer(), t.bodies.single())
        assertEquals("home.harry.flagship.services", sent.request.serverFqdn)
        assertEquals("flagship", sent.request.provider)
        Ed25519Verify(pub).verify(
            HexUtil.decode(sent.signature)!!,
            FreeAiRequest.canonicalBytes("harry", "home.harry.flagship.services", 1_700_000_000_000),
        )
        // The box gets the promo source on the wire.
        val wire = Json { encodeDefaults = false; explicitNulls = false }
            .encodeToString(BuildCredential.serializer(), BuildCredential.from(r.credential))
        assertTrue(wire, wire.contains("\"source\":\"promo\""))
    }

    @Test fun mintMapsUsedUpAndUnavailable() = runTest {
        val t = FakeTransport(
            429,
            """{"error":"Your free AI credits are used up. Add your own AI key to keep building.","code":"free-ai-used-up","credits":{"usedTokens":1000000,"allowanceTokens":1000000,"remainingTokens":0}}""",
        )
        val used = service(t).mint("box")
        used as FreeAiMint.UsedUp
        assertEquals("Your free AI credits are used up. Add your own AI key to keep building.", used.message)
        assertEquals(0L, used.credits?.remainingTokens)

        t.status = 503
        t.body = """{"error":"Free AI isn't available right now. You can add your own AI key.","code":"free-ai-unavailable"}"""
        assertTrue(service(t).mint("box") is FreeAiMint.Unavailable)
    }

    @Test fun mintWithoutAnAccountIsUnavailable() = runTest {
        val t = FakeTransport(200, okBody)
        assertTrue(service(t, user = null).mint("box") is FreeAiMint.Unavailable)
        assertTrue(t.urls.isEmpty())
    }

    @Test fun statusReadsAvailableUnavailableAndHidesFailures() = runTest {
        val t = FakeTransport(200, """{"available":true,"credits":{"usedTokens":0,"allowanceTokens":1000000,"remainingTokens":1000000}}""")
        val s = service(t).status()
        s as FreeAiState.Available
        assertFalse(s.usedUp)
        assertEquals("https://flagshipserver.com/api/free-ai/status", t.urls.single())
        assertEquals("", Json.decodeFromString(FreeAiSignedBody.serializer(), t.bodies.single()).request.serverFqdn)
        // .com refuses a request without the provider and both caps, which are default values here.
        assertTrue(t.bodies.single().contains("\"provider\":\"flagship\""))
        assertTrue(t.bodies.single().contains("\"desiredDailyInputTokenCap\":0"))
        assertTrue(t.bodies.single().contains("\"desiredDailyOutputTokenCap\":0"))

        t.body = """{"available":false}"""
        assertEquals(FreeAiState.Unavailable, service(t).status())

        t.status = 500
        assertEquals(FreeAiState.Hidden, service(t).status())
    }

    @Test fun onByDefaultOnlyWithoutOwnKeysAndWithCreditsLeft() {
        val left = FreeAiState.Available(FreeAiCreditsInfo(0, 1_000_000, 1_000_000))
        val none = FreeAiState.Available(FreeAiCreditsInfo(1_000_000, 1_000_000, 0))
        assertTrue(FreeAiService.shouldAutoUse(0, left))
        assertFalse(FreeAiService.shouldAutoUse(1, left))
        assertFalse(FreeAiService.shouldAutoUse(0, none))
        assertFalse(FreeAiService.shouldAutoUse(0, FreeAiState.Unavailable))
        assertFalse(FreeAiService.shouldAutoUse(0, FreeAiState.Hidden))
    }

    @Test fun refreshesOnlyForBuildsOnFreeCredits() = runTest {
        val t = FakeTransport(200, okBody)
        assertEquals(FreeAiRefresh.None, service(t).refreshFor("vc-own-key"))
        assertTrue(t.urls.isEmpty())

        FreeAiSessions.remember("vc-free", "home.harry.flagship.services")
        val fresh = service(t).refreshFor("vc-free")
        fresh as FreeAiRefresh.Fresh
        assertEquals("v1.abc.def", fresh.credential.apiKey)
        val sent = Json.decodeFromString(FreeAiSignedBody.serializer(), t.bodies.single())
        assertEquals("home.harry.flagship.services", sent.request.serverFqdn)

        t.status = 429
        t.body = """{"error":"Your free AI credits are used up. Add your own AI key to keep building.","code":"free-ai-used-up"}"""
        val stop = service(t).refreshFor("vc-free")
        stop as FreeAiRefresh.Stop
        assertEquals("Your free AI credits are used up. Add your own AI key to keep building.", stop.message)
        // Without a message from .com the app's own copy is shown.
        t.body = "{}"
        assertEquals(FreeAiCopy.USED_UP, (service(t).refreshFor("vc-free") as FreeAiRefresh.Stop).message)

        FreeAiSessions.forget("vc-free")
        assertNull(FreeAiSessions.serverFor("vc-free"))
    }
}
