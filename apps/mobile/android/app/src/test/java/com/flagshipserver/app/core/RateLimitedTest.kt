// `.com`'s rate limiter (429 `error: "rate-limited"`): the sentence the app
// builds from `limit` + `retryAfterSec` (same words as apps/com/src/rateLimit.ts
// rateLimitedMessage), the transport and client mapping, and the screens'
// helpers (humanizer, free AI, username suggestion).

package com.flagshipserver.app.core

import com.flagshipserver.app.api.LiveFlagshipServerClient
import com.flagshipserver.app.viewmodels.SuggestUsernameViewModel
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException

class RateLimitedTest {

    private fun body(limit: String = "ip", sec: Int = 720, message: String = "server words") =
        """{"error":"rate-limited","endpoint":"username-claim","limit":"$limit","retryAfterSec":$sec,"message":"$message"}"""

    // ── Wording ────────────────────────────────────────────────────

    @Test fun eachAxisNamesWhoIsLimited() {
        assertEquals(
            "Too many tries from your network. Try again in about 12 minutes.",
            RateLimitCopy.sentence("ip", 720),
        )
        assertEquals(
            "Too many tries from this account. Try again in about 12 minutes.",
            RateLimitCopy.sentence("irk", 720),
        )
        assertEquals(
            "Too many tries for this account name. Try again in about 12 minutes.",
            RateLimitCopy.sentence("usernameHash", 720),
        )
    }

    @Test fun timeBoundaries() {
        val cases = listOf(
            0L to "in a minute",
            1L to "in a minute",
            59L to "in a minute",
            60L to "in about 1 minute",
            61L to "in about 2 minutes",
            120L to "in about 2 minutes",
            720L to "in about 12 minutes",
            3540L to "in about 59 minutes",
            3541L to "in about 1 hour",
            3600L to "in about 1 hour",
            5340L to "in about 1 hour",
            5341L to "in about 2 hours",
            7200L to "in about 2 hours",
            86400L to "in about 24 hours",
        )
        for ((sec, phrase) in cases) assertEquals("sec=$sec", phrase, RateLimitCopy.retryAfterPhrase(sec))
    }

    @Test fun fallsBackToTheServerMessageThenTheGenericLine() {
        assertEquals("server words", RateLimitCopy.message("someNewAxis", 720, "server words"))
        assertEquals("server words", RateLimitCopy.message("ip", null, "server words"))
        assertEquals(RateLimitCopy.FALLBACK, RateLimitCopy.message(null, null, null))
        assertEquals(RateLimitCopy.FALLBACK, RateLimitCopy.message(null, 30, "  "))
        assertEquals("Too many tries. Try again later.", RateLimitCopy.FALLBACK)
    }

    // ── Parsing ────────────────────────────────────────────────────

    @Test fun parsesTheRateLimitedBody() {
        val e = RateLimitedException.parse(429, body(limit = "irk", sec = 30))!!
        assertEquals(429, e.status)
        assertEquals("username-claim", e.endpoint)
        assertEquals("irk", e.limit)
        assertEquals(30L, e.retryAfterSec)
        assertEquals("server words", e.serverMessage)
        assertEquals("Too many tries from this account. Try again in a minute.", e.message)
        assertTrue(e is HttpException)
    }

    @Test fun onlyA429WithTheRateLimitedErrorCounts() {
        assertNull(RateLimitedException.parse(400, body()))
        assertNull(RateLimitedException.parse(429, """{"error":"wipe-restart rate-limited"}"""))
        assertNull(RateLimitedException.parse(429, """{"code":"free-ai-used-up","error":"Used up"}"""))
        assertNull(RateLimitedException.parse(429, """{"retryAfterMs":3000}"""))
        assertNull(RateLimitedException.parse(429, "Too Many Requests"))
        assertNull(RateLimitedException.parse(429, ""))
    }

    @Test fun retryAfterHeaderFillsAMissingRetryAfterSec() {
        val e = RateLimitedException.parse(429, """{"error":"rate-limited","limit":"ip"}""", "3600")!!
        assertEquals(3600L, e.retryAfterSec)
        assertEquals("Too many tries from your network. Try again in about 1 hour.", e.message)
        val noTime = RateLimitedException.parse(429, """{"error":"rate-limited","limit":"ip","message":"Slow down."}""")!!
        assertEquals("Slow down.", noTime.message)
    }

    @Test fun fromRecognisesPlainHttpExceptionsAndCauses() {
        val plain = HttpException(429, body(sec = 120))
        assertEquals("Too many tries from your network. Try again in about 2 minutes.", RateLimitedException.messageOf(plain))
        val wrapped = IllegalStateException("outer", IOException("inner", plain))
        assertEquals("Too many tries from your network. Try again in about 2 minutes.", RateLimitedException.messageOf(wrapped))
        assertNull(RateLimitedException.from(HttpException(429, """{"retryAfterMs":3000}""")))
        assertNull(RateLimitedException.from(IOException("offline")))
    }

    @Test fun humanizerShowsTheSentence() {
        val c = NetworkErrorHumanizer.classify(HttpException(429, body(limit = "usernameHash", sec = 900)))
        assertEquals(NetworkErrorHumanizer.Kind.RATE_LIMITED, c.kind)
        assertEquals("Too many tries for this account name. Try again in about 15 minutes.", c.message)
        // Any other 429 keeps the generic request copy.
        assertEquals(
            NetworkErrorHumanizer.Kind.REQUEST_PROBLEM,
            NetworkErrorHumanizer.classify(HttpException(429, "{}")).kind,
        )
    }

    // ── Transport + client ─────────────────────────────────────────

    private fun okHttpReturning(status: Int, json: String, retryAfter: String? = null): OkHttpJsonTransport {
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(status)
                .message("status $status")
                .apply { if (retryAfter != null) header("Retry-After", retryAfter) }
                .body(json.toResponseBody("application/json".toMediaType()))
                .build()
        }.build()
        return OkHttpJsonTransport(client)
    }

    @Test fun transportThrowsRateLimitedExceptionWithTheHeader() = runTest {
        val t = okHttpReturning(429, """{"error":"rate-limited","limit":"ip"}""", retryAfter = "300")
        try {
            t.execute("POST", "https://flagshipserver.test/api/accounts", ByteArray(0), "application/json")
            fail("expected a rate limit")
        } catch (e: RateLimitedException) {
            assertEquals(300L, e.retryAfterSec)
            assertEquals("Too many tries from your network. Try again in about 5 minutes.", e.message)
        }
    }

    @Test fun transportKeepsOtherErrorsPlain() = runTest {
        val t = okHttpReturning(429, """{"code":"free-ai-busy-today","error":"Busy"}""")
        try {
            t.execute("POST", "https://flagshipserver.test/api/free-ai/token", ByteArray(0), "application/json")
            fail("expected an HttpException")
        } catch (e: HttpException) {
            assertFalse(e is RateLimitedException)
            assertEquals(429, e.status)
        }
    }

    @Test fun clientCallsSurfaceTheSentence() = runTest {
        val client = LiveFlagshipServerClient(
            okHttpReturning(429, body(limit = "usernameHash", sec = 7200), retryAfter = "7200"),
            baseUrl = "https://flagshipserver.test",
        )
        try {
            client.resolveAccount("plucky-avocet")
            fail("expected a rate limit")
        } catch (e: RateLimitedException) {
            assertEquals("username-claim", e.endpoint)
            assertEquals("Too many tries for this account name. Try again in about 2 hours.", e.message)
        }
        try {
            client.fetchWrappedUmkWithToken("plucky-avocet", "00", 1L)
            fail("expected a rate limit")
        } catch (e: HttpException) {
            assertEquals(429, e.status)
            assertEquals(
                "Too many tries for this account name. Try again in about 2 hours.",
                NetworkErrorHumanizer.humanize(e),
            )
        }
    }

    @Test fun suggestUsernameTurnsTheLimiterIntoAThrottleWithItsSentence() = runTest {
        val client = LiveFlagshipServerClient(
            okHttpReturning(429, body(limit = "ip", sec = 720)),
            baseUrl = "https://flagshipserver.test",
        )
        val s = client.suggestUsername("abcd")
        assertTrue(s.throttled)
        assertNull(s.name)
        assertEquals(720_000, s.retryAfterMs)
        assertEquals("Too many tries from your network. Try again in about 12 minutes.", s.message)

        val vm = SuggestUsernameViewModel(suggest = { client.suggestUsername(it) })
        vm.load()
        assertEquals("Too many tries from your network. Try again in about 12 minutes.", vm.error.value)
        assertEquals(720, vm.cooldownRemaining.value)
    }

    @Test fun suggestUsernameCooldownThrottleIsUnchanged() = runTest {
        val client = LiveFlagshipServerClient(
            okHttpReturning(429, """{"retryAfterMs":4000}"""),
            baseUrl = "https://flagshipserver.test",
        )
        val s = client.suggestUsername("abcd")
        assertTrue(s.throttled)
        assertEquals(4000, s.retryAfterMs)
        assertNull(s.message)
    }

    // ── Flagship Inference ─────────────────────────────────────────

    /** Throws [HttpException] for every request, like the test fakes elsewhere. */
    private class Refusing(private val status: Int, private val body: String) : JsonHttpTransport {
        override val json: Json = OkHttpJsonTransport.defaultJson
        override suspend fun execute(
            method: String, url: String, body: ByteArray?, contentType: String?,
            extraHeaders: Map<String, String>, accept: Set<Int>,
        ): HttpResponse = throw HttpException(status, this.body)
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }

    private fun freeAi(t: JsonHttpTransport) = FreeAiService(
        client = FreeAiClient(t) { "https://flagshipserver.test" },
        signer = { Ed25519Sign(ByteArray(32) { 7 }) },
        username = { "harry" },
        now = { 1_700_000_000_000 },
    )

    @Test fun freeAiStatusShowsTheRateLimit() = runTest {
        val s = freeAi(Refusing(429, body(limit = "irk", sec = 600))).status()
        assertEquals(FreeAiState.Limited("Too many tries from this account. Try again in about 10 minutes."), s)
        val view = FreeAiCopy.view(s)!!
        assertFalse(view.usable)
        assertEquals("Too many tries from this account. Try again in about 10 minutes.", view.text)
    }

    @Test fun freeAiTokenShowsTheRateLimitNotUsedUp() = runTest {
        val m = freeAi(okHttpReturning(429, body(limit = "irk", sec = 600))).mint("home.harry.flagship.services")
        assertEquals(
            FreeAiMint.Refused(FreeAiCopy.CODE_RATE_LIMITED, "Too many tries from this account. Try again in about 10 minutes."),
            m,
        )
        val stop = freeAi(Refusing(429, body(limit = "irk", sec = 600))).passFor("home.harry.flagship.services")
        assertEquals(FreeAiRefresh.Stop("Too many tries from this account. Try again in about 10 minutes."), stop)
    }

    @Test fun freeAiUsedUpAndBusyKeepTheirOwnMeaning() = runTest {
        val usedUp = freeAi(Refusing(429, """{"code":"free-ai-used-up","error":"Used up for the week."}""")).mint("x")
        assertTrue(usedUp is FreeAiMint.UsedUp)
        val busy = freeAi(Refusing(429, """{"code":"free-ai-busy-today"}""")).mint("x")
        assertEquals(FreeAiMint.Refused(FreeAiCopy.CODE_BUSY_TODAY, FreeAiCopy.BUSY_TODAY), busy)
        val bare = freeAi(Refusing(429, "")).mint("x")
        assertTrue(bare is FreeAiMint.UsedUp)
    }
}
