// Flagship Inference client: the credits line shared with the webapp + iOS,
// the .com answers (credential / used up / unavailable), the signed body,
// on-by-default and the re-mint before a reply.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.LlmProviderCredential
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

    private val LINE = "1,840 free credits left · 500 added each week"

    private val weekly = FreeAiCreditsInfo(
        usedTokens = 660_000,
        allowanceTokens = 2_500_000,
        remainingTokens = 1_840_000,
        week = FreeAiWeek(used = 160_000, allowance = 500_000, remaining = 340_000, resetsAt = 1_760_918_400_000),
        starter = FreeAiStarter(used = 500_000, allowance = 2_000_000, remaining = 1_500_000),
        remainingCredits = 1_840,
        weeklyCredits = 500,
        tokensPerCredit = 1_000,
    )

    private var savedLocale: java.util.Locale = java.util.Locale.getDefault()

    @org.junit.Before fun pinLocale() {
        savedLocale = java.util.Locale.getDefault()
        java.util.Locale.setDefault(java.util.Locale.US)
    }

    @After fun restoreLocale() = java.util.Locale.setDefault(savedLocale)

    @Test fun showsCreditsLeftAndTheWeeklyTopUp() {
        assertEquals("0", FreeAiCopy.credits(0, java.util.Locale.US))
        assertEquals("1,840", FreeAiCopy.credits(1_840, java.util.Locale.US))
        assertEquals("1.234.567", FreeAiCopy.credits(1_234_567, java.util.Locale.GERMANY))
        assertEquals("0", FreeAiCopy.credits(-5, java.util.Locale.US))
        assertEquals(LINE, FreeAiCopy.leftLine(weekly))
        assertEquals("1.840 free credits left · 500 added each week", FreeAiCopy.leftLine(weekly, java.util.Locale.GERMANY))
        // An older .com sends only tokens: 1 credit = 1,000 weighted tokens.
        val tokensOnly = weekly.copy(remainingTokens = 1_840_999, remainingCredits = null, weeklyCredits = null, tokensPerCredit = null)
        assertEquals(LINE, FreeAiCopy.leftLine(tokensOnly))
        assertEquals("820 free credits left", FreeAiCopy.leftLine(FreeAiCreditsInfo(180_000, 1_000_000, 820_000)))
    }

    @Test fun decodesTheCreditFields() {
        val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
        val c = json.decodeFromString(
            FreeAiCreditsInfo.serializer(),
            """{"usedTokens":0,"allowanceTokens":2500000,"remainingTokens":2500000,"remainingCredits":2500,"weeklyCredits":500,"tokensPerCredit":1000}""",
        )
        assertEquals(2_500L, c.creditsLeft)
        assertEquals(500L, c.creditsPerWeek)
    }

    @Test fun saysFlagshipInferenceNotFreeAiCredits() {
        assertEquals("Flagship Inference", FreeAiCopy.TITLE)
        assertEquals("Use Flagship Inference →", FreeAiCopy.USE_BUTTON)
        assertEquals("Flagship Inference isn't available right now. You can add your own AI key.", FreeAiCopy.UNAVAILABLE)
        for (m in listOf(FreeAiCopy.USED_UP, FreeAiCopy.UNAVAILABLE, FreeAiCopy.BUSY_TODAY, FreeAiCopy.NO_SERVER, FreeAiCopy.TOO_LONG)) {
            assertTrue(m, m.contains("Flagship Inference"))
            assertFalse(m, m.lowercase().contains("free ai") || m.lowercase().contains("token"))
        }
    }

    @Test fun viewsMirrorTheWebapp() {
        assertNull(FreeAiCopy.view(FreeAiState.Hidden))
        assertEquals(
            FreeAiView(true, LINE, false),
            FreeAiCopy.view(FreeAiState.Available(weekly)),
        )
        val spent = weekly.copy(remainingTokens = 0)
        assertEquals(FreeAiView(false, FreeAiCopy.USED_UP, true), FreeAiCopy.view(FreeAiState.Available(spent)))
        assertEquals(FreeAiView(false, FreeAiCopy.BUSY_TODAY, true), FreeAiCopy.view(FreeAiState.Blocked("busy-today")))
        assertEquals(FreeAiView(false, FreeAiCopy.NO_SERVER, false), FreeAiCopy.view(FreeAiState.Blocked("no-server")))
        assertEquals(FreeAiView(false, FreeAiCopy.UNAVAILABLE, true), FreeAiCopy.view(FreeAiState.Unavailable))
        assertEquals(FreeAiView(false, FreeAiCopy.ENDED, true), FreeAiCopy.view(FreeAiState.Ended))
    }

    @Test fun flagshipInferenceCopyIsExact() {
        assertEquals("Flagship Inference", FreeAiCopy.PROVIDER_TITLE)
        assertEquals("We use third-party providers and anonymize your requests.", FreeAiCopy.PROVIDER_SUBTITLE)
        assertEquals("Flagship Inference. Built-in provider. It can't be removed.", FreeAiCopy.A11Y_LABEL)
        assertEquals(
            "This build is too big for Flagship Inference. Try a smaller change, or use your own AI key.",
            FreeAiCopy.TOO_LONG,
        )
        assertEquals(FreeAiCopy.TOO_LONG, FreeAiCopy.messageFor("free-ai-too-long"))
    }

    @Test fun theFlagshipInferenceEntryIsAlwaysListed() {
        assertEquals(FlagshipInferenceEntry(false, FreeAiCopy.CHECKING, false, loading = true), FreeAiCopy.entry(FreeAiState.Hidden))
        assertEquals(FlagshipInferenceEntry(true, LINE, false), FreeAiCopy.entry(FreeAiState.Available(weekly)))
        val spent = weekly.copy(remainingTokens = 0)
        assertEquals(FlagshipInferenceEntry(false, FreeAiCopy.USED_UP, true), FreeAiCopy.entry(FreeAiState.Available(spent)))
        assertEquals(FlagshipInferenceEntry(false, FreeAiCopy.BUSY_TODAY, true), FreeAiCopy.entry(FreeAiState.Blocked("busy-today")))
        assertEquals(FlagshipInferenceEntry(false, FreeAiCopy.NO_SERVER, false), FreeAiCopy.entry(FreeAiState.Blocked("no-server")))
        assertEquals(FlagshipInferenceEntry(false, FreeAiCopy.TOO_LONG, true), FreeAiCopy.entry(FreeAiState.Blocked("too-long")))
        assertEquals(FlagshipInferenceEntry(false, FreeAiCopy.UNAVAILABLE, true), FreeAiCopy.entry(FreeAiState.Unavailable))
        assertEquals(FlagshipInferenceEntry(false, FreeAiCopy.ENDED, true), FreeAiCopy.entry(FreeAiState.Ended))
    }

    @Test fun copyNeverSellsAnything() {
        for (s in listOf(
            FreeAiCopy.TITLE, FreeAiCopy.NOTE, FreeAiCopy.USED_UP, FreeAiCopy.UNAVAILABLE, FreeAiCopy.ADD_OWN_KEY,
            FreeAiCopy.BUSY_TODAY, FreeAiCopy.NO_SERVER, FreeAiCopy.ENDED,
            FreeAiCopy.PROVIDER_TITLE, FreeAiCopy.PROVIDER_SUBTITLE, FreeAiCopy.TOO_LONG,
        )) {
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
            .encodeToString(LlmProviderCredential.serializer(), LlmProviderCredential.from(r.credential))
        assertTrue(wire, wire.contains("\"source\":\"promo\""))
    }

    @Test fun mintMapsUsedUpAndUnavailable() = runTest {
        val t = FakeTransport(
            429,
            """{"error":"You've used this week's Flagship Inference credits. More arrive on Monday, or add your own AI key to keep building.","code":"free-ai-used-up","credits":{"usedTokens":1000000,"allowanceTokens":1000000,"remainingTokens":0}}""",
        )
        val used = service(t).mint("box")
        used as FreeAiMint.UsedUp
        assertEquals("You've used this week's Flagship Inference credits. More arrive on Monday, or add your own AI key to keep building.", used.message)
        assertEquals(0L, used.credits?.remainingTokens)

        t.status = 503
        t.body = """{"error":"Flagship Inference isn't available right now. You can add your own AI key.","code":"free-ai-unavailable"}"""
        assertTrue(service(t).mint("box") is FreeAiMint.Unavailable)
    }

    @Test fun mintMapsByCodeFirst() = runTest {
        // A 429 is "busy today" when .com says so, not "used up".
        val t = FakeTransport(429, """{"error":"Flagship Inference is busy today. Try again tomorrow, or use your own AI key.","code":"free-ai-busy-today"}""")
        val busy = service(t).mint("box")
        busy as FreeAiMint.Refused
        assertEquals("free-ai-busy-today", busy.code)
        assertEquals(FreeAiCopy.BUSY_TODAY, busy.message)

        t.status = 403
        t.body = """{"code":"free-ai-no-server"}"""
        assertEquals(FreeAiMint.Refused("free-ai-no-server", FreeAiCopy.NO_SERVER), service(t).mint("box"))

        t.status = 410
        t.body = """{"error":"The free building period has ended — use your own AI key.","code":"free-ai-ended"}"""
        assertEquals(FreeAiMint.Refused("free-ai-ended", FreeAiCopy.ENDED), service(t).mint("box"))

        t.status = 400
        t.body = """{"code":"free-ai-too-long"}"""
        assertEquals(FreeAiMint.Refused("free-ai-too-long", FreeAiCopy.TOO_LONG), service(t).mint("box"))

        // A bare 429 from an older .com still reads as used up.
        t.status = 429
        t.body = "{}"
        assertEquals(FreeAiCopy.USED_UP, (service(t).mint("box") as FreeAiMint.UsedUp).message)

        FreeAiSessions.remember("vc-free", "box")
        t.status = 410
        t.body = """{"code":"free-ai-ended"}"""
        assertEquals(FreeAiCopy.ENDED, (service(t).refreshFor("vc-free") as FreeAiRefresh.Stop).message)
    }

    @Test fun statusDecodesTheWeekTheReserveAndTheReasons() = runTest {
        val t = FakeTransport(
            200,
            """{"available":true,"ended":false,"reason":null,"credits":{"week":{"used":160000,"allowance":500000,"remaining":340000,"resetsAt":1760918400000},"starter":{"used":500000,"allowance":2000000,"remaining":1500000},"usedTokens":660000,"allowanceTokens":2500000,"remainingTokens":1840000,"remainingCredits":1840,"weeklyCredits":500,"tokensPerCredit":1000}}""",
        )
        val s = service(t).status() as FreeAiState.Available
        assertEquals(weekly, s.credits)
        assertTrue(FreeAiService.shouldAutoUse(0, s))

        t.body = """{"available":true,"ended":false,"reason":"busy-today","message":"busy","credits":{"remainingTokens":5}}"""
        val busy = service(t).status()
        assertEquals(FreeAiState.Blocked("busy-today"), busy)
        assertFalse(FreeAiService.shouldAutoUse(0, busy))

        t.body = """{"available":true,"ended":false,"reason":"no-server","credits":{"remainingTokens":5}}"""
        assertEquals(FreeAiState.Blocked("no-server"), service(t).status())

        // Ended: still listed but disabled, never used on its own.
        t.body = """{"available":false,"ended":true,"reason":null,"credits":{"remainingTokens":0}}"""
        val ended = service(t).status()
        assertEquals(FreeAiState.Ended, ended)
        assertFalse(FreeAiService.shouldAutoUse(0, ended))
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
        assertEquals(FreeAiState.Unavailable, service(t).status())
    }

    @Test fun onByDefaultOnlyWithoutOwnKeysAndWithCreditsLeft() {
        val left = FreeAiState.Available(FreeAiCreditsInfo(0, 1_000_000, 1_000_000))
        val none = FreeAiState.Available(FreeAiCreditsInfo(1_000_000, 1_000_000, 0))
        assertTrue(FreeAiService.shouldAutoUse(0, left))
        assertFalse(FreeAiService.shouldAutoUse(1, left))
        assertFalse(FreeAiService.shouldAutoUse(0, none))
        assertFalse(FreeAiService.shouldAutoUse(0, FreeAiState.Unavailable))
        assertFalse(FreeAiService.shouldAutoUse(0, FreeAiState.Hidden))
        assertFalse(FreeAiService.shouldAutoUse(0, FreeAiState.Ended))
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
        t.body = """{"error":"You've used this week's Flagship Inference credits. More arrive on Monday, or add your own AI key to keep building.","code":"free-ai-used-up"}"""
        val stop = service(t).refreshFor("vc-free")
        stop as FreeAiRefresh.Stop
        assertEquals("You've used this week's Flagship Inference credits. More arrive on Monday, or add your own AI key to keep building.", stop.message)
        // Without a message from .com the app's own copy is shown.
        t.body = "{}"
        assertEquals(FreeAiCopy.USED_UP, (service(t).refreshFor("vc-free") as FreeAiRefresh.Stop).message)

        FreeAiSessions.forget("vc-free")
        assertNull(FreeAiSessions.serverFor("vc-free"))
    }
}
