package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Phone-side builder-pairing parse + session-id parity. The session-id +
 * short-code vector is pinned identically on the builder (apps/builder-mac),
 * iOS (BuilderPairingTests) and the TS reference (apps/com builderPairingVector).
 */
class BuilderPairingTest {
    private fun hex(s: String): ByteArray =
        s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    @Test fun sessionId_vector() {
        assertEquals("F2x43pqWEQ9rjC9jLfItSh4RE0K3Izzb", BuilderPairing.sessionId(hex("0102030405")))
    }

    @Test fun base32_roundTrip() {
        assertEquals("AEBAGBAF", Base32.encode(hex("0102030405")))
        assertTrue(Base32.decode("AEBAGBAF")!!.contentEquals(hex("0102030405")))
        assertTrue(BuilderPairing.codeBytes("aeba-gbaf")!!.contentEquals(hex("0102030405")))
        assertNull(BuilderPairing.codeBytes("nope!!!"))
    }

    @Test fun parse_qrWithPubkey() {
        val pk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        val s = BuilderPairing.parse("flagship://builder?c=AEBAGBAF&k=$pk")!!
        assertTrue(s.codeBytes.contentEquals(hex("0102030405")))
        assertEquals(32, s.builderPublicKey?.size)
    }

    @Test fun parse_typedCodeOnly() {
        val s = BuilderPairing.parse("AEBA-GBAF")!!
        assertTrue(s.codeBytes.contentEquals(hex("0102030405")))
        assertNull(s.builderPublicKey)
    }

    @Test fun looksLikeBuilderCode() {
        assertTrue(BuilderPairing.looksLikeBuilderCode("flagship://builder?c=AEBAGBAF&k=x"))
        assertTrue(BuilderPairing.looksLikeBuilderCode("AEBAGBAF"))
        assertFalse(BuilderPairing.looksLikeBuilderCode("https://flagshipserver.com/qr?s=abc&k=def"))
    }
}
