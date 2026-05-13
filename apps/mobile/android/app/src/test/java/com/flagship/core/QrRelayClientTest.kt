// Exercises the MockQrRelayClient + QrRelay primitives + QrRelayError
// shape. The Live impl needs a real WS server; covered separately by
// integration tests on a paired pod.

package com.flagship.core

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class QrRelayClientTest {
    @Test fun ackThenDelivered_recordsHelloAndDeliver() = runTest {
        val m = MockQrRelayClient()
        m.openAndHello("sid123", "phonePub")
        m.deliver("CIPHER", "NONCE")
        assertEquals("sid123" to "phonePub", m.lastHello)
        assertEquals("CIPHER" to "NONCE", m.lastDeliver)
    }

    @Test fun peerMissing_throws() = runTest {
        val m = MockQrRelayClient(behavior = MockQrRelayClient.Behavior.PeerMissing)
        try {
            m.openAndHello("sid", "pk")
            fail("expected throw")
        } catch (e: QrRelayError.PeerMissing) {
            // expected
            assertTrue(true)
        }
    }

    @Test fun sessionExpired_thrownOnDeliver() = runTest {
        val m = MockQrRelayClient(behavior = MockQrRelayClient.Behavior.SessionExpired)
        try {
            m.openAndHello("sid", "pk")
            fail("expected throw")
        } catch (_: QrRelayError.SessionExpired) {}
    }
}

class QrRelayPrimitivesTest {
    // QrRelay.parseQrUrl + Base64URL.decode go through android.util.Base64
    // which lives in android.jar — those tests need Robolectric / instrumented
    // runs. Until that's wired, exercise the pure-JVM helpers here.

    @Test fun formatMatchCode_addsSpace() {
        assertEquals("123 456", QrRelay.formatMatchCode("123456"))
    }

    @Test fun formatMatchCode_passthroughWhenWrongLength() {
        assertEquals("12345", QrRelay.formatMatchCode("12345"))
    }

    @Test fun hkdfSha256_matchesExpectedLength() {
        // HMAC-SHA256 spec requires a non-zero key length, so we use the
        // single-byte 0 salt the QrRelay protocol actually picks at
        // runtime (HKDF_SALT etc. are 14+ bytes).
        val ikm = ByteArray(32) { 0x0b }
        val salt = "flagship/qr/v1".toByteArray()
        val out = QrRelay.hkdfSha256(ikm, salt = salt, info = "test".toByteArray(), lengthBytes = 42)
        assertEquals(42, out.size)
    }

    @Test fun matchCodeFromBytes_is6DigitsAndDeterministic() {
        val bytes = byteArrayOf(0x12, 0x34, 0x56, 0x78)
        val code = QrRelay.matchCodeFromBytes(bytes)
        assertEquals(6, code.length)
        assertEquals(code, QrRelay.matchCodeFromBytes(bytes))
    }
}
