// UX-A — when a box request fails on a cert-pin mismatch, the VM raises a
// distinguishable `certMismatch` flag (the screen promotes it to a security
// warning) and humanizes the message; ordinary failures don't set the flag and
// don't leak a raw status code.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.BrowserTabsListResponse
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import kotlinx.coroutines.Dispatchers
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

class BrowserTabsViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUpDispatcher() { Dispatchers.setMain(dispatcher) }
    @After fun tearDownDispatcher() { Dispatchers.resetMain() }

    // Delegates everything to a Mock, but fails browserTabsList with a chosen
    // throwable (MockScreensClient is final, so we compose via `by`).
    private class FailingScreens(
        private val error: Throwable,
        private val delegate: ScreensClient = MockScreensClient(simulatedLatencyMs = 0),
    ) : ScreensClient by delegate {
        override suspend fun browserTabsList(serviceId: String): BrowserTabsListResponse {
            throw error
        }
    }

    @Test fun certPinMismatchRaisesTheDistinguishableFlag() = runTest {
        val pinFail = SSLPeerUnverifiedException(
            "Certificate for x.box does not match the box's STK-signed " +
                "fingerprint — refusing connection",
        )
        val vm = BrowserTabsViewModel(FailingScreens(pinFail), serviceId = "svc")
        vm.load()
        advanceUntilIdle()
        assertTrue(vm.certMismatch.value)
        val s = vm.state.value
        assertTrue(s is LoadingState.Failed)
        assertTrue((s as LoadingState.Failed).message.contains("intercepting"))
    }

    @Test fun ordinaryHttpFailureDoesNotFlagMismatchAndHidesTheStatusCode() = runTest {
        val vm = BrowserTabsViewModel(FailingScreens(ScreensError.Http(503, "boom")), serviceId = "svc")
        vm.load()
        advanceUntilIdle()
        assertFalse(vm.certMismatch.value)
        val s = vm.state.value as LoadingState.Failed
        assertFalse(s.message.contains("503"))
        assertTrue(s.message.contains("try again", ignoreCase = true))
    }

    @Test fun aSuccessfulReloadClearsAStaleMismatchFlag() = runTest {
        val pinFail = SSLPeerUnverifiedException("does not match the box's STK-signed fingerprint")
        val vm = BrowserTabsViewModel(FailingScreens(pinFail), serviceId = "svc")
        vm.load()
        advanceUntilIdle()
        assertTrue(vm.certMismatch.value)
        // A subsequent load() starts by clearing the flag.
        val ok = BrowserTabsViewModel(MockScreensClient(simulatedLatencyMs = 0), serviceId = "svc")
        ok.load()
        advanceUntilIdle()
        assertFalse(ok.certMismatch.value)
        assertTrue(ok.state.value is LoadingState.Loaded)
    }
}
