// Process-scoped BiometricPrompt gate. The MainActivity creates one,
// drops a reference on the static holder so Keystore.deriveIRK can
// reach it, and renews a short "freshness window" on every successful
// prompt so a screen-flow with multiple signatures doesn't trigger
// multiple prompts in quick succession.

package com.flagshipserver.app.keystore

import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * Indirection so the freshness-window logic is unit-testable without a
 * real FragmentActivity / BiometricPrompt. The production constructor
 * binds an activity; tests pass their own prompter (or null to simulate
 * the no-foreground-activity background-service case).
 */
fun interface BiometricPrompter {
    suspend fun prompt(title: String, subtitle: String)
}

class BiometricAuthority internal constructor(
    private val prompter: BiometricPrompter?,
    private val clock: () -> Long,
) {
    private val mutex = Mutex()
    @Volatile private var freshUntil: Long = 0L

    /** Production constructor — binds [activity] for BiometricPrompt. */
    constructor(
        activity: FragmentActivity,
        clock: () -> Long = { System.currentTimeMillis() },
    ) : this(
        prompter = BiometricPrompter { t, s -> BiometricGate.evaluate(activity, t, s) },
        clock = clock,
    )

    /**
     * Ensure a biometric session is fresh enough to release the IRK
     * seed. If the cached window is still valid, returns immediately.
     * Otherwise prompts and (on success) extends the window. Cancel /
     * fail bubbles up as the underlying exception so callers can show
     * a toast or fall back to the unlock-flow.
     *
     * When the prompter is null (background callers — FCM service —
     * with no foreground activity bound), this is a no-op: the caller
     * proceeds without an authentication step. This matches iOS's
     * LocalAuthentication behavior, which is silently bypassed in
     * background scope.
     */
    suspend fun ensureFresh(title: String, subtitle: String, window: Duration = DEFAULT_FRESHNESS) {
        if (clock() < freshUntil) return
        mutex.withLock {
            // Re-check inside the lock — another caller may have just
            // refreshed the window while we were queued.
            if (clock() < freshUntil) return
            val p = prompter ?: return
            p.prompt(title, subtitle)
            freshUntil = clock() + window.inWholeMilliseconds
        }
    }

    /** Invalidate the cached freshness window. */
    fun invalidate() {
        freshUntil = 0
    }

    companion object {
        val DEFAULT_FRESHNESS: Duration = 60.seconds

        @Volatile private var current: BiometricAuthority? = null
        fun set(authority: BiometricAuthority?) { current = authority }
        fun current(): BiometricAuthority? = current

        /** Test-only constructor — bypass the FragmentActivity wiring
         *  by injecting a prompter directly. */
        internal fun forTest(
            prompter: BiometricPrompter?,
            clock: () -> Long,
        ): BiometricAuthority = BiometricAuthority(prompter, clock)
    }
}
