// Kotlin↔TS byte-identity for the lock-&-power-off + dead-man canonical
// bytes. Pins the SAME vectors as
// packages/protocol/tests/lockAndPowerOff.test.ts: a fixed-seed Ed25519 key
// signs the Kotlin canonical bytes, and a sig over the INDEPENDENTLY
// recomputed expected string must verify — proving the two encoders agree.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LockAndPowerOffTest {

    private val server = "home.alice.flagship.services"

    /** Mirror of the TS test's makeKey(seed): a 32-byte seed filled with one
     *  byte value, used as the Ed25519 private seed. */
    private fun keyPair(seed: Int): Ed25519Sign.KeyPair =
        Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { seed.toByte() })

    private fun verifies(sig: ByteArray, expected: String, pub: ByteArray): Boolean = try {
        Ed25519Verify(pub).verify(sig, expected.toByteArray(Charsets.UTF_8)); true
    } catch (_: Throwable) { false }

    // ---- power-off PhoneOrder ----

    @Test fun powerOff_off_canonicalBytes_matchTs() {
        val kp = keyPair(7)
        val sig = Ed25519Sign(kp.privateKey).sign(
            PowerOffOrder.canonicalBytes(server, PowerMode.OFF, 1700),
        )
        assertTrue(verifies(sig, "flagship/order/power-off/v1|$server|off|1700", kp.publicKey))
    }

    @Test fun powerOff_restart_canonicalBytes_matchTs() {
        val kp = keyPair(9)
        val sig = Ed25519Sign(kp.privateKey).sign(
            PowerOffOrder.canonicalBytes(server, PowerMode.RESTART, 42),
        )
        assertTrue(verifies(sig, "flagship/order/power-off/v1|$server|restart|42", kp.publicKey))
    }

    @Test fun powerOff_modeFlip_breaksSignature() {
        val kp = keyPair(13)
        val sig = Ed25519Sign(kp.privateKey).sign(
            PowerOffOrder.canonicalBytes(server, PowerMode.OFF, 1),
        )
        // The same sig must NOT verify against the restart canonical bytes.
        assertFalse(verifies(sig, "flagship/order/power-off/v1|$server|restart|1", kp.publicKey))
    }

    // ---- SetDeadManPolicy ----

    @Test fun setDeadManPolicy_canonicalBytes_matchTs() {
        val kp = keyPair(20)
        val windowMs = 24L * 3600_000
        val graceMs = 6L * 3600_000
        val sig = Ed25519Sign(kp.privateKey).sign(
            SetDeadManPolicy.canonicalBytes(server, true, windowMs, graceMs, PowerMode.OFF, 1000),
        )
        assertTrue(
            verifies(sig, "flagship/set-deadman-policy/v1|$server|1|$windowMs|$graceMs|off|1000", kp.publicKey),
        )
    }

    @Test fun setDeadManPolicy_enabledFlag_isInTheBytes() {
        val kp = keyPair(21)
        val w = 24L * 3600_000; val g = 6L * 3600_000
        val sig = Ed25519Sign(kp.privateKey).sign(
            SetDeadManPolicy.canonicalBytes(server, true, w, g, PowerMode.OFF, 1000),
        )
        // enabled=false → different bytes → must not verify.
        assertFalse(verifies(sig, "flagship/set-deadman-policy/v1|$server|0|$w|$g|off|1000", kp.publicKey))
        // lockoutMode=restart → different bytes → must not verify.
        assertFalse(verifies(sig, "flagship/set-deadman-policy/v1|$server|1|$w|$g|restart|1000", kp.publicKey))
    }

    // ---- DeadManAffirmation ----

    @Test fun deadManAffirmation_canonicalBytes_matchTs() {
        val kp = keyPair(30)
        val nonce = ByteArray(16) { 0xAB.toByte() }
        val nonceHex = "ab".repeat(16)
        val sig = Ed25519Sign(kp.privateKey).sign(
            DeadManAffirmation.canonicalBytes(server, nonce, 2000),
        )
        assertTrue(verifies(sig, "flagship/deadman-affirm/v1|$server|$nonceHex|2000", kp.publicKey))
    }

    @Test fun deadManAffirmation_nonceTamper_breaksSignature() {
        val kp = keyPair(32)
        val nonce = ByteArray(16) { 0xAB.toByte() }
        val sig = Ed25519Sign(kp.privateKey).sign(
            DeadManAffirmation.canonicalBytes(server, nonce, 2000),
        )
        val otherHex = "cd".repeat(16)
        assertFalse(verifies(sig, "flagship/deadman-affirm/v1|$server|$otherHex|2000", kp.publicKey))
    }

    // ---- enum wire round-trips ----

    @Test fun powerMode_wire_roundTrips() {
        assertEquals(PowerMode.OFF, PowerMode.fromWire("off"))
        assertEquals(PowerMode.RESTART, PowerMode.fromWire("restart"))
        assertEquals(null, PowerMode.fromWire("halt"))
        assertEquals("off", PowerMode.OFF.wire)
        assertEquals("restart", PowerMode.RESTART.wire)
    }
}
