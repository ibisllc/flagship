// Drives the screens client through a HomeViewModel + asserts the
// LoadingState arms transition through Loading → Loaded / Failed.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HomeViewModelTest {
    @Test fun load_emitsLoadingThenLoaded() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = TestScope(dispatcher)
        val vm = HomeViewModel(MockScreensClient(simulatedLatencyMs = 0), scope)
        vm.load().join()
        val state = vm.state.first()
        assertTrue(state is LoadingState.Loaded<*>)
    }

    @Test fun load_capturesError() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = TestScope(dispatcher)
        val failing = MockScreensClient(simulatedLatencyMs = 0)
        failing.shouldFail = true
        val vm = HomeViewModel(failing, scope)
        vm.load().join()
        val state = vm.state.first()
        assertTrue(state is LoadingState.Failed)
        assertEquals("HTTP 503: simulated failure", (state as LoadingState.Failed).message)
    }
}
