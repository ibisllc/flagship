package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

/**
 * Pins the Kotlin canonical bytes for the `server-migration` order + control
 * envelopes (docs/server-migration.md) to the EXACT cross-platform vectors in
 * `packages/protocol/tests/serverMigrationVectors.test.ts`. `.com` re-derives
 * these bytes to verify the admin signature, so any drift in the tag, `|`
 * separator, field order, the lowercasing, or the number stringification
 * would break the migration lane.
 *
 * Tink's Ed25519Sign is RFC8032-deterministic (like the TS `ed.sign`), so the
 * vector-key signatures are asserted as EXACT hex — byte-for-byte the pinned
 * TS output. Mirror of the TS pin and the Swift verify-way pin
 * (`ServerMigrationCanonicalTests.swift`; CryptoKit signing is randomized).
 */
class ServerMigrationVectorTest {
    /** seed = 32×0x07 → this Ed25519 pub (the TS `makeKey(7)` vector key). */
    private val vectorSeed = ByteArray(32) { 7 }
    private val vectorPubHex =
        "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"

    private val stk = "aa".repeat(32)
    private val orderCanonical =
        "flagship/server-migration/v1|home.alice.flagship.services|$stk|wipe-after-handoff|deadbeef|1700"
    private val orderPinnedSigHex =
        "26ecec473730a5b84f043e3a25da1b41a27e07b65302701f327779d1fd119cb6" +
            "072fbc79d3bed9ed65f67113aaa6549f809a2e0b45b0abd1c7825895dc601f06"

    private val controlCanonical =
        "flagship/server-migration-control/v1|home.alice.flagship.services|abort|0badcafe|1800"
    private val controlPinnedSigHex =
        "9387fc92a2f85b473655500099f591d2157e2e9da7caa6fc96d310cffc05bc91" +
            "0ecd4e3b20a218992686cc547bb233af0241925d6f19f7d64e95f4a055ec070e"

    private fun orderBytes(
        serverDomain: String = "home.alice.flagship.services",
        oldStkPubHex: String = stk,
        diskDisposition: String = "wipe-after-handoff",
        nonce: String = "deadbeef",
        issuedAt: Long = 1700L,
    ) = ServerMigrationOrder.canonicalBytes(serverDomain, oldStkPubHex, diskDisposition, nonce, issuedAt)

    private fun controlBytes(
        serverDomain: String = "home.alice.flagship.services",
        action: String = "abort",
        nonce: String = "0badcafe",
        issuedAt: Long = 1800L,
    ) = ServerMigrationControl.canonicalBytes(serverDomain, action, nonce, issuedAt)

    @Test
    fun vectorKeyMatchesPinnedPub() {
        assertEquals(
            vectorPubHex,
            HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(vectorSeed).publicKey),
        )
    }

    // ── Order ─────────────────────────────────────────────────────────────────

    @Test
    fun orderCanonicalBytesMatchPinnedVector() {
        assertEquals(orderCanonical, String(orderBytes(), Charsets.UTF_8))
    }

    @Test
    fun orderSignatureIsExactlyThePinnedTsHex() {
        val sig = Ed25519Sign(vectorSeed).sign(orderBytes())
        assertEquals(orderPinnedSigHex, HexUtil.encode(sig))
    }

    @Test
    fun orderLowercasesDomainStkAndNonce() {
        assertEquals(
            orderCanonical,
            String(
                orderBytes(
                    serverDomain = "HOME.Alice.Flagship.Services",
                    oldStkPubHex = "AA".repeat(32),
                    nonce = "DEADBEEF",
                ),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun orderSignVerifyRoundTrip() {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val sig = Ed25519Sign(kp.privateKey).sign(orderBytes())
        Ed25519Verify(kp.publicKey).verify(sig, orderBytes()) // throws on mismatch

        // The old-STK binding is in the bytes: a different oldStk ⇒ different
        // bytes, so the captured signature must NOT verify against them.
        try {
            Ed25519Verify(kp.publicKey).verify(sig, orderBytes(oldStkPubHex = "cc".repeat(32)))
            fail("migration order sig for instance A must not verify as instance B")
        } catch (_: Throwable) {
            // expected
        }
    }

    // ── Control ───────────────────────────────────────────────────────────────

    @Test
    fun controlCanonicalBytesMatchPinnedVector() {
        assertEquals(controlCanonical, String(controlBytes(), Charsets.UTF_8))
    }

    @Test
    fun controlSignatureIsExactlyThePinnedTsHex() {
        val sig = Ed25519Sign(vectorSeed).sign(controlBytes())
        assertEquals(controlPinnedSigHex, HexUtil.encode(sig))
    }

    @Test
    fun controlLowercasesDomainAndNonce() {
        assertEquals(
            controlCanonical,
            String(
                controlBytes(serverDomain = "HOME.Alice.Flagship.Services", nonce = "0BADCAFE"),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun controlActionIsInTheBytes() {
        val sig = Ed25519Sign(vectorSeed).sign(controlBytes())
        try {
            Ed25519Verify(Ed25519Sign.KeyPair.newKeyPairFromSeed(vectorSeed).publicKey)
                .verify(sig, controlBytes(action = "confirm-ready"))
            fail("an abort signature must not authorize confirm-ready")
        } catch (_: Throwable) {
            // expected
        }
    }

    // ── Disposition vocabulary ────────────────────────────────────────────────

    @Test
    fun migrationDispositionVocabularyExcludesWipeNow() {
        // Invariant 1 — a migration never authorizes wipe-now.
        assertEquals(
            listOf("keep", "wipe-after-handoff"),
            ServerMigrationFlow.Disposition.entries.map { it.wire }.sorted(),
        )
        assertNull(ServerMigrationFlow.Disposition.entries.firstOrNull { it.wire == "wipe-now" })
        assertEquals(
            ServerMigrationFlow.Disposition.WipeAfterHandoff,
            ServerMigrationFlow.DEFAULT_DISPOSITION,
        )
    }
}
