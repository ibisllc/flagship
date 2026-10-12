// Mirror of the iOS ServiceDetailViewModel behavior. Runs on the JVM (no
// Robolectric) — Mock/Screen/VM are all pure Kotlin. Where the app runs is
// AppPlacementViewModelTest; the old service-policy/v1 Save is gone.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppDetailResponse
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.UninstallServiceOrder
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import javax.net.ssl.SSLPeerUnverifiedException

@OptIn(ExperimentalCoroutinesApi::class)
class ServiceDetailViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUpDispatcher() { Dispatchers.setMain(dispatcher) }
    @After fun tearDownDispatcher() { Dispatchers.resetMain() }

    private val irkSeed = ByteArray(32) { 3 }

    private fun vm(
        client: ScreensClient = MockScreensClient(simulatedLatencyMs = 0),
        serviceId: String = "bright-maple--plants",
    ) = ServiceDetailViewModel(
        serviceId = serviceId,
        client = client,
        uninstallSigner = { Ed25519Sign(irkSeed) },
        now = { 1_700_000_000_000 },
    )

    // Composes over a Mock, overriding a single method (MockScreensClient is final).
    private class FailingDetail(
        private val error: Throwable,
        private val delegate: ScreensClient = MockScreensClient(simulatedLatencyMs = 0),
    ) : ScreensClient by delegate {
        override suspend fun appDetail(serviceId: String): AppDetailResponse = throw error
    }

    @Test fun load_success_populatesDetail() = runTest {
        val m = vm()
        m.load()
        advanceUntilIdle()
        val s = m.detail.value
        assertTrue(s is LoadingState.Loaded)
        val resp = (s as LoadingState.Loaded).value
        assertEquals("bright-maple--plants", resp.app.serviceId)
        assertTrue(resp.recentLogs.isNotEmpty())
        assertFalse(m.certMismatch.value)
    }

    @Test fun load_unknownService_surfacesFailure() = runTest {
        val m = vm(serviceId = "nope-missing")
        m.load()
        advanceUntilIdle()
        assertTrue(m.detail.value is LoadingState.Failed)
    }

    @Test fun load_certPinMismatch_raisesDistinguishableFlag() = runTest {
        val pinFail = SSLPeerUnverifiedException(
            "Certificate does not match the box's STK-signed fingerprint",
        )
        val m = vm(client = FailingDetail(pinFail))
        m.load()
        advanceUntilIdle()
        assertTrue(m.certMismatch.value)
        val s = m.detail.value as LoadingState.Failed
        assertTrue(s.message.contains("intercepting"))
    }

    @Test fun load_ordinaryHttpFailure_doesNotFlagMismatchOrLeakStatus() = runTest {
        val m = vm(client = FailingDetail(ScreensError.Http(503, "boom")))
        m.load()
        advanceUntilIdle()
        assertFalse(m.certMismatch.value)
        val s = m.detail.value as LoadingState.Failed
        assertFalse(s.message.contains("503"))
    }

    @Test fun uninstall_sendsTheSignedUninstallToThisBox() = runTest {
        val box = MockScreensClient(simulatedLatencyMs = 0).apply { podContext = "office" }
        val m = vm(client = box)
        m.load()
        advanceUntilIdle()
        m.uninstall()
        val (id, body) = box.uninstalls.single()
        assertEquals("bright-maple--plants", id)
        assertEquals("office.bright-maple.flagship.services", body.request.serverId)
        assertEquals("bright-maple", body.request.creator)
        assertEquals("plants", body.request.slug)
        assertEquals(1_700_000_000_000, body.request.issuedAt)
        Ed25519Verify(Ed25519Sign.KeyPair.newKeyPairFromSeed(irkSeed).publicKey).verify(
            HexUtil.decode(body.signature)!!,
            UninstallServiceOrder.canonicalBytes(body.request.serverId, "bright-maple", "plants", 1_700_000_000_000),
        )
    }
}
