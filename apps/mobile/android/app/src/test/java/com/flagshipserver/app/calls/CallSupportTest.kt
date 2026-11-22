package com.flagshipserver.app.calls

import org.junit.Assert.assertEquals
import org.junit.Test

/** A 32-bit x86 device gets the app without our libwebrtc and TURN libraries: it says so, unlike a stub build. */
class CallSupportTest {
    @Test fun aBuildWithoutTheLibrariesIsNotTheDevicesFault() {
        assertEquals(CallSupport.State.NotInThisBuild, CallSupport.decide(bundled = false, librariesLoad = false))
    }

    @Test fun librariesThatDoNotLoadMeanThisDevice() {
        assertEquals(CallSupport.State.NotOnThisDevice, CallSupport.decide(bundled = true, librariesLoad = false))
    }

    @Test fun librariesThatLoadAreReady() {
        assertEquals(CallSupport.State.Ready, CallSupport.decide(bundled = true, librariesLoad = true))
    }
}
