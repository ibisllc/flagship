// A build without the CI's libwebrtc and TURN libraries (tools/libwebrtc, .github/workflows/libwebrtc.yml): calls ring
// but never connect. app/build.gradle.kts picks src/webrtc instead when the libraries are in vendor/webrtc.

package com.flagshipserver.app.calls

import android.content.Context

object CallMediaFactory {
    const val BUNDLED = false

    fun make(@Suppress("UNUSED_PARAMETER") context: Context): CallMediaEngine = StubCallMediaEngine()
}
