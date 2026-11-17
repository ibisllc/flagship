// The libwebrtc AAR carries the generated JNI bridges its classes call (tools/libwebrtc/check-aar.py checks every one
// in CI). libwebrtc-157-43884507084 shipped without them: the first call threw NoClassDefFoundError at
// PeerConnectionFactory.initialize. The JVM can load the classes, not the native library; the instrumented
// WebRtcLibraryTest loads both.

package com.flagshipserver.app.calls

import org.junit.Assume.assumeTrue
import org.junit.Test

class WebRtcBridgesTest {
    @Test
    fun theAarCarriesItsJniBridges() {
        assumeTrue("built without libwebrtc (-Pflagship.webrtc=stub)", CallMediaFactory.BUNDLED)
        val loader = javaClass.classLoader
        for (name in listOf(
            "org.webrtc.PeerConnectionFactoryJni",
            "org.webrtc.PeerConnectionJni",
            "org.webrtc.FlagshipFrameCryptoJni",
            "org.webrtc.JniCommonJni",
            "org.webrtc.audio.JavaAudioDeviceModuleJni",
            "org.jni_zero.JniZeroJni",
        )) {
            Class.forName(name, false, loader)
        }
    }
}
