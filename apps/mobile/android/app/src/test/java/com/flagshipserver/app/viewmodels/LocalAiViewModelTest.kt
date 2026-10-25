package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.LocalAiOrders
import com.flagshipserver.app.keystore.BiometricCancelled
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** AI02 on Android: the Local AI screen's actions, the signed orders and their refusals. */
class LocalAiViewModelTest {
    private val server = "home.bright-maple.flagship.services"
    private val seed = ByteArray(32) { 0x45 }
    private val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
    private val t0 = 1_761_300_000_000L

    private fun mock() = MockScreensClient(simulatedLatencyMs = 0)

    private fun vm(client: MockScreensClient, confirm: suspend (String) -> Unit = {}, jobId: String = "0123456789abcdee") =
        LocalAiViewModel(server, client, confirm = confirm, signer = { Ed25519Sign(seed) }, now = { t0 }, newJobId = { jobId })

    @Test fun loadsTheBoxsViewWithItsGpuHolderAndQueue() = runTest {
        val m = vm(mock())
        m.load()
        val v = m.state.value.view!!
        assertEquals("Render farm", v.hardware.gpus.single().holders.single().appName)
        assertEquals(2, v.jobs.first { it.state == "queued" }.queuePosition)
        assertEquals("none", v.cost)
        assertEquals("this-server", v.privacy)
    }

    @Test fun aDownloadMovesToInstalledAndShowsInTheOnThisServerMenu() = runTest {
        val c = mock()
        val m = vm(c)
        m.load()
        assertTrue(m.download("qwen2.5-0.5b-q4"))
        assertEquals("downloading", m.state.value.view!!.models.first { it.id == "qwen2.5-0.5b-q4" }.state)
        assertTrue(m.moving())
        m.load()
        assertEquals("installed", m.state.value.view!!.models.first { it.id == "qwen2.5-0.5b-q4" }.state)
        val menu = c.aiModels(com.flagshipserver.app.api.LlmProviderCredential(LocalAiOrders.PROVIDER, "local"))
        assertTrue(menu.models.any { it.id == "qwen2.5-0.5b-q4" })
        assertEquals(listOf("model:download:qwen2.5-0.5b-q4"), c.localAiActions)
    }

    @Test fun aFineTuneIsASignedOrderTheBoxCanVerify() = runTest {
        val c = mock()
        var prompts = 0
        val m = vm(c, confirm = { prompts++ })
        m.load()
        assertTrue(m.startTraining("alice--notes", "stories-15m", 3))
        assertEquals(1, prompts)
        val body = c.localAiTrainBodies.single()
        assertEquals("0123456789abcdee", body.order.jobId)
        assertEquals(t0, body.order.issuedAt)
        assertEquals(server, body.order.serverDomain)
        Ed25519Verify(pub).verify(HexUtil.decode(body.signature)!!, LocalAiOrders.trainBytes(body.order))
        // The new job waits behind the running and queued ones.
        assertEquals(3, m.state.value.view!!.jobs.first { it.id == "0123456789abcdee" }.queuePosition)
    }

    @Test fun epochsOutOfRangeAreRefusedBeforeAnythingIsSigned() = runTest {
        val c = mock()
        var prompts = 0
        val m = vm(c, confirm = { prompts++ })
        assertFalse(m.startTraining("alice--notes", "stories-15m", 21))
        assertFalse(m.startTraining("alice--notes", "stories-15m", 0))
        assertEquals(0, prompts)
        assertTrue(c.localAiTrainBodies.isEmpty())
    }

    @Test fun anAppGrantAndItsWithdrawalAreSigned() = runTest {
        val c = mock()
        val m = vm(c)
        m.load()
        assertTrue(m.grant("alice--notes", 500, 200_000, 1_024))
        val g = c.localAiGrantBodies.last()
        assertEquals(500L, g.order.requestsPerDay)
        Ed25519Verify(pub).verify(HexUtil.decode(g.signature)!!, LocalAiOrders.grantBytes(g.order))
        assertEquals(500L, m.state.value.view!!.apps.first { it.serviceId == "alice--notes" }.grant!!.requestsPerDay)
        assertTrue(m.withdraw("alice--notes"))
        val w = c.localAiGrantBodies.last()
        assertEquals(listOf(0L, 0L, 0L), listOf(w.order.requestsPerDay, w.order.tokensPerDay, w.order.maxTokensPerRequest))
        assertNull(m.state.value.view!!.apps.first { it.serviceId == "alice--notes" }.grant)
    }

    @Test fun aQuotaOfZeroOrOverTheLimitIsRefused() = runTest {
        val c = mock()
        val m = vm(c)
        assertFalse(m.grant("alice--notes", 500, 0, 1_024))
        assertFalse(m.grant("alice--notes", 500, 200_000, 40_000))
        assertTrue(c.localAiGrantBodies.isEmpty())
    }

    @Test fun noBiometricMeansNothingIsSent() = runTest {
        val c = mock()
        val m = vm(c, confirm = { throw BiometricCancelled() })
        assertFalse(m.startTraining("alice--notes", "stories-15m", 2))
        assertTrue(c.localAiTrainBodies.isEmpty())
        assertEquals("Nothing changed: you didn't confirm.", m.state.value.error)
    }

    @Test fun theBoxsRefusalIsShownInItsOwnWords() = runTest {
        val c = mock()
        c.localAiFixture = c.localAiFixture.copy(models = c.localAiFixture.models.map { it.copy(state = "available") })
        val m = vm(c)
        assertFalse(m.startServer(null))
        assertEquals("No model is downloaded on this server yet. Download one under Local AI.", m.state.value.error)
        c.failure = ScreensError.Http(403, """{"error":"That order was not signed by the owner."}""")
        assertFalse(m.grant("alice--notes", 1, 1, 1))
        assertEquals("That order was not signed by the owner.", m.state.value.error)
    }

    @Test fun checkpointsOpenAndClose() = runTest {
        val m = vm(mock())
        m.openJob("0123456789abcdef")
        assertEquals(1, m.state.value.job!!.checkpoints.size)
        m.closeJob()
        assertNull(m.state.value.job)
    }
}
