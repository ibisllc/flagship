// A′ phase 4 — the enforcement half: accept on fingerprint match, HARD-FAIL
// on mismatch, pass-through when no pin exists for the host (locked
// semantics), across the pure decision, the interceptor seam, and the
// hostname-verifier seam (the one that covers WebSocket upgrades).

package com.flagshipserver.app.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Proxy
import java.security.MessageDigest
import java.security.PublicKey
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSession

class CertPinEnforcementTest {

    private val leafDer = byteArrayOf(0x30, 0x42, 0x01, 0x7f, -1, 0)
    private val leafSha = HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(leafDer))
    private val host = "abc5.harry1.flagship.services"
    private val pinned: (String) -> String? = { if (it == host) leafSha else null }
    private val pinnedWrong: (String) -> String? = { if (it == host) "ab".repeat(32) else null }
    private val noPins: (String) -> String? = { null }

    // ---- CertPinDecision (pure) ----

    @Test fun acceptsWhenLeafMatchesThePin() {
        assertTrue(CertPinDecision.accept(leafSha, host, pinned))
        assertTrue(CertPinDecision.accept(leafSha.uppercase(), host, pinned))
    }

    @Test fun refusesWhenLeafMismatchesThePin() {
        assertFalse(CertPinDecision.accept(leafSha, host, pinnedWrong))
    }

    @Test fun refusesAPinnedHostWithNoLeaf() {
        assertFalse(CertPinDecision.accept(null, host, pinned))
    }

    @Test fun passesThroughWhenNoPinExists() {
        assertTrue(CertPinDecision.accept(leafSha, host, noPins))
        assertTrue(CertPinDecision.accept(null, host, noPins))
        assertTrue(CertPinDecision.accept("ab".repeat(32), host, noPins))
    }

    // ---- CertPinInterceptor.enforce (per-request seam) ----

    @Test fun enforcePassesAMatchingLeaf() {
        CertPinInterceptor.enforce(host, leafDer, pinned)
    }

    @Test fun enforceThrowsOnAMismatchedLeaf() {
        assertThrows(SSLPeerUnverifiedException::class.java) {
            CertPinInterceptor.enforce(host, leafDer, pinnedWrong)
        }
    }

    @Test fun enforceThrowsOnAPinnedHostWithNoHandshake() {
        assertThrows(SSLPeerUnverifiedException::class.java) {
            CertPinInterceptor.enforce(host, null, pinned)
        }
    }

    @Test fun enforceIgnoresUnpinnedHosts() {
        CertPinInterceptor.enforce("flagshipserver.com", null, noPins)
        CertPinInterceptor.enforce("flagshipserver.com", leafDer, noPins)
    }

    // ---- CertPinHostnameVerifier (handshake seam — covers WebSockets) ----

    private val delegateTrue = HostnameVerifier { _, _ -> true }
    private val delegateFalse = HostnameVerifier { _, _ -> false }

    private fun session(der: ByteArray?): SSLSession {
        val cert = object : java.security.cert.Certificate("X.509") {
            override fun getEncoded(): ByteArray = der ?: throw UnsupportedOperationException()
            override fun verify(key: PublicKey?) = Unit
            override fun verify(key: PublicKey?, sigProvider: String?) = Unit
            override fun toString(): String = "test-cert"
            override fun getPublicKey(): PublicKey = throw UnsupportedOperationException()
        }
        return Proxy.newProxyInstance(
            SSLSession::class.java.classLoader,
            arrayOf(SSLSession::class.java),
        ) { _, method, _ ->
            when (method.name) {
                "getPeerCertificates" ->
                    if (der != null) arrayOf<java.security.cert.Certificate>(cert)
                    else throw SSLPeerUnverifiedException("no peer certs")
                else -> throw UnsupportedOperationException(method.name)
            }
        } as SSLSession
    }

    @Test fun verifierAcceptsAMatchingLeaf() {
        val v = CertPinHostnameVerifier(pinned, delegateTrue)
        assertTrue(v.verify(host, session(leafDer)))
    }

    @Test fun verifierRefusesAMismatchedLeaf() {
        val v = CertPinHostnameVerifier(pinnedWrong, delegateTrue)
        assertFalse(v.verify(host, session(leafDer)))
    }

    @Test fun verifierRefusesAPinnedHostWithUnverifiedPeer() {
        val v = CertPinHostnameVerifier(pinned, delegateTrue)
        assertFalse(v.verify(host, session(null)))
    }

    @Test fun verifierNeverWeakensTheDelegate() {
        val v = CertPinHostnameVerifier(pinned, delegateFalse)
        assertFalse(v.verify(host, session(leafDer)))
    }

    @Test fun verifierLeavesUnpinnedHostsToTheDelegateAlone() {
        // The session would throw on any peer-cert access: an unpinned host
        // must never reach it.
        val v = CertPinHostnameVerifier(noPins, delegateTrue)
        assertTrue(v.verify("flagshipserver.com", session(null)))
    }
}
