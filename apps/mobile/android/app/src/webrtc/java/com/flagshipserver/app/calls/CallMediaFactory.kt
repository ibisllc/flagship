// A build with our libwebrtc and TURN libraries (tools/libwebrtc, .github/workflows/libwebrtc.yml).

package com.flagshipserver.app.calls

import android.content.Context

object CallMediaFactory {
    const val BUNDLED = true

    fun make(context: Context): CallMediaEngine =
        if (TurnResponder.available) WebRtcCallMediaEngine(context.applicationContext) else StubCallMediaEngine()
}
