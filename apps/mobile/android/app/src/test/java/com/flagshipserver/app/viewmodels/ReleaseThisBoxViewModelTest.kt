package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.PqSignatureWire
import com.flagshipserver.app.core.ReleaseThisBox
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseThisBoxViewModelTest {
    private val server = "home.bright-maple.flagship.services"
    private val stk = "ab".repeat(32)
    private val seed = ByteArray(32) { 0x5a }
    private val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey

    private fun vm(client: MockScreensClient, admin: Boolean = true, prompts: MutableList<String> = mutableListOf(), pq: PqSignatureWire? = null) =
        ReleaseThisBoxViewModel(
            serverDomain = server,
            username = "harry",
            stkPubHex = stk,
            client = client,
            isAdminDevice = { admin },
            confirm = { prompts += it },
            adminRoot = { Ed25519Sign(seed) },
            pqSignature = { _, _ -> pq },
            now = { 1_790_000_000_000L },
        )

    @Test fun signsAnOrderTheBoxVerifiesAfterOnePrompt() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val prompts = mutableListOf<String>()
        assertTrue(vm(client, prompts = prompts).release())
        assertEquals(1, prompts.size)
        val body = Json.parseToJsonElement(client.releaseBodies.single()).jsonObject
        val o = body["order"]!!.jsonObject
        val order = ReleaseThisBox.Order(o["serverDomain"]!!.jsonPrimitive.content, o["stkPubHex"]!!.jsonPrimitive.content, o["issuedAt"]!!.jsonPrimitive.long, o["nonceHex"]!!.jsonPrimitive.content)
        assertEquals(stk, order.stkPubHex)
        assertTrue(ReleaseThisBox.verify(order, body["signatureHex"]!!.jsonPrimitive.content, pub))
        assertNull(body["pqSignature"])
    }

    @Test fun carriesTheHybridSignatureWhenThereIsOne() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        vm(client, pq = PqSignatureWire(ReleaseThisBox.HYBRID_SUITE, "00")).release()
        val body = Json.parseToJsonElement(client.releaseBodies.single()).jsonObject
        assertEquals(ReleaseThisBox.HYBRID_SUITE, body["pqSignature"]!!.jsonObject["suite"]!!.jsonPrimitive.content)
    }

    @Test fun aNonAdminDeviceSendsNothing() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        assertFalse(vm(client, admin = false).release())
        assertTrue(client.releaseBodies.isEmpty())
    }

    @Test fun refusalCodesBecomeSentences() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        client.releaseRefusal = "release-needs-hybrid"
        val m = vm(client)
        assertFalse(m.release())
        assertEquals(ReleaseThisBox.refusal("release-needs-hybrid"), m.state.value.error)
    }
}
