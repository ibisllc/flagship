package com.flagshipserver.app.keystore

import androidx.biometric.BiometricManager.Authenticators
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.withStateAtLeast
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

class BiometricCancelled : Exception("biometric prompt cancelled")
class BiometricFailed(val code: Int, val errString: CharSequence) :
    Exception("biometric failed: $code $errString") {
    /** Too many tries: the phone locked biometrics for a while (or until unlock). */
    val isLockout: Boolean
        get() = code == BiometricPrompt.ERROR_LOCKOUT || code == BiometricPrompt.ERROR_LOCKOUT_PERMANENT

    companion object {
        /** The prompt never came up (the platform refused to start it). */
        const val NOT_STARTED = -1001
        /** The screen went away for good (the activity was destroyed). */
        const val SCREEN_GONE = -1002
    }
}

/** One prompt's outcome, as the platform reports it. */
sealed class PromptOutcome {
    data object Succeeded : PromptOutcome()
    data object CancelledByUser : PromptOutcome()
    data class Error(val code: Int, val message: CharSequence) : PromptOutcome()
}

/** Starts one system prompt. [onOutcome] is called at most once; a platform
 *  that drops the request calls it never. Returns a way to cancel it. */
fun interface PromptStarter {
    fun start(onOutcome: (PromptOutcome) -> Unit): () -> Unit
}

object BiometricGate {
    suspend fun evaluate(activity: FragmentActivity, title: String, subtitle: String) {
        if (com.flagshipserver.app.core.Variant.bypassBiometricGates) return
        withContext(Dispatchers.Main.immediate) {
            run(activity.lifecycle, PlatformPromptStarter(activity, title, subtitle))
        }
    }

    /**
     * Ask until the person answers, never leaving a caller waiting on a prompt
     * that can't show (device bug M11: a prompt started while the screen was
     * off failed silently with "Called after onSaveInstanceState()" and the
     * lock screen stayed on "Authenticating…" until the app was killed).
     *
     *  - The prompt starts only while the screen is RESUMED; a request made
     *    while it is off waits for the person to come back.
     *  - The system cancelling the prompt because the screen went away
     *    (ERROR_CANCELED while no longer resumed) re-offers it on resume.
     *  - Everything else ends the request: success returns, the person's
     *    cancel throws [BiometricCancelled], any error (lockout, no hardware,
     *    a prompt that never came up, the screen destroyed) throws
     *    [BiometricFailed], so callers can show an idle "Try again".
     *
     * Requests queue: the system shows one prompt per activity, and a second
     * `authenticate` while one is up replaces it without ever calling the
     * first's callback, which left the app-lock screen on "Authenticating…"
     * after a file picker returned and the backup restore asked at the same
     * moment.
     *
     * Must run on the main thread (the prompt and the lifecycle live there).
     */
    suspend fun run(lifecycle: Lifecycle, starter: PromptStarter) {
        promptLock.withLock { runExclusive(lifecycle, starter) }
    }

    private val promptLock = Mutex()

    private suspend fun runExclusive(lifecycle: Lifecycle, starter: PromptStarter) {
        while (true) {
            if (lifecycle.currentState == Lifecycle.State.DESTROYED) {
                throw BiometricFailed(BiometricFailed.SCREEN_GONE, "screen closed")
            }
            val outcome = CompletableDeferred<PromptOutcome>()
            var cancel: (() -> Unit)? = null
            val gone = LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_DESTROY) {
                    cancel?.invoke()
                    outcome.complete(PromptOutcome.Error(BiometricFailed.SCREEN_GONE, "screen closed"))
                }
            }
            lifecycle.addObserver(gone)
            try {
                if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                    com.flagshipserver.app.core.ErrorLog.step("biometric", "waiting for the screen (${lifecycle.currentState})")
                }
                lifecycle.withStateAtLeast(Lifecycle.State.RESUMED) {
                    com.flagshipserver.app.core.ErrorLog.step("biometric", "prompt start")
                    cancel = starter.start { outcome.complete(it) }
                }
                val result = outcome.await()
                com.flagshipserver.app.core.ErrorLog.step(
                    "biometric",
                    "prompt outcome ${result.javaClass.simpleName}" +
                        ((result as? PromptOutcome.Error)?.let { " code=${it.code} ${it.message}" } ?: ""),
                )
                when (val o = result) {
                    PromptOutcome.Succeeded -> return
                    PromptOutcome.CancelledByUser -> throw BiometricCancelled()
                    is PromptOutcome.Error -> {
                        val lostScreen = o.code == BiometricPrompt.ERROR_CANCELED &&
                            !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) &&
                            lifecycle.currentState != Lifecycle.State.DESTROYED
                        if (!lostScreen) throw BiometricFailed(o.code, o.message)
                        // Re-offered when the person comes back (loop).
                    }
                }
            } finally {
                lifecycle.removeObserver(gone)
            }
        }
    }
}

/** The real system prompt: fingerprint / face / iris OR the device PIN,
 *  pattern or password. */
private class PlatformPromptStarter(
    private val activity: FragmentActivity,
    private val title: String,
    private val subtitle: String,
) : PromptStarter {
    override fun start(onOutcome: (PromptOutcome) -> Unit): () -> Unit {
        // BiometricPrompt's own docs mandate the main-thread executor — the
        // callback drives Compose state (AppState.markUnlocked) and, with
        // DEVICE_CREDENTIAL allowed, the PIN/pattern confirmation launches
        // a full-screen system activity that stops the host Activity.
        val executor = ContextCompat.getMainExecutor(activity)
        val prompt = BiometricPrompt(
            activity,
            executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    onOutcome(PromptOutcome.Succeeded)
                }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                        errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                    ) {
                        onOutcome(PromptOutcome.CancelledByUser)
                    } else {
                        onOutcome(PromptOutcome.Error(errorCode, errString))
                    }
                }
            },
        )
        // Accept ANY strong device unlock — biometrics OR the device PIN /
        // pattern / password (DEVICE_CREDENTIAL), so a phone with a screen
        // lock but no enrolled biometric still authenticates. With
        // DEVICE_CREDENTIAL the system supplies its own cancel affordance, so
        // a negative button must NOT be set (the two are mutually exclusive).
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setAllowedAuthenticators(Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL)
            .build()
        try {
            prompt.authenticate(info)
        } catch (t: Throwable) {
            onOutcome(PromptOutcome.Error(BiometricFailed.NOT_STARTED, t.message ?: t.javaClass.simpleName))
            return {}
        }
        // BiometricPrompt drops a request it can't start (it only logs), so
        // check that its fragment came up; if not, say so instead of waiting.
        activity.window?.decorView?.postDelayed({
            if (activity.supportFragmentManager.findFragmentByTag(BIOMETRIC_FRAGMENT_TAG) == null) {
                onOutcome(PromptOutcome.Error(BiometricFailed.NOT_STARTED, "prompt did not start"))
            }
        }, START_CHECK_MS)
        return { runCatching { prompt.cancelAuthentication() } }
    }

    companion object {
        const val BIOMETRIC_FRAGMENT_TAG = "androidx.biometric.BiometricFragment"
        const val START_CHECK_MS = 1_500L
    }
}
