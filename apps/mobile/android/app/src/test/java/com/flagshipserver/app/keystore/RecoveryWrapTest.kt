// Recovery.wrap / Recovery.unwrap roundtrip + cross-key isolation.
// wrap now returns ONE self-contained base64 blob (nonce ‖ ct ‖ tag) —
// the exact `wrappedUmk` value that ships on the wire. Pure-JVM — no
// Robolectric needed.

package com.flagshipserver.app.keystore

import java.security.SecureRandom
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RecoveryWrapTest {
    private fun rand(n: Int): ByteArray =
        ByteArray(n).also { SecureRandom().nextBytes(it) }

    @Test fun roundtripsUmkSeed() {
        val seed = rand(32)
        val prf = rand(32)
        val wrapped = Recovery.wrap(seed, prf)
        val recovered = Recovery.unwrap(wrapped, prf)
        assertArrayEquals(seed, recovered)
    }

    @Test fun wrappedBlobIsSelfContained() {
        // nonce(12) + ct(32 == seed) + tag(16) = 60 bytes inside the blob.
        val wrapped = Recovery.wrap(rand(32), rand(32))
        val raw = java.util.Base64.getDecoder().decode(wrapped)
        assertTrue("blob carries nonce+ct+tag", raw.size == 12 + 32 + 16)
    }

    @Test fun differentPrfSecretsFailToDecrypt() {
        val seed = rand(32)
        val prfA = rand(32)
        val prfB = rand(32)
        val wrapped = Recovery.wrap(seed, prfA)
        try {
            Recovery.unwrap(wrapped, prfB)
            fail("expected GCM tag failure")
        } catch (_: javax.crypto.AEADBadTagException) { /* ok */ }
    }

    @Test fun nonceIsFreshOnEverySeal() {
        val seed = rand(32)
        val prf = rand(32)
        val a = Recovery.wrap(seed, prf)
        val b = Recovery.wrap(seed, prf)
        // Distinct nonces ⇒ distinct blobs even for the same seed+prf.
        assertNotEquals(a, b)
    }
}
