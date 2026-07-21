package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/**
 * Pins the Kotlin canonical bytes for the `server-transfer-offer` +
 * `server-transfer-claim` (v2) + `admin-root-transfer` envelopes
 * (transfer-a-box §4, device-admin-tier §9.8) to the EXACT cross-platform
 * vector. `.com`/the box re-derive these to verify the giver/acquirer
 * signatures, so any drift breaks box transfer.
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
        val adminHex = "ef".repeat(32)
        assertEquals(
            "flagship/server-transfer-claim/v2|home.alice.flagship.services|$nonce|bob|$pubHex|$adminHex|1800",
            String(
                ServerTransferClaimOrder.canonicalBytes(
                    "home.alice.flagship.services", nonce, "Bob", pubHex, "EF".repeat(32), 1800L,
                ),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun claimCanonicalBytesEmptyAdminRoot() {
        // No admin root on the acquirer account ⇒ the v2 slot is the EMPTY string.
        val pubHex = "cd".repeat(32)
        assertEquals(
            "flagship/server-transfer-claim/v2|home.alice.flagship.services|$nonce|bob|$pubHex||1800",
            String(
                ServerTransferClaimOrder.canonicalBytes(
                    "home.alice.flagship.services", nonce, "Bob", pubHex, "", 1800L,
                ),
                Charsets.UTF_8,
            ),
        )
    }

    // §9.8 hand-off proof — fixed-input pins (mirrors the AdminRootRotation
    // canonical vector style; the box re-derives these to verify the giver's
    // admin-root signature before re-pinning).

    @Test
    fun adminRootTransferCanonicalBytes() {
        val old = "11".repeat(32)
        val new = "22".repeat(32)
        assertEquals(
            "flagship/admin-root-transfer/v1|home.alice.flagship.services|alice|bob|$old|$new|$nonce|1900",
            String(
                AdminRootTransferClaim.canonicalBytes(
                    "HOME.alice.flagship.services", "Alice", "Bob",
                    "11".repeat(32).uppercase(), "22".repeat(32).uppercase(), "AB".repeat(32), 1900L,
                ),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun adminRootTransferEmptyNewRootMeansUnpin() {
        val old = "11".repeat(32)
        assertEquals(
            "flagship/admin-root-transfer/v1|home.alice.flagship.services|alice|bob|$old||$nonce|1900",
            String(
                AdminRootTransferClaim.canonicalBytes(
                    "home.alice.flagship.services", "alice", "bob", old, "", nonce, 1900L,
                ),
                Charsets.UTF_8,
            ),
        )
    }

    // v1-sec GAP 3 — the LEGACY re-home authorization. `.com` reconstructs it
    // from the claimed row and the box re-verifies against its pinned owner IRK.

    @Test
    fun rehomeAuthorizationCanonicalBytes() {
        val acq = "cd".repeat(32)
        assertEquals(
            "flagship/server-rehome-auth/v1|home.alice.flagship.services|home.bob.flagship.services|$acq|1800",
            String(
                RehomeAuthorizationOrder.canonicalBytes(
                    "home.alice.flagship.services", "home.bob.flagship.services", acq, 1800L,
                ),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun rehomeAuthorizationLowercasesDomains() {
        val acq = "cd".repeat(32)
        assertEquals(
            "flagship/server-rehome-auth/v1|home.alice.flagship.services|home.bob.flagship.services|$acq|5",
            String(
                RehomeAuthorizationOrder.canonicalBytes(
                    "HOME.ALICE.flagship.services", "HOME.BOB.flagship.services", "CD".repeat(32), 5L,
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

        val offer = ServerTransferOfferOrder.canonicalBytes("home.alice.flagship.services", nonce, 1L, 2L)
        val osig = signer.sign(offer)
        verifier.verify(osig, offer)

        val claim = ServerTransferClaimOrder.canonicalBytes(
            "home.alice.flagship.services", nonce, "bob", "cd".repeat(32), "", 3L,
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
