// Drives the screens client through a HomeViewModel + asserts the
// LoadingState arms transition through Loading → Loaded / Failed.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.UserErrorText
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        assertEquals(UserErrorText.SERVER_PROBLEM, (state as LoadingState.Failed).message)
    }

    // loadUntilLoaded keeps showing the skeleton across failures (never flashes
    // the error card) and lands Loaded once the box answers — the fix for the
    // "stuck connecting" page when a box just came online.
    @Test fun loadUntilLoaded_keepsSkeletonThenLoadsOnRecovery() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = TestScope(dispatcher)
        val client = MockScreensClient(simulatedLatencyMs = 0)
        client.shouldFail = true
        val vm = HomeViewModel(client, scope)
        val job = vm.loadUntilLoaded()
        testScheduler.advanceTimeBy(50); testScheduler.runCurrent()
        // First attempt failed → still Loading (skeleton), NOT Failed.
        assertTrue(vm.state.value is LoadingState.Loading)
        // The box answers; the next retry (after the 2s backoff) lands Loaded.
        client.shouldFail = false
        testScheduler.advanceTimeBy(2_100); testScheduler.runCurrent()
        assertTrue(vm.state.value is LoadingState.Loaded<*>)
        assertEquals(0, vm.failures.value)
        job.cancel()
    }

    // A box the directory calls offline / coming up gets one try, then the page
    // shows its honest state instead of retrying behind a skeleton.
    @Test fun loadUntilLoaded_givesUpAtOnceOnABoxThatWontAnswer() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = TestScope(dispatcher)
        val client = MockScreensClient(simulatedLatencyMs = 0)
        client.shouldFail = true
        val vm = HomeViewModel(client, scope)
        vm.loadUntilLoaded(wontAnswer = true)
        testScheduler.advanceTimeBy(50); testScheduler.runCurrent()
        assertTrue(vm.state.value is LoadingState.Failed)
        assertEquals(1, vm.failures.value)
        assertFalse(vm.needsPairing.value)
    }

    @Test fun aMissingOrRejectedTokenNeedsPairing_a403DoesNot() {
        assertTrue(HomeViewModel.isNotPaired(ScreensError.NoSessionToken))
        assertTrue(HomeViewModel.isNotPaired(ScreensError.Http(401, "")))
        assertFalse(HomeViewModel.isNotPaired(ScreensError.Http(403, "")))
        assertFalse(HomeViewModel.isNotPaired(ScreensError.Http(503, "")))
    }
}
