// AI-run consent (N12): the box's 428 estimate is shown before anything runs; Continue resends the
// same request once with a signed flagship/ai-repair-consent/v1, Cancel sends nothing more.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockBuildClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.viewmodels.BuildGitViewModel
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AiConsentFlowTest {
    private val est = """{"provider":"anthropic","source":"byok","operation":"adapt","lowTokens":14000,"highTokens":84000,"unit":"tokens"}"""
    private val refusal = ScreensError.Http(428, """{"error":"consent-required","code":"ai-consent","estimate":$est}""")
    private val kp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 0x44 })

    @Test fun readsTheEstimateOnlyFromAnAiConsentRefusal() {
        val e = AiConsent.estimate(refusal)!!
        assertEquals(AiConsentEstimate("anthropic", AiRepairConsent.Source.BYOK, AiRepairConsent.Operation.ADAPT, 14000, 84000), e)
        assertNull(AiConsent.estimate(ScreensError.Http(403, """{"error":"nope"}""")))
        assertNull(AiConsent.estimate(ScreensError.Http(503, """{"code":"ai-consent","estimate":$est}""")))
        assertNull(AiConsent.estimate(ScreensError.Http(428, """{"code":"ai-consent","estimate":{"provider":"x","source":"free"}}""")))
    }

    @Test fun theSheetSaysWhoPays() {
        val e = AiConsent.estimate(refusal)!!
        assertEquals("Anthropic runs it with your own API key, so Anthropic bills you for it.", AiConsent.payerText(e))
        assertEquals(
            "Flagship Inference runs it, and it is paid from your free Flagship Inference credits.",
            AiConsent.payerText(e.copy(provider = "flagship", source = AiRepairConsent.Source.PROMO)),
        )
        assertEquals("This run can use up to about 84,000 tokens. The run stops there.", AiConsent.rangeText(e).replace('\u202f', ',').replace('\u00a0', ','))
    }

    @Test fun theConsentMatchesTheSharedVectors() {
        val v = Json.parseToJsonElement(java.io.File(vectorsPath()).readText()).jsonObject
        val first = v["orders"]!!.jsonArray.first().jsonObject
        val o = first["order"]!!.jsonObject
        val e = AiConsentEstimate(
            o["provider"]!!.jsonPrimitive.content,
            AiRepairConsent.Source.entries.first { it.wire == o["source"]!!.jsonPrimitive.content },
            AiRepairConsent.Operation.entries.first { it.wire == o["operation"]!!.jsonPrimitive.content },
            1, o["highTokens"]!!.jsonPrimitive.long,
        )
        val body = AiConsent.body(o["serverDomain"]!!.jsonPrimitive.content, o["buildId"]!!.jsonPrimitive.content, e, o["issuedAt"]!!.jsonPrimitive.long, Ed25519Sign(kp.privateKey))
        assertEquals(first["signatureHex"]!!.jsonPrimitive.content, body.signature)
    }

    private fun vectorsPath(): String {
        var dir = java.io.File(".").absoluteFile
        while (!java.io.File(dir, "packages/protocol/test-vectors/ai-repair-consent/vectors.json").exists()) dir = dir.parentFile
        return java.io.File(dir, "packages/protocol/test-vectors/ai-repair-consent/vectors.json").path
    }

    @Test fun continueResendsOnceWithASignedConsent() = runBlocking {
        val prompt = AiConsentPrompt()
        val sent = mutableListOf<AiConsentWire?>()
        val run = async {
            AiConsent.withConsent(prompt, "0123456789abcdef", { "Kitchen.Alice.flagship.services" }, { Ed25519Sign(kp.privateKey) }, { 1_760_000_000_000L }) { c ->
                sent += c
                if (c == null) throw refusal
                "started"
            }
        }
        val ask = prompt.ask.filterNotNull().first()
        assertEquals(84000, ask.estimate.highTokens)
        prompt.answer(true)
        assertEquals("started", run.await())
        assertEquals(2, sent.size)
        val c = sent[1]!!
        assertEquals(84000, c.highTokens)
        Ed25519Verify(kp.publicKey).verify(
            HexUtil.decode(c.signature)!!,
            AiRepairConsent.canonicalBytes("kitchen.alice.flagship.services", "0123456789abcdef", AiRepairConsent.Operation.ADAPT, "anthropic", AiRepairConsent.Source.BYOK, 84000, 1_760_000_000_000L),
        )
        assertNull(prompt.ask.value)
    }

    @Test fun cancelSendsNothingMore() = runBlocking {
        val prompt = AiConsentPrompt()
        var calls = 0
        var signed = false
        val run = async {
            AiConsent.withConsent(prompt, "0123456789abcdef", { "x.flagship.services" }, { signed = true; Ed25519Sign(kp.privateKey) }) { _ ->
                calls++
                throw refusal
            }
        }
        prompt.ask.filterNotNull().first()
        prompt.answer(false)
        assertNull(run.await())
        assertEquals(1, calls)
        assertTrue("no signature without a yes", !signed)
    }

    @Test fun aGrownEstimateAsksAgainWithTheBoxsReason() = runBlocking {
        val prompt = AiConsentPrompt()
        val grown = ScreensError.Http(403, """{"error":"the estimate grew since you agreed","code":"ai-consent","estimate":$est}""")
        var calls = 0
        val run = async {
            AiConsent.withConsent(prompt, "0123456789abcdef", { "x.flagship.services" }, { Ed25519Sign(kp.privateKey) }) { c ->
                calls++
                when (calls) {
                    1 -> throw refusal
                    2 -> throw grown
                    else -> "ok"
                }
            }
        }
        assertEquals("", prompt.ask.filterNotNull().first().note)
        prompt.answer(true)
        val again = prompt.ask.filterNotNull().first { it.note.isNotEmpty() }
        assertEquals("the estimate grew since you agreed", again.note)
        prompt.answer(true)
        assertEquals("ok", run.await())
    }

    @Test fun gitAdaptWaitsForTheOwnerThenRunsWithTheConsent() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0).apply { gitFitFixture = false; consentRequired = true }
        val vm = BuildGitViewModel(client, scope = backgroundScope, consentSigner = { Ed25519Sign(kp.privateKey) })
        vm.checkRepo("https://github.com/you/app", "").join()
        val key = com.flagshipserver.app.api.LlmProviderCredential(provider = "anthropic", apiKey = "sk-test")
        val job = vm.adapt(credential = key)
        val ask = vm.consent.ask.filterNotNull().first()
        assertEquals("anthropic", ask.estimate.provider)
        vm.consent.answer(true)
        job.join()
        assertEquals(2, client.adaptStartCalls.size)
        assertNull(client.adaptStartCalls[0].second.consent)
        assertNotNull(client.adaptStartCalls[1].second.consent)
        // The box rolls the credential back with a refused consent: the resend carries it again.
        assertEquals(key, client.adaptStartCalls[1].second.credential)
        assertEquals(client.adaptStartCalls[0].second.copy(consent = null), client.adaptStartCalls[1].second.copy(consent = null))
    }

    @Test fun gitAdaptCancelGoesBackToTheVerdict() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0).apply { gitFitFixture = false; consentRequired = true }
        val vm = BuildGitViewModel(client, scope = backgroundScope, consentSigner = { error("never signed") })
        vm.checkRepo("https://github.com/you/app", "").join()
        val job = vm.adapt()
        vm.consent.ask.filterNotNull().first()
        vm.consent.answer(false)
        job.join()
        assertEquals(1, client.adaptStartCalls.size)
        assertTrue(vm.phase.value is BuildGitViewModel.GitPhase.Verdict)
        assertNull(vm.adaptError.value)
    }
}
