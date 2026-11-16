// The steps of connecting an answered call on this phone, in the order they happen (the call screen's status line;
// the caller's browser shows its own, flagship-web VOICI_CALL_STEPS): holding this phone's bare name, the signed
// quantum-safe answer until `.com` says this device won, the caller's TURN stream and ICE through it, then DTLS until
// the first media. Same rules as iOS VoiciCallConnectSteps.swift.

package com.flagshipserver.app.calls

enum class VoiciCallConnectStep { Route, Secure, Path, Audio }

/**
 * Forward only: a late event never shows an earlier step. One step past [SLOW_MS] shows "This is taking longer than
 * usual"; connecting past [LIMIT_MS] in all ends the call as "The call couldn't connect."
 */
class VoiciCallConnectSteps {
    var current: VoiciCallConnectStep? = null
        private set

    /** True when [step] is new and later than the current one. */
    @Synchronized
    fun advance(step: VoiciCallConnectStep): Boolean {
        val c = current
        if (c != null && step.ordinal <= c.ordinal) return false
        current = step
        return true
    }

    @Synchronized
    fun reset() { current = null }

    companion object {
        const val SLOW_MS = 20_000L
        const val LIMIT_MS = 45_000L
    }
}
