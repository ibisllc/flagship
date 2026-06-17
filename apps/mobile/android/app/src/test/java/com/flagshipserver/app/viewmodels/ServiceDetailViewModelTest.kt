// Mirror of the iOS ServiceDetailViewModel behavior. Runs on the JVM (no
// Robolectric) — Mock/Screen/VM are all pure Kotlin, and save()/uninstall()
// base64-encode via java.util.Base64 (no Android stub), so the orders/send
// path is unit-testable.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppDetailResponse
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.OrdersSendRequest
import com.flagshipserver.app.api.OrdersSendResponse
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.PodInfo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import javax.net.ssl.SSLPeerUnverifiedException

@OptIn(ExperimentalCoroutinesApi::class)
class ServiceDetailViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUpDispatcher() { Dispatchers.setMain(dispatcher) }
    @After fun tearDownDispatcher() { Dispatchers.resetMain() }

    private val pods = listOf(
        PodInfo(podId = "home", name = "Home box", fqdn = "home.harry.flagship.services"),
        PodInfo(podId = "office", name = "Office box", fqdn = "office.harry.flagship.services"),
    )

    private fun vm(
        client: ScreensClient = MockScreensClient(simulatedLatencyMs = 0),
        leader: String? = "home",
    ) = ServiceDetailViewModel(
        serviceId = "harry-plants",
        client = client,
        allPods = pods,
        globalLeaderPodId = leader,
    )

    // Composes over a Mock, overriding a single method (MockScreensClient is final).
    private class FailingDetail(
        private val error: Throwable,
        private val delegate: ScreensClient = MockScreensClient(simulatedLatencyMs = 0),
    ) : ScreensClient by delegate {
        override suspend fun appDetail(serviceId: String): AppDetailResponse = throw error
    }

    /** Records every orders/send envelope so the save/uninstall wire shape can
     *  be asserted. */
    private class RecordingOrders(
        val sent: MutableList<OrdersSendRequest> = mutableListOf(),
        private val delegate: ScreensClient = MockScreensClient(simulatedLatencyMs = 0),
    ) : ScreensClient by delegate {
        override suspend fun ordersSend(req: OrdersSendRequest): OrdersSendResponse {
            sent.add(req)
            return OrdersSendResponse(ok = true, response = null)
        }
    }

    @Test fun load_success_populatesDetailAndSeedsLeader() = runTest {
        val m = vm()
        m.load()
        advanceUntilIdle()
        val s = m.detail.value
        assertTrue(s is LoadingState.Loaded)
        val resp = (s as LoadingState.Loaded).value
        assertEquals("harry-plants", resp.app.serviceId)
        assertTrue(resp.recentLogs.isNotEmpty())
        // No multi-pod policy in the BFF yet → seed run-on to the leader only.
        assertEquals(setOf("home"), m.runOnPodIds.value)
        assertFalse(m.certMismatch.value)
    }

    @Test fun load_unknownService_surfacesFailure() = runTest {
        // 404 from the Mock for an unknown serviceId — empty/missing-app path.
        val m = ServiceDetailViewModel(
            serviceId = "nope-missing",
            client = MockScreensClient(simulatedLatencyMs = 0),
            allPods = pods,
            globalLeaderPodId = "home",
        )
        m.load()
        advanceUntilIdle()
        assertTrue(m.detail.value is LoadingState.Failed)
        // No leader seeded on a failed load.
        assertTrue(m.runOnPodIds.value.isEmpty())
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

    @Test fun togglePod_addsAndRemoves_andClearsLeadOnDeselect() = runTest {
        val m = vm()
        m.load()
        advanceUntilIdle()
        // Seeded to the leader; make office the lead, then deselect it.
        m.setLead("office")
        assertEquals("office", m.leadPodId.value)
        assertTrue(m.runOnPodIds.value.contains("office"))
        m.togglePod("office") // deselect the current lead
        assertFalse(m.runOnPodIds.value.contains("office"))
        // Deselecting the lead clears it → falls back to the global leader.
        assertNull(m.leadPodId.value)
        assertEquals("home", m.effectiveLeadPodId)
    }

    @Test fun save_dispatchesServicePolicyEnvelope_withSortedRunOnPods() = runTest {
        val orders = RecordingOrders()
        val m = vm(client = orders)
        m.load()
        advanceUntilIdle()
        m.setLead("office")
        m.togglePod("home") // ensure both selected (home was the seed)
        // Now home+office both selected (toggle re-added would remove home, so re-add):
        if (!m.runOnPodIds.value.contains("home")) m.togglePod("home")
        m.save()
        advanceUntilIdle()
        assertEquals(1, orders.sent.size)
        val req = orders.sent.single()
        assertEquals("service-policy/v1", req.kind)
        // Decode the base64 envelope and assert the canonical shape.
        val json = String(java.util.Base64.getDecoder().decode(req.envelope), Charsets.UTF_8)
        val obj = Json.parseToJsonElement(json) as JsonObject
        assertEquals("service-policy/v1", obj["kind"]!!.jsonPrimitive.content)
        assertEquals("harry-plants", obj["serviceId"]!!.jsonPrimitive.content)
        val runOn = obj["runOnPodIds"]!!.jsonArray.map { it.jsonPrimitive.content }
        // Sorted for cross-platform-deterministic canonical bytes.
        assertEquals(runOn.sorted(), runOn)
        assertEquals("office", obj["leadPodId"]!!.jsonPrimitive.content)
    }

    @Test fun uninstall_dispatchesServiceUninstallEnvelope() = runTest {
        val orders = RecordingOrders()
        val m = vm(client = orders)
        m.load()
        advanceUntilIdle()
        m.uninstall()
        advanceUntilIdle()
        assertEquals(1, orders.sent.size)
        val req = orders.sent.single()
        assertEquals("service-uninstall/v1", req.kind)
        val json = String(java.util.Base64.getDecoder().decode(req.envelope), Charsets.UTF_8)
        val obj = Json.parseToJsonElement(json) as JsonObject
        assertEquals("service-uninstall/v1", obj["kind"]!!.jsonPrimitive.content)
        assertEquals("harry-plants", obj["serviceId"]!!.jsonPrimitive.content)
    }
}
