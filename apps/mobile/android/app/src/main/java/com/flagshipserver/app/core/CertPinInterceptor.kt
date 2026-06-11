// TLS glue enforcing the box cert-fingerprint pin (cert-model A′, phase 4 —
// HARD-FAIL, locked decision). Two seams, both delegating to the pure
// CertPinDecision.accept:
//
//  - CertPinHostnameVerifier runs on EVERY TLS handshake — including
//    WebSocket upgrades, which OkHttp routes around network interceptors
//    (RealCall skips client.networkInterceptors when forWebSocket) — after
//    the platform's default chain validation and OkHttp's own hostname
//    verification have accepted the connection. This is what covers the
//    Screens/browser-stream sockets.
//  - CertPinInterceptor (network interceptor) re-checks per REQUEST on the
//    established connection, so a pin learned AFTER a connection was pooled
//    is still enforced against reused connections.
//
// (OkHttp's own CertificatePinner pins SPKI hashes, not whole-cert DER, so
// it can't carry the STK-signed fingerprint.) Hosts with no pin are
// untouched (default validation stands); hosts not under a known box never
// match the registry at all.

package com.flagshipserver.app.core

import okhttp3.Interceptor
import okhttp3.Response
import okhttp3.internal.tls.OkHostnameVerifier
import java.security.MessageDigest
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSession

internal fun leafDerSha256Hex(leafDer: ByteArray?): String? =
    leafDer?.let { HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(it)) }

class CertPinInterceptor(private val pinFor: (String) -> String?) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        enforce(
            host = chain.request().url.host,
            leafDer = chain.connection()?.handshake()?.peerCertificates?.firstOrNull()?.encoded,
            pinFor = pinFor,
        )
        return chain.proceed(chain.request())
    }

    companion object {
        /** Throws SSLPeerUnverifiedException unless the connection passes the
         *  pin decision. `leafDer == null` (cleartext / no handshake) on a
         *  PINNED host is refused — a pinned box is HTTPS by construction. */
        fun enforce(host: String, leafDer: ByteArray?, pinFor: (String) -> String?) {
            if (!CertPinDecision.accept(leafDerSha256Hex(leafDer), host, pinFor)) {
                throw SSLPeerUnverifiedException(
                    "Certificate for $host does not match the box's STK-signed " +
                        "fingerprint — refusing connection",
                )
            }
        }
    }
}

/** Wraps the default verifier (delegate FIRST — default hostname semantics
 *  are a precondition, never weakened), then applies the pin decision to the
 *  session's leaf cert. Unpinned hosts never touch the peer-cert chain. */
class CertPinHostnameVerifier(
    private val pinFor: (String) -> String?,
    private val delegate: HostnameVerifier = OkHostnameVerifier,
) : HostnameVerifier {
    override fun verify(hostname: String, session: SSLSession): Boolean {
        if (!delegate.verify(hostname, session)) return false
        if (pinFor(hostname) == null) return true
        val leafDer = try {
            session.peerCertificates.firstOrNull()?.encoded
        } catch (_: Throwable) {
            null
        }
        return CertPinDecision.accept(leafDerSha256Hex(leafDer), hostname, pinFor)
    }
}
