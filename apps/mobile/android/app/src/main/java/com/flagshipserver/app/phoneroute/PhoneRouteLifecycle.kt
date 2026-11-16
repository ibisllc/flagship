// When the phone's tunnel (its bare name, docs/architecture-v2/phone-route.md section 4) is open: while the app is in
// the foreground, and while a voi.ci call rings or runs on this device. A call's media reaches the phone only through
// its bare name (`turns:<account>.<apex>:443`, docs/voici-calls.md section 4), and a call is answered from the lock
// screen or a notification with the app in the background, so a foreground-only tunnel left such a call without a path
// for its media. Same rules as iOS PhoneRouteLifecycle.swift.

package com.flagshipserver.app.phoneroute

class PhoneRouteLifecycle {
    var foreground = false
        private set
    var calls = 0
        private set

    val wantsTunnel: Boolean get() = foreground || calls > 0

    /** Each returns whether the tunnel should now be open. */
    fun enterForeground(): Boolean { foreground = true; return wantsTunnel }
    fun enterBackground(): Boolean { foreground = false; return wantsTunnel }
    fun callStarted(): Boolean { calls += 1; return wantsTunnel }
    fun callEnded(): Boolean { calls = maxOf(0, calls - 1); return wantsTunnel }
}
