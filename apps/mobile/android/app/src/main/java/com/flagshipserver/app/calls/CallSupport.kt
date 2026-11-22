// Whether this device can carry a call's media. Our libwebrtc and the TURN responder (libflagship_turn_ffi.so) are built
// for arm64-v8a, armeabi-v7a and x86_64 only (tools/libwebrtc/build-android.sh, .github/workflows/libwebrtc.yml), so a
// 32-bit x86 device installs the app without them. There the app says "Calls aren't available on this device." on an
// incoming call, on a call it places and in Calls settings, instead of failing without a word.

package com.flagshipserver.app.calls

object CallSupport {
    enum class State {
        Ready,
        /** A development build made without the libraries (-Pflagship.webrtc=stub): "This version … can't connect calls yet." */
        NotInThisBuild,
        /** The build has them, but not for this device's processor. */
        NotOnThisDevice,
    }

    fun decide(bundled: Boolean, librariesLoad: Boolean): State = when {
        !bundled -> State.NotInThisBuild
        !librariesLoad -> State.NotOnThisDevice
        else -> State.Ready
    }

    /** A seam for tests; null asks the system once. */
    @Volatile var forced: State? = null

    private val detected: State by lazy {
        decide(CallMediaFactory.BUNDLED, CallMediaFactory.BUNDLED && TurnResponder.available && webrtcLoads())
    }

    val state: State get() = forced ?: detected

    val unavailableOnThisDevice: Boolean get() = state == State.NotOnThisDevice

    // The library libwebrtc's own loader asks for (PeerConnectionFactory.initialize); loading it twice is a no-op.
    private fun webrtcLoads(): Boolean = runCatching { System.loadLibrary("jingle_peerconnection_so") }.isSuccess
}
