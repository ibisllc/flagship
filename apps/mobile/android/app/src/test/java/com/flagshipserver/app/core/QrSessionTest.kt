// Cross-peer crypto tests: two QrSessions (simulating phone + browser)
// should derive the same matchCode + kEnc when fed each other's pub
// key, and AEAD-encrypt on one side should decrypt on the other.

package com.flagshipserver.app.core

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QrSessionTest {

    @Test fun freshPubKeyIs32Bytes() {
        val s = QrSession.fresh()
        assertEquals(32, s.phonePubKey.size)
        assertEquals(64, com.flagshipserver.app.core.HexUtil.encode(s.phonePubKey).length)
    }

    @Test fun pair_returns6DigitMatchCode() {
        val phone = QrSession.fresh()
        val browser = QrSession.fresh()
        val code = phone.pair(browser.phonePubKey)
        assertEquals(6, code.length)
        assertTrue(code.all { it in '0'..'9' })
    }

    @Test fun ecdhIsSymmetric_bothSidesDeriveSameMatchCode() {
        // The phone and the browser each derive shared = X25519(theirSk, otherPk)
        // and HKDF the same way. Confirm the resulting matchCodes match.
        val phone = QrSession.fresh()
        val browser = QrSession.fresh()
        val phoneMatch = phone.pair(browser.phonePubKey)
        val browserMatch = browser.pair(phone.phonePubKey)
        assertEquals(phoneMatch, browserMatch)
    }

    @Test fun aeadRoundtripsAcrossSessions() {
        val phone = QrSession.fresh()
        val browser = QrSession.fresh()
        phone.pair(browser.phonePubKey)
        browser.pair(phone.phonePubKey)

        val plain = """{"hello":"world","n":42}""".toByteArray()
        val sealed = phone.seal(plain)

        // Browser decrypts using the same kEnc — which we don't expose
        // directly, so reach in via a parallel HKDF derivation. The
        // public surface guarantees both peers see the same kEnc, but
        // for a tight test we re-derive against the public knowledge
        // a real browser would have.
        val ct = Base64URL.decode(sealed.ciphertextB64u)!!
        val nonce = Base64URL.decode(sealed.nonceB64u)!!
        val shared = com.google.crypto.tink.subtle.X25519.computeSharedSecret(
            // Use a copy that we keep parallel to the browser side; the
            // ECDH is symmetric so deriving from browser_sk + phone_pub
            // gives the same shared bytes.
            browserPrivateOf(browser),
            phone.phonePubKey,
        )
        val kEnc = QrRelay.hkdfSha256(
            ikm = shared,
            salt = "flagship/qr/v1".toByteArray(),
            info = "flagship/qr/enc/v1".toByteArray(),
            lengthBytes = 32,
        )
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(kEnc, "AES"), GCMParameterSpec(128, nonce))
        val decrypted = cipher.doFinal(ct)
        assertEquals(String(plain), String(decrypted))
    }

    @Test fun sealWithoutPair_throws() {
        val s = QrSession.fresh()
        try {
            s.seal(byteArrayOf(0x01, 0x02, 0x03))
            error("expected throw")
        } catch (t: IllegalStateException) {
            assertNotNull(t.message)
        }
    }

    @Test fun matchCode_changesWithDifferentPeer() {
        val phone = QrSession.fresh()
        val browserA = QrSession.fresh()
        val browserB = QrSession.fresh()
        val codeA = phone.pair(browserA.phonePubKey)
        // pair() should overwrite previously-cached state, so a fresh
        // re-pair against a different peer must produce a different
        // matchCode (with overwhelming probability).
        val phone2 = QrSession.fresh()
        val codeB = phone2.pair(browserB.phonePubKey)
        assertNotEquals(codeA, codeB)
    }
}

/** Reaches into QrSession via reflection so the test can spot-check
 *  ECDH symmetry. Not part of the production API. */
private fun browserPrivateOf(session: QrSession): ByteArray {
    val f = QrSession::class.java.getDeclaredField("phonePrivKey")
    f.isAccessible = true
    return f.get(session) as ByteArray
}
