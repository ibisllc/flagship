package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.TrustedDevice
import com.flagshipserver.app.viewmodels.TrustedDevicesViewModel
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class TrustedDevicesViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUpDispatcher() { Dispatchers.setMain(dispatcher) }
    @After fun tearDownDispatcher() { Dispatchers.resetMain() }

    private fun makeServer(): MockFlagshipServerClient = MockFlagshipServerClient(simulatedLatencyMs = 0)

    /** Deterministic IRK signer so the (now-authenticated) disconnect
     *  doesn't hit the biometric-gated Keystore in a JVM unit test. */
    private fun fakeSigner(): suspend (String) -> Ed25519Sign {
        val key = Ed25519Sign(ByteArray(32) { 0x11 })
        return { _ -> key }
    }

    private fun device(tokenId: String, label: String, addedAt: Long = 1L): TrustedDevice =
        TrustedDevice(
            tokenId = tokenId,
            tokenPrefix = tokenId.take(8),
            label = label,
            platform = "fcm",
            addedAt = addedAt,
            lastSeenAt = addedAt,
        )

    @Test fun load_emptyWhenUsernameMissing() = runTest {
        val vm = TrustedDevicesViewModel(server = makeServer(), username = { null })
        vm.load()
        advanceUntilIdle()
        val s = vm.state.value
        assertTrue(s is TrustedDevicesViewModel.State.Loaded)
        assertTrue((s as TrustedDevicesViewModel.State.Loaded).devices.isEmpty())
    }

    @Test fun load_populatesFromServerAndCapturesEtag() = runTest {
        val server = makeServer()
        server.devicesByUser = mapOf(
            "harry" to listOf(device("t1", "Pixel"), device("t2", "Tablet", addedAt = 2L)),
        )
        val vm = TrustedDevicesViewModel(server = server, username = { "harry" })
        vm.load()
        advanceUntilIdle()
        val s = vm.state.value as TrustedDevicesViewModel.State.Loaded
        assertEquals(2, s.devices.size)
        assertEquals("Pixel", s.devices[0].label)
        assertNotNull(vm.etag.value)
    }

    @Test fun load_setsFailedOnServerError() = runTest {
        val server = makeServer().apply { shouldFail = true }
        val vm = TrustedDevicesViewModel(server = server, username = { "harry" })
        vm.load()
        advanceUntilIdle()
        assertTrue(vm.state.value is TrustedDevicesViewModel.State.Failed)
    }

    @Test fun disconnect_optimisticallyRemovesAndReturnsTrue() = runTest {
        val server = makeServer()
        server.devicesByUser = mapOf("harry" to listOf(device("tA", "iPhone")))
        val vm = TrustedDevicesViewModel(server = server, username = { "harry" }, signer = fakeSigner())
        vm.load()
        advanceUntilIdle()
        // Drop the row from the Mock so the refresh confirms the
        // server-side removal.
        server.devicesByUser = mapOf("harry" to emptyList())
        val target = device("tA", "iPhone")
        val ok = vm.disconnect(target)
        advanceUntilIdle()
        assertTrue(ok)
        val s = vm.state.value as TrustedDevicesViewModel.State.Loaded
        assertTrue(s.devices.isEmpty())
    }

    @Test fun disconnect_revertsListOnServerError() = runTest {
        val server = makeServer()
        server.devicesByUser = mapOf("harry" to listOf(device("tA", "iPhone")))
        val vm = TrustedDevicesViewModel(server = server, username = { "harry" }, signer = fakeSigner())
        vm.load()
        advanceUntilIdle()
        server.shouldFail = true
        val ok = vm.disconnect(device("tA", "iPhone"))
        advanceUntilIdle()
        assertEquals(false, ok)
        val s = vm.state.value as TrustedDevicesViewModel.State.Loaded
        assertEquals(1, s.devices.size)
    }

    @Test fun disconnect_isNoOpWhenNotLoaded() = runTest {
        val vm = TrustedDevicesViewModel(server = makeServer(), username = { "harry" })
        val ok = vm.disconnect(device("tA", "iPhone"))
        assertEquals(false, ok)
    }
}
