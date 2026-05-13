// Recovery.wrap / Recovery.unwrap roundtrip + cross-key isolation.
// Pure-JVM — no Robolectric needed.

package com.flagshipserver.app.keystore

import java.security.SecureRandom
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.fail
import org.junit.Test

class RecoveryWrapTest {
    private fun rand(n: Int): ByteArray =
        ByteArray(n).also { SecureRandom().nextBytes(it) }

    @Test fun roundtripsUmkSeed() {
        val seed = rand(32)
        val prf = rand(32)
        val sealed = Recovery.wrap(seed, prf)
        val recovered = Recovery.unwrap(sealed.ciphertextBase64, sealed.nonceBase64, prf)
        assertArrayEquals(seed, recovered)
    }

    @Test fun differentPrfSecretsFailToDecrypt() {
        val seed = rand(32)
        val prfA = rand(32)
        val prfB = rand(32)
        val sealed = Recovery.wrap(seed, prfA)
        try {
            Recovery.unwrap(sealed.ciphertextBase64, sealed.nonceBase64, prfB)
            fail("expected GCM tag failure")
        } catch (_: javax.crypto.AEADBadTagException) { /* ok */ }
    }

    @Test fun nonceIsFreshOnEverySeal() {
        val seed = rand(32)
        val prf = rand(32)
        val a = Recovery.wrap(seed, prf)
        val b = Recovery.wrap(seed, prf)
        assertNotEquals(a.nonceBase64, b.nonceBase64)
        assertNotEquals(a.ciphertextBase64, b.ciphertextBase64)
    }
}
