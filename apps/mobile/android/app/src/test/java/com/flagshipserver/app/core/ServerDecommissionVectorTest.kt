package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/**
 * Pins the Kotlin canonical bytes for the `server-decommission` envelope
 * (graceful replacement; docs/server-replacement-graceful-decommission.md §6)
 * to the EXACT cross-platform vector. The box re-derives these bytes
 * (`canonicalServerDecommission` in `packages/protocol/src/legacyEnvelopes.ts`)
 * to verify the owner-IRK signature, so any drift in the tag, `|` separator,
 * field order, lowercasing, the boolean "1"/"0" encoding, or the number
 * stringification breaks the eviction order.
 *
 * Mirror of the TS pin (`packages/protocol/tests/serverDecommissionVectors.test.ts`)
 * and the Swift pin (`ServerDecommissionCanonicalTests.swift`).
 */
class ServerDecommissionVectorTest {
    private val stk = "aa".repeat(32) // 64 'a' chars
    private val vectorCanonical =
        "flagship/server-decommission/v1|home.alice.flagship.services|$stk|1|wipe-after-handoff|7|deadbeef|1700"

    @Test
    fun canonicalBytesMatchPinnedVector() {
        assertEquals(
            vectorCanonical,
            String(
                ServerDecommissionOrder.canonicalBytes(
                    "home.alice.flagship.services", stk, true, "wipe-after-handoff", 7L, "deadbeef", 1700L,
                ),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun lowercasesPodAndStkAndNonce() {
        assertEquals(
            vectorCanonical,
            String(
                ServerDecommissionOrder.canonicalBytes(
                    "HOME.Alice.Flagship.Services", "AA".repeat(32), true, "wipe-after-handoff", 7L, "DEADBEEF", 1700L,
                ),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun finalBackupFalseEncodesAsZero() {
        assertEquals(
            "flagship/server-decommission/v1|home.alice.flagship.services|$stk|0|wipe-after-handoff|0|deadbeef|1700",
            String(
                ServerDecommissionOrder.canonicalBytes(
                    "home.alice.flagship.services", stk, false, "wipe-after-handoff", 0L, "deadbeef", 1700L,
                ),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun signVerifyRoundTrip() {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val signer = Ed25519Sign(kp.privateKey)
        val verifier = Ed25519Verify(kp.publicKey)

        val order = ServerDecommissionOrder.canonicalBytes(
            "home.alice.flagship.services", stk, true, "wipe-after-handoff", 7L, "deadbeef", 1700L,
        )
        // The canonical bytes equal the pinned cross-platform string …
        assertEquals(vectorCanonical, String(order, Charsets.UTF_8))
        // … and a signature over those exact bytes verifies.
        val sig = signer.sign(order)
        verifier.verify(sig, order) // throws on mismatch — reaching here = ok

        // The STK-binding is in the bytes: a different retiredStk ⇒ different bytes,
        // so the captured signature must NOT verify against them.
        val other = ServerDecommissionOrder.canonicalBytes(
            "home.alice.flagship.services", "bb".repeat(32), true, "wipe-after-handoff", 7L, "deadbeef", 1700L,
        )
        try {
            verifier.verify(sig, other)
            fail("decommission sig for instance A must not verify as instance B")
        } catch (_: Throwable) {
            // expected
        }
    }
}
