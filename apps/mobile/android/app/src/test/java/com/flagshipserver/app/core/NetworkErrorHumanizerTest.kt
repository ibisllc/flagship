// UX-A + UX-B — the humanizer maps transport throwables to plain language and
// surfaces a box cert-pin mismatch as its own distinguishable category (never
// folded into "you're offline"), while never leaking a raw status code.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLPeerUnverifiedException

class NetworkErrorHumanizerTest {

    private val pinFailure = SSLPeerUnverifiedException(
        "Certificate for x.box does not match the box's STK-signed " +
            "fingerprint — refusing connection",
    )

    @Test fun certPinMismatchIsItsOwnCategory() {
        val c = NetworkErrorHumanizer.classify(pinFailure)
        assertEquals(NetworkErrorHumanizer.Kind.CERT_PIN_MISMATCH, c.kind)
        assertTrue(c.message.contains("intercepting"))
    }

    @Test fun certPinMismatchDetectedThroughACauseChain() {
        val wrapped = IOException("network", pinFailure)
        assertTrue(NetworkErrorHumanizer.isCertPinMismatch(wrapped))
        assertEquals(
            NetworkErrorHumanizer.Kind.CERT_PIN_MISMATCH,
            NetworkErrorHumanizer.classify(wrapped).kind,
        )
    }

    @Test fun anOrdinaryTlsFailureIsNotACertPinMismatch() {
        // A handshake failure WITHOUT the box-fingerprint marker must not be
        // over-alarmed as interception.
        val plainTls = SSLPeerUnverifiedException("Hostname not verified")
        assertFalse(NetworkErrorHumanizer.isCertPinMismatch(plainTls))
    }

    @Test fun serverErrorIsTemporary() {
        val c = NetworkErrorHumanizer.classify(HttpException(503, "boom"))
        assertEquals(NetworkErrorHumanizer.Kind.SERVER_PROBLEM, c.kind)
        assertFalse(c.message.contains("503"))
        assertTrue(c.message.contains("try again", ignoreCase = true))
    }

    @Test fun clientErrorAsksToCheckConnection() {
        val c = NetworkErrorHumanizer.classify(HttpException(404, "nope"))
        assertEquals(NetworkErrorHumanizer.Kind.REQUEST_PROBLEM, c.kind)
        assertFalse(c.message.contains("404"))
    }

    @Test fun timeoutStatusReadsAsOffline() {
        val c = NetworkErrorHumanizer.classify(HttpException(408, "timeout"))
        assertEquals(NetworkErrorHumanizer.Kind.OFFLINE, c.kind)
    }

    @Test fun unknownHostReadsAsOffline() {
        val c = NetworkErrorHumanizer.classify(UnknownHostException("no dns"))
        assertEquals(NetworkErrorHumanizer.Kind.OFFLINE, c.kind)
        assertTrue(c.message.contains("offline", ignoreCase = true))
    }

    @Test fun socketTimeoutReadsAsOffline() {
        assertEquals(
            NetworkErrorHumanizer.Kind.OFFLINE,
            NetworkErrorHumanizer.classify(SocketTimeoutException()).kind,
        )
    }

    @Test fun aHasHttpStatusErrorIsClassifiedByItsStatus() {
        val err = object : RuntimeException("HTTP 500"), HasHttpStatus {
            override val httpStatus = 500
        }
        assertEquals(
            NetworkErrorHumanizer.Kind.SERVER_PROBLEM,
            NetworkErrorHumanizer.classify(err).kind,
        )
    }

    @Test fun unclassifiableErrorGetsAGenericMessageNotItsRawText() {
        val c = NetworkErrorHumanizer.classify(IllegalStateException("kotlinx.serialization boom"))
        assertEquals(NetworkErrorHumanizer.Kind.UNKNOWN, c.kind)
        assertFalse(c.message.contains("kotlinx"))
    }
}
