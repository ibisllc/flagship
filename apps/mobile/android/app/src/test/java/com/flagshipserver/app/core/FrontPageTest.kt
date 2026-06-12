// Kotlin↔TS byte-identity for the `set-front-page` canonical bytes. Pins the
// SAME vector as packages/protocol/tests/setFrontPage.test.ts: a fixed-seed
// Ed25519 key signs the Kotlin canonical bytes and a sig over the
// INDEPENDENTLY recomputed expected string must verify — plus the TS suite's
// pinned signature hex must verify against the bytes THIS mirror builds.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FrontPageTest {

    private val server = "home.alice.flagship.services"

    private fun keyPair(seed: Int): Ed25519Sign.KeyPair =
        Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { seed.toByte() })

    private fun verifies(sig: ByteArray, expected: ByteArray, pub: ByteArray): Boolean = try {
        Ed25519Verify(pub).verify(sig, expected); true
    } catch (_: Throwable) { false }

    @Test fun assign_canonicalBytes_matchTs() {
        val kp = keyPair(7)
        val sig = Ed25519Sign(kp.privateKey).sign(
            SetFrontPageOrder.canonicalBytes(server, "photos", 1700),
        )
        assertTrue(
            verifies(
                sig,
                "flagship/order/set-front-page/v1|$server|photos|1700".toByteArray(Charsets.UTF_8),
                kp.publicKey,
            ),
        )
    }

    @Test fun clear_emptyLabel_canonicalizesWithEmptyField() {
        assertEquals(
            "flagship/order/set-front-page/v1|$server||42",
            String(SetFrontPageOrder.canonicalBytes(server, "", 42), Charsets.UTF_8),
        )
    }

    /** The TS suite's pinned signature (seed-7 key, photos, 1700) must verify
     *  against the bytes THIS mirror builds — the cross-platform pin. */
    @Test fun tsPinnedVector_verifies() {
        val kp = keyPair(7)
        val tsSig = HexUtil.decode(
            "bc57770c09c3f54d9acdb628bd4767142ea035d944c88e7de340c10df84a67b9" +
                "aa62800fdb597624a3f49ccec222d2c46ff64eadaa80111964946240a2fc9405",
        )
        assertNotNull(tsSig)
        assertTrue(
            verifies(tsSig!!, SetFrontPageOrder.canonicalBytes(server, "photos", 1700), kp.publicKey),
        )
    }

    @Test fun labelFlip_breaksSignature() {
        val kp = keyPair(13)
        val sig = Ed25519Sign(kp.privateKey).sign(
            SetFrontPageOrder.canonicalBytes(server, "photos", 1),
        )
        assertTrue(!verifies(sig, SetFrontPageOrder.canonicalBytes(server, "evil", 1), kp.publicKey))
    }
}
