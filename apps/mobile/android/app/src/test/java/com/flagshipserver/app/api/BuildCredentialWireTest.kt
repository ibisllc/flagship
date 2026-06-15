// BYOK credential wire-fidelity. The on-the-wire shape MUST match the webapp
// providers.js entry (`{ provider, apiKey, baseUrl? }`) and the daemon BYOK
// contract: `credential` attaches to vibe-code/start + reply, and
// VibeCodeStartResponse carries `needsCredential`. The Mock must produce the
// same shape the Live client posts/decodes.

package com.flagshipserver.app.api

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BuildCredentialWireTest {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = false }

    @Test
    fun credentialFieldNames() {
        val cred = BuildCredential(provider = "anthropic", apiKey = "sk-ant-123", baseUrl = "https://x")
        val s = json.encodeToString(BuildCredential.serializer(), cred)
        assertTrue(s.contains("\"provider\":\"anthropic\""))
        assertTrue(s.contains("\"apiKey\":\"sk-ant-123\""))
        assertTrue(s.contains("\"baseUrl\":\"https://x\""))
    }

    @Test
    fun baseUrlOmittedWhenNull() {
        val cred = BuildCredential(provider = "openai", apiKey = "sk-1")
        val s = json.encodeToString(BuildCredential.serializer(), cred)
        assertFalse(s.contains("baseUrl"))
    }

    @Test
    fun startRequestNestsCredential() {
        val req = VibeCodeStartRequest(
            prompt = "build a thing",
            credential = BuildCredential("anthropic", "sk-ant-9", null),
        )
        val s = json.encodeToString(VibeCodeStartRequest.serializer(), req)
        assertTrue(s.contains("\"prompt\":\"build a thing\""))
        assertTrue(s.contains("\"credential\":{"))
        assertTrue(s.contains("\"provider\":\"anthropic\""))
    }

    @Test
    fun startRequestOmitsCredentialWhenAbsent() {
        val req = VibeCodeStartRequest(prompt = "x")
        val s = json.encodeToString(VibeCodeStartRequest.serializer(), req)
        assertFalse(s.contains("credential"))
    }

    @Test
    fun replyRequestCarriesCredential() {
        val req = VibeCodeReplyRequest(text = "use the box model", credential = BuildCredential("google", "AIza1", null))
        val s = json.encodeToString(VibeCodeReplyRequest.serializer(), req)
        assertTrue(s.contains("\"credential\":{"))
        assertTrue(s.contains("\"provider\":\"google\""))
    }

    @Test
    fun startResponseDecodesNeedsCredential() {
        val r = json.decodeFromString(
            VibeCodeStartResponse.serializer(),
            "{\"sessionId\":\"\",\"needsCredential\":true}",
        )
        assertTrue(r.needsCredential)
        // Default is false when the box doesn't send it.
        val r2 = json.decodeFromString(VibeCodeStartResponse.serializer(), "{\"sessionId\":\"vc-abc\"}")
        assertFalse(r2.needsCredential)
        assertEquals("vc-abc", r2.sessionId)
    }

    @Test
    fun adaptRequestNestsCredential() {
        val req = BuildAdaptRequest(
            instructions = "make it Flagship-ready",
            credential = BuildCredential("anthropic", "sk-ant-adapt", "https://api.example"),
        )
        val s = json.encodeToString(BuildAdaptRequest.serializer(), req)
        assertTrue(s.contains("\"instructions\":\"make it Flagship-ready\""))
        assertTrue(s.contains("\"credential\":{"))
        assertTrue(s.contains("\"provider\":\"anthropic\""))
        assertTrue(s.contains("\"apiKey\":\"sk-ant-adapt\""))
        assertTrue(s.contains("\"baseUrl\":\"https://api.example\""))
    }

    @Test
    fun adaptRequestOmitsCredentialWhenAbsent() {
        val s = json.encodeToString(BuildAdaptRequest.serializer(), BuildAdaptRequest())
        assertFalse(s.contains("credential"))
    }

    @Test
    fun mockAdaptRecordsCredential() = runTest {
        val mock = MockBuildClient(simulatedLatencyMs = 0)
        val cred = BuildCredential("openai", "sk-mock", null)
        mock.adapt("b1", BuildAdaptRequest(credential = cred))
        assertEquals(1, mock.adaptCalls.size)
        assertEquals(cred, mock.adaptCalls.first().second.credential)
    }

    @Test
    fun mockMatchesLiveContract() = runTest {
        val mock = MockScreensClient()
        // No credential ⇒ needsCredential (no promo budget in the mock).
        val none = mock.vibeCodeStart(VibeCodeStartRequest(prompt = "p"))
        assertTrue(none.needsCredential)
        assertEquals("", none.sessionId)
        // With a credential ⇒ a real session, no re-prompt.
        val ok = mock.vibeCodeStart(
            VibeCodeStartRequest(prompt = "p", credential = BuildCredential("anthropic", "sk-ant", null)),
        )
        assertFalse(ok.needsCredential)
        assertTrue(ok.sessionId.startsWith("vc-"))
    }
}
