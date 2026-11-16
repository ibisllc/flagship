package com.flagshipserver.app.phoneroute

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone's bare name must stay held while a voi.ci call rings or runs, foreground or not: a call answered from the
 * lock screen runs with the app in the background, and its media reaches the phone only through that name.
 */
class PhoneRouteLifecycleTest {
    @Test fun foregroundOnlyWithoutCalls() {
        val l = PhoneRouteLifecycle()
        assertTrue(l.enterForeground())
        assertFalse(l.enterBackground())
    }

    @Test fun callAnsweredInTheBackgroundHoldsTheRoute() {
        val l = PhoneRouteLifecycle()
        assertTrue(l.callStarted())
        assertTrue(l.enterBackground())
        assertFalse(l.callEnded())
    }

    @Test fun leavingTheForegroundDuringACallKeepsTheRoute() {
        val l = PhoneRouteLifecycle()
        l.enterForeground()
        l.callStarted()
        assertTrue(l.enterBackground())
        assertFalse(l.callEnded())
    }

    @Test fun callEndingInTheForegroundKeepsTheRoute() {
        val l = PhoneRouteLifecycle()
        l.callStarted()
        l.enterForeground()
        assertTrue(l.callEnded())
        assertFalse(l.callEnded())
        assertFalse(l.enterBackground())
    }
}
