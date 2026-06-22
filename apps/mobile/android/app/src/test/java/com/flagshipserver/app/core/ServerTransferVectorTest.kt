package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/**
 * Pins the Kotlin canonical bytes for the `server-transfer-offer` +
 * `server-transfer-claim` envelopes (transfer-a-box §4) to the EXACT
 * cross-platform vector. `.com` re-derives these to verify the giver/acquirer
 * IRK signatures, so any drift breaks box transfer.
 *
 * Mirror of the TS pin (`packages/protocol/tests/accountDeletionVectors.test.ts`)
 * and the Swift pin (`ServerTransferCanonicalTests.swift`).
 */
class ServerTransferVectorTest {
    private val nonce = "ab".repeat(32)

    @Test
    fun offerCanonicalBytes() {
        assertEquals(
            "flagship/server-transfer-offer/v1|home.alice.flagship.services|$nonce|1700|2000",
            String(
                ServerTransferOfferOrder.canonicalBytes("home.alice.flagship.services", nonce, 1700L, 2000L),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun offerLowercasesDomainAndNonce() {
        assertEquals(
            "flagship/server-transfer-offer/v1|home.alice.flagship.services|$nonce|1|2",
            String(
                ServerTransferOfferOrder.canonicalBytes("HOME.alice.flagship.services", "AB".repeat(32), 1L, 2L),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun claimCanonicalBytes() {
        val pubHex = "cd".repeat(32)
        assertEquals(
            "flagship/server-transfer-claim/v1|home.alice.flagship.services|$nonce|bob|$pubHex|1800",
            String(
                ServerTransferClaimOrder.canonicalBytes("home.alice.flagship.services", nonce, "Bob", pubHex, 1800L),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun signVerifyRoundTrip() {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val signer = Ed25519Sign(kp.privateKey)
        val verifier = Ed25519Verify(kp.publicKey)

        val offer = ServerTransferOfferOrder.canonicalBytes("home.alice.flagship.services", nonce, 1L, 2L)
        val osig = signer.sign(offer)
        verifier.verify(osig, offer)

        val claim = ServerTransferClaimOrder.canonicalBytes(
            "home.alice.flagship.services", nonce, "bob", "cd".repeat(32), 3L,
        )
        val csig = signer.sign(claim)
        verifier.verify(csig, claim)

        // An offer sig must NOT verify as a claim.
        try {
            verifier.verify(osig, claim)
            fail("offer sig must not verify as a claim")
        } catch (_: Throwable) {
            // expected
        }
    }
}
