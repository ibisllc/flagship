package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Phone-side burner-pairing parse + session-id parity. The session-id +
 * short-code vector is pinned identically on the burner (apps/burner-mac),
 * iOS (BurnerPairingTests) and the TS reference (apps/com burnerPairingVector).
 */
class BurnerPairingTest {
    private fun hex(s: String): ByteArray =
        s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    @Test fun sessionId_vector() {
        assertEquals("KW3_KaK0uN8rcrQCLmsOJXXfhr9EEpib", BurnerPairing.sessionId(hex("0102030405")))
    }

    @Test fun base32_roundTrip() {
        assertEquals("AEBAGBAF", Base32.encode(hex("0102030405")))
        assertTrue(Base32.decode("AEBAGBAF")!!.contentEquals(hex("0102030405")))
        assertTrue(BurnerPairing.codeBytes("aeba-gbaf")!!.contentEquals(hex("0102030405")))
        assertNull(BurnerPairing.codeBytes("nope!!!"))
    }

    @Test fun parse_qrWithPubkey() {
        val pk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        val s = BurnerPairing.parse("flagship://burner?c=AEBAGBAF&k=$pk")!!
        assertTrue(s.codeBytes.contentEquals(hex("0102030405")))
        assertEquals(32, s.burnerPublicKey?.size)
    }

    @Test fun parse_typedCodeOnly() {
        val s = BurnerPairing.parse("AEBA-GBAF")!!
        assertTrue(s.codeBytes.contentEquals(hex("0102030405")))
        assertNull(s.burnerPublicKey)
    }

    @Test fun looksLikeBurnerCode() {
        assertTrue(BurnerPairing.looksLikeBurnerCode("flagship://burner?c=AEBAGBAF&k=x"))
        assertTrue(BurnerPairing.looksLikeBurnerCode("AEBAGBAF"))
        assertFalse(BurnerPairing.looksLikeBurnerCode("https://flagshipserver.com/qr?s=abc&k=def"))
    }
}
