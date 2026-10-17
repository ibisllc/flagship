// Device bug M11: the app-lock prompt, asked for while the screen was off,
// failed to start ("Called after onSaveInstanceState()") and the lock screen
// stayed on "Authenticating…". The gate now starts a prompt only while the
// screen is resumed, re-offers one the screen lost, and ends every other
// outcome so the caller can show "Try again".

package com.flagshipserver.app.keystore

import androidx.biometric.BiometricPrompt
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.flagshipserver.app.core.NetworkErrorHumanizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BiometricGateTest {
    private val owner = object : LifecycleOwner {
        val registry = LifecycleRegistry.createUnsafe(this)
        override val lifecycle: Lifecycle get() = registry
    }
    private val lifecycle get() = owner.registry

    /** A system prompt that, like BiometricPromptCompat, silently drops a
     *  request made while the screen isn't resumed. */
    private inner class FakePrompt : PromptStarter {
        var starts = 0
        var droppedStarts = 0
        var cancels = 0
        var pending: ((PromptOutcome) -> Unit)? = null
        override fun start(onOutcome: (PromptOutcome) -> Unit): () -> Unit {
            if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                droppedStarts++
                return {}
            }
            starts++
            pending = onOutcome
            return { cancels++ }
        }
        fun answer(o: PromptOutcome) { pending!!.invoke(o); pending = null }
    }

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        lifecycle.currentState = Lifecycle.State.CREATED
    }

    @After fun tearDown() = Dispatchers.resetMain()

    @Test fun aRequestWhileTheScreenIsOffWaitsForItToComeBack() = runTest(UnconfinedTestDispatcher()) {
        val prompt = FakePrompt()
        val gate = async { runCatching { BiometricGate.run(lifecycle, prompt) } }
        assertEquals("never started on a stopped screen", 0, prompt.starts + prompt.droppedStarts)
        lifecycle.currentState = Lifecycle.State.RESUMED
        assertEquals(1, prompt.starts)
        prompt.answer(PromptOutcome.Succeeded)
        assertTrue(gate.await().isSuccess)
    }

    @Test fun aPromptTheScreenLostIsOfferedAgainOnResume() = runTest(UnconfinedTestDispatcher()) {
        lifecycle.currentState = Lifecycle.State.RESUMED
        val prompt = FakePrompt()
        val gate = async { runCatching { BiometricGate.run(lifecycle, prompt) } }
        assertEquals(1, prompt.starts)
        // Screen turns off: the system cancels the prompt.
        lifecycle.currentState = Lifecycle.State.CREATED
        prompt.answer(PromptOutcome.Error(BiometricPrompt.ERROR_CANCELED, "Fingerprint operation canceled."))
        assertFalse(gate.isCompleted)
        lifecycle.currentState = Lifecycle.State.RESUMED
        assertEquals(2, prompt.starts)
        prompt.answer(PromptOutcome.Succeeded)
        assertTrue(gate.await().isSuccess)
    }

    @Test fun everyOtherOutcomeEndsTheRequest() = runTest(UnconfinedTestDispatcher()) {
        lifecycle.currentState = Lifecycle.State.RESUMED
        val cancelled = FakePrompt()
        val a = async { runCatching { BiometricGate.run(lifecycle, cancelled) } }
        cancelled.answer(PromptOutcome.CancelledByUser)
        assertTrue(a.await().exceptionOrNull() is BiometricCancelled)

        val locked = FakePrompt()
        val b = async { runCatching { BiometricGate.run(lifecycle, locked) } }
        locked.answer(PromptOutcome.Error(BiometricPrompt.ERROR_LOCKOUT, "Too many attempts"))
        val e = b.await().exceptionOrNull() as BiometricFailed
        assertTrue(e.isLockout)
        assertTrue(NetworkErrorHumanizer.humanize(e).startsWith("Too many tries"))

        val notStarted = FakePrompt()
        val c = async { runCatching { BiometricGate.run(lifecycle, notStarted) } }
        notStarted.answer(PromptOutcome.Error(BiometricFailed.NOT_STARTED, "prompt did not start"))
        assertEquals(BiometricFailed.NOT_STARTED, (c.await().exceptionOrNull() as BiometricFailed).code)
    }

    @Test fun aDestroyedScreenEndsAWaitingRequest() = runTest(UnconfinedTestDispatcher()) {
        lifecycle.currentState = Lifecycle.State.RESUMED
        val prompt = FakePrompt()
        val gate = async { runCatching { BiometricGate.run(lifecycle, prompt) } }
        lifecycle.currentState = Lifecycle.State.DESTROYED
        val e = gate.await().exceptionOrNull() as BiometricFailed
        assertEquals(BiometricFailed.SCREEN_GONE, e.code)
        assertEquals(1, prompt.cancels)
    }
}
