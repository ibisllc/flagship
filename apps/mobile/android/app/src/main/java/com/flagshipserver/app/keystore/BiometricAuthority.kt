// Process-scoped BiometricPrompt gate. The MainActivity creates one,
// drops a reference on the static holder so Keystore.deriveIRK can
// reach it, and latches an "authenticated this session" flag on the
// first successful prompt so a screen-flow — or a whole unlocked
// session — with multiple signatures only triggers one prompt.

package com.flagshipserver.app.keystore

import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Indirection so the freshness logic is unit-testable without a real
 * FragmentActivity / BiometricPrompt. The production constructor binds
 * an activity; tests pass their own prompter (or null to simulate the
 * no-foreground-activity background-service case).
 */
fun interface BiometricPrompter {
    suspend fun prompt(title: String, subtitle: String)
}

class BiometricAuthority internal constructor(
    private val prompter: BiometricPrompter?,
) {
    private val mutex = Mutex()

    // Session freshness latch. Set true the first time the user authenticates
    // in an unlocked session, then stays true for every later derive so ONE
    // biometric covers the WHOLE session; cleared by [invalidate] on lock /
    // background / sign-out. This is SESSION-SCOPED, not a rolling time window:
    // a background reconcile that fires minutes after the last derive rides the
    // same authenticated session silently instead of re-prompting Face ID "at
    // random" once a stale >window-idle window expired. Deliberately NO time cap
    // — the biometric gates each SESSION and [invalidate] (wired to
    // isUnlocked -> false) is the only thing that ends one. Mirror of iOS's
    // in-memory session-key cache (Keystore.hasSessionKey / clearSessionKeyCache).
    @Volatile private var fresh: Boolean = false

    /** Production constructor — binds [activity] for BiometricPrompt. */
    constructor(activity: FragmentActivity) : this(
        prompter = BiometricPrompter { t, s -> BiometricGate.evaluate(activity, t, s) },
    )

    /**
     * Ensure a biometric session is fresh enough to release the IRK
     * seed. If the session is already authenticated, returns immediately.
     * Otherwise prompts and (on success) latches the session fresh. Cancel /
     * fail bubbles up as the underlying exception so callers can show a toast
     * or fall back to the unlock-flow.
     *
     * When the prompter is null (background callers — FCM service — with no
     * foreground activity bound), this is a no-op: the caller proceeds without
     * an authentication step. This matches iOS's LocalAuthentication behavior,
     * which is silently bypassed in background scope.
     */
    suspend fun ensureFresh(title: String, subtitle: String) {
        if (fresh) return
        mutex.withLock {
            // Re-check inside the lock — another caller may have just
            // authenticated the session while we were queued.
            if (fresh) return
            val p = prompter ?: run {
                com.flagshipserver.app.core.ErrorLog.step("biometric", "no prompter bound ($subtitle)")
                return
            }
            com.flagshipserver.app.core.ErrorLog.step("biometric", "ask ($subtitle)")
            p.prompt(title, subtitle)
            com.flagshipserver.app.core.ErrorLog.step("biometric", "passed")
            fresh = true
        }
    }

    /**
     * Always prompt, even inside an unlocked session: for consent that must be
     * given per act (one biometric per debug-access grant, like an admin
     * invite). With no foreground activity there is nobody to ask, so it refuses.
     */
    suspend fun confirmNow(title: String, subtitle: String) {
        val p = prompter ?: throw IllegalStateException("Open Flagship to confirm this.")
        mutex.withLock {
            p.prompt(title, subtitle)
            fresh = true
        }
    }

    /**
     * Non-prompting query: true iff the biometric session is already fresh, so a
     * derive can proceed WITHOUT a prompt. The automatic (reconcile/background)
     * deposit path checks this so it never *initiates* a biometric — it rides an
     * already-unlocked session or defers to the next one. Mirror of iOS
     * Keystore.hasSessionKey().
     */
    fun isFresh(): Boolean = fresh

    /** The lock screen's unlock runs the same prompt [ensureFresh] would, so it
     *  opens the session too (iOS keeps the account key from that unlock). */
    fun markFresh() {
        fresh = true
    }

    /** Clear the session freshness latch. Wired to isUnlocked -> false (lock /
     *  background / sign-out) so the next derive re-authenticates. */
    fun invalidate() {
        fresh = false
    }

    companion object {
        @Volatile private var current: BiometricAuthority? = null
        fun set(authority: BiometricAuthority?) { current = authority }
        fun current(): BiometricAuthority? = current

        /** Drop [authority] only if it is still the current one (a second
         *  activity being destroyed must not unbind the one on screen). */
        fun clearIf(authority: BiometricAuthority?) {
            if (current === authority) current = null
        }

        /** [confirmNow] on the bound authority; refuses when none is bound. */
        suspend fun confirmNow(subtitle: String) {
            val a = current ?: throw IllegalStateException("Open Flagship to confirm this.")
            a.confirmNow("Authorize Flagship", subtitle)
        }

        /** Test-only constructor — bypass the FragmentActivity wiring
         *  by injecting a prompter directly. */
        internal fun forTest(
            prompter: BiometricPrompter?,
        ): BiometricAuthority = BiometricAuthority(prompter)
    }
}
