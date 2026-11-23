// WebRTC's hook for the caller's TLS check of the callee phone's TURN server (TurnCertCheck): set as the peer
// connection's certificate verifier when placing a call, given the dialled name once the answer arrives.

package com.flagshipserver.app.calls

import android.util.Log
import org.webrtc.SSLCertificateVerifier

class TurnCertVerifier : SSLCertificateVerifier {
    @Volatile private var host: String? = null

    fun expect(turnUrl: String) {
        host = TurnCertCheck.host(turnUrl)
    }

    override fun verify(certificate: ByteArray): Boolean {
        val h = host ?: run {
            Log.i("FlagshipCalls", "turn tls: refused (no expected name)")
            return false
        }
        val ok = TurnCertCheck.verify(certificate, h)
        Log.i("FlagshipCalls", "turn tls: ${if (ok) "trusted" else "refused"}")
        return ok
    }
}
