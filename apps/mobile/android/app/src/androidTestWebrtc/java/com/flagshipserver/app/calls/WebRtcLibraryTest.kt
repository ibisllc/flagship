// Only in builds with our libwebrtc (app/build.gradle.kts adds this folder then). The first thing a call does is
// PeerConnectionFactory.initialize, which libwebrtc-157-43884507084 could not (its AAR lacked the generated JNI
// bridges): this loads the native library and crosses into it the ways a call does.

package com.flagshipserver.app.calls

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.webrtc.DataChannel
import org.webrtc.FlagshipFrameCrypto
import org.webrtc.IceCandidate
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.audio.JavaAudioDeviceModule

@RunWith(AndroidJUnit4::class)
class WebRtcLibraryTest {
    @Test
    fun initializesAndMakesAPeerConnectionWithFrameCrypto() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions())
        val adm = JavaAudioDeviceModule.builder(context).createAudioDeviceModule()
        val factory = PeerConnectionFactory.builder().setAudioDeviceModule(adm).createPeerConnectionFactory()
        val pc = factory.createPeerConnection(
            PeerConnection.RTCConfiguration(emptyList()).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN },
            object : PeerConnection.Observer {
                override fun onSignalingChange(state: PeerConnection.SignalingState) {}
                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
                override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
                override fun onIceCandidate(candidate: IceCandidate) {}
                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
                override fun onAddStream(stream: MediaStream) {}
                override fun onRemoveStream(stream: MediaStream) {}
                override fun onDataChannel(channel: DataChannel) {}
                override fun onRenegotiationNeeded() {}
            },
        )
        assertNotNull("createPeerConnection", pc)
        val track = factory.createAudioTrack("a", factory.createAudioSource(org.webrtc.MediaConstraints()))
        val sender = pc!!.addTrack(track, listOf("s"))
        val crypto = FlagshipFrameCrypto(object : FlagshipFrameCrypto.Delegate {
            override fun seal(video: Boolean, frame: ByteArray) = frame
            override fun open(video: Boolean, sealed: ByteArray) = sealed
        })
        crypto.attach(sender)
        crypto.dispose()
        pc.dispose()
        factory.dispose()
        adm.release()
    }
}
