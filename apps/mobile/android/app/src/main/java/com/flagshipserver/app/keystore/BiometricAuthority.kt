// Process-scoped BiometricPrompt gate. The MainActivity creates one,
// drops a reference on the static holder so Keystore.deriveIRK can
// reach it, and renews a short "freshness window" on every successful
// prompt so a screen-flow with multiple signatures doesn't trigger
// multiple prompts in quick succession.

package com.flagshipserver.app.keystore

import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.lang.ref.WeakReference
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

class BiometricAuthority(activity: FragmentActivity) {
    private val ref = WeakReference(activity)
    private val mutex = Mutex()
    @Volatile private var freshUntil: Long = 0L

    val activity: FragmentActivity? get() = ref.get()

    /**
     * Ensure a biometric session is fresh enough to release the IRK
     * seed. If the cached window is still valid, returns immediately.
     * Otherwise prompts and (on success) extends the window. Cancel /
     * fail bubbles up as the underlying exception so callers can show
     * a toast or fall back to the unlock-flow.
     */
    suspend fun ensureFresh(title: String, subtitle: String, window: Duration = DEFAULT_FRESHNESS) {
        if (System.currentTimeMillis() < freshUntil) return
        mutex.withLock {
            // Re-check inside the lock — another caller may have just
            // refreshed the window while we were queued.
            if (System.currentTimeMillis() < freshUntil) return
            val a = activity ?: return  // No activity → caller is in a service or background; let them proceed
            BiometricGate.evaluate(a, title = title, subtitle = subtitle)
            freshUntil = System.currentTimeMillis() + window.inWholeMilliseconds
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
    }
}
