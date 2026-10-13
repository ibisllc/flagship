// The key step's free-credits row: on by default for an owner with no key of
// their own, flips to the bring-your-own-key message when the credits run out,
// and hides itself when the balance can't be read.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.core.AiKeyStore
import com.flagshipserver.app.core.FreeAiClient
import com.flagshipserver.app.core.FreeAiMint
import com.flagshipserver.app.core.FreeAiService
import com.flagshipserver.app.core.FreeAiState
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.OkHttpJsonTransport
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class AiKeysFreeAiTest {

    private class Canned(var status: Int, var body: String) : JsonHttpTransport {
        override val json: Json = OkHttpJsonTransport.defaultJson
        override suspend fun execute(
            method: String, url: String, body: ByteArray?, contentType: String?,
            extraHeaders: Map<String, String>, accept: Set<Int>,
        ): HttpResponse {
            if (status !in accept) throw HttpException(status, this.body)
            return HttpResponse(status, this.body.toByteArray(), emptyMap())
        }
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = Unit
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R {
            val r = execute("POST", url, null, null, extraHeaders, setOf(200))
            return json.decodeFromString(responseSerializer, String(r.body))
        }
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = Unit
    }

    private fun service(t: Canned) = FreeAiService(
        client = FreeAiClient(t) { "https://flagshipserver.com" },
        signer = { Ed25519Sign(ByteArray(32) { 3 }) },
        username = { "harry" },
    )

    private val full = """{"available":true,"credits":{"usedTokens":0,"allowanceTokens":1000000,"remainingTokens":1000000}}"""

    @Before fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        AiKeyStore.attachForTest(ctx.getSharedPreferences("ai-keys-free-ai-test", Context.MODE_PRIVATE))
        AiKeyStore.clear()
    }

    @After fun tearDown() = AiKeyStore.clear()

    @Test fun autoUsesFreeCreditsOnlyWithoutOwnKeys() = runTest {
        val vm = AiKeysViewModel()
        vm.loadFreeAi(service(Canned(200, full)))
        assertTrue(vm.shouldAutoUseFreeAi())
        vm.add("anthropic", "sk-ant-abc123456789", "Personal", null)
        assertFalse(vm.shouldAutoUseFreeAi())
    }

    @Test fun usedUpFlipsTheRowToBringYourOwnKey() = runTest {
        val vm = AiKeysViewModel()
        val t = Canned(200, full)
        vm.loadFreeAi(service(t))
        t.status = 429
        t.body = """{"error":"Your free AI credits are used up. Add your own AI key to keep building.","code":"free-ai-used-up"}"""
        val r = vm.useFreeAi(service(t), "home.harry.flagship.services")
        assertTrue(r is FreeAiMint.UsedUp)
        val s = vm.freeAi.value as FreeAiState.Available
        assertTrue(s.usedUp)
        assertEquals(1_000_000L, s.credits.allowanceTokens)
        assertFalse(vm.shouldAutoUseFreeAi())
    }

    @Test fun aSuccessfulMintUpdatesTheBalance() = runTest {
        val vm = AiKeysViewModel()
        val t = Canned(
            200,
            """{"ok":true,"credential":{"provider":"flagship","apiKey":"v1.a.b","baseUrl":"https://inference.flagshipserver.com","source":"promo","relay":true},"model":"flagship-free","expiresAt":1,"credits":{"usedTokens":10000,"allowanceTokens":1000000,"remainingTokens":990000}}""",
        )
        val r = vm.useFreeAi(service(t), "home.harry.flagship.services")
        assertTrue((r as FreeAiMint.Ok).credential.isFreeAi)
        assertEquals(990_000L, (vm.freeAi.value as FreeAiState.Available).credits.remainingTokens)
    }

    @Test fun aRefusalBlocksTheRowAndTheEndHidesIt() = runTest {
        val vm = AiKeysViewModel()
        val t = Canned(200, full)
        vm.loadFreeAi(service(t))
        t.status = 429
        t.body = """{"error":"Free building is busy today. Try again tomorrow, or use your own AI key.","code":"free-ai-busy-today"}"""
        assertTrue(vm.useFreeAi(service(t), "box") is FreeAiMint.Refused)
        assertEquals(FreeAiState.Blocked("busy-today"), vm.freeAi.value)
        assertFalse(vm.shouldAutoUseFreeAi())

        t.status = 410
        t.body = """{"code":"free-ai-ended"}"""
        vm.useFreeAi(service(t), "box")
        assertEquals(FreeAiState.Hidden, vm.freeAi.value)
        assertFalse(vm.shouldAutoUseFreeAi())
    }

    @Test fun anUnreadableBalanceHidesTheRow() = runTest {
        val vm = AiKeysViewModel()
        vm.loadFreeAi(service(Canned(500, "boom")))
        assertEquals(FreeAiState.Hidden, vm.freeAi.value)
        assertFalse(vm.shouldAutoUseFreeAi())
    }
}
