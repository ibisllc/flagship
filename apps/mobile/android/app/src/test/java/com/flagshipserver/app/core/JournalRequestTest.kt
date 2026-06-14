// Kotlin↔TS↔Swift byte-identity for the journal-read canonical bytes. A
// fixed-seed Ed25519 key signs the Kotlin canonical bytes, and a sig over the
// INDEPENDENTLY recomputed expected string must verify — proving the encoders
// agree with the daemon (journalHttp.ts) + webapp + iOS.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class JournalRequestTest {

    private val server = "home.alice.flagship.services"

    private fun keyPair(seed: Int): Ed25519Sign.KeyPair =
        Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { seed.toByte() })

    private fun verifies(sig: ByteArray, expected: String, pub: ByteArray): Boolean = try {
        Ed25519Verify(pub).verify(sig, expected.toByteArray(Charsets.UTF_8)); true
    } catch (_: Throwable) { false }

    @Test fun journal_canonicalBytes_matchTs() {
        val kp = keyPair(7)
        val sig = Ed25519Sign(kp.privateKey).sign(
            JournalRequest.canonicalBytes(server, "flagship-daemon", 200, 1700),
        )
        assertTrue(
            verifies(sig, "flagship/journal-read/v1|$server|flagship-daemon|200|1700", kp.publicKey),
        )
    }

    @Test fun journal_unitFlip_breaksSignature() {
        val kp = keyPair(13)
        val sig = Ed25519Sign(kp.privateKey).sign(
            JournalRequest.canonicalBytes(server, "flagship-daemon", 50, 1),
        )
        // A sig over the flagship-daemon bytes must NOT verify for another unit.
        assertFalse(
            verifies(sig, "flagship/journal-read/v1|$server|sshd|50|1", kp.publicKey),
        )
    }

    @Test fun journal_defaults_areSane() {
        assertTrue(JournalUnits.ALL.contains(JournalUnits.DEFAULT_UNIT))
        assertTrue(JournalUnits.DEFAULT_LINES in 1..JournalUnits.MAX_LINES)
    }
}
