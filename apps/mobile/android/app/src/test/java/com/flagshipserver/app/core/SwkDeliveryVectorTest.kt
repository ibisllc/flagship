package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the Kotlin SwkDelivery envelope to the EXACT cross-platform vector in
 * packages/protocol/tests/swkDelivery.test.ts:
 *   UMK seed = 32×0x07 → deriveIRK → pub 3e4a50e7…
 *   box identity seed = 32×0x09 → Ed25519 pub fd172438…
 *   fixed sealed blob = (i*7+3)&0xff over 76 bytes
 *   serverDomain = "kitchen.alice.flagship.services", issuedAt = 1750000000000
 *   → signature 660cf5eb…a8867a0f
 *
 * The box re-derives these canonical bytes to verify the owner-IRK signature.
 */
class SwkDeliveryVectorTest {
    private val serverDomain = "kitchen.alice.flagship.services"
    private val serverId = "srv-vector-1"
    private val issuedAt = 1_750_000_000_000L

    private val pinnedIrkPub =
        "3e4a50e7afdfae54c86e1ccd70a8691d48155e9613cbdbf4d17bad5b6ba68045"
    private val pinnedBoxIdentityPub =
        "fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618"
    private val pinnedSignature =
        "660cf5eb0be65b17d5e57208b0d130ab3d9dd074f6623cf8c45c6d4055c6e06f" +
        "27403cd87a5247b3476b8985d2a99dafb1dd2aea4feed8732e4bf7e7a8867a0f"

    private val umk = ByteArray(32) { 7 }
    private val boxSeed = ByteArray(32) { 9 }

    private fun irkKeyPair(): Ed25519Sign.KeyPair {
        // The owner IRK from the pinned UMK = protocol deriveIRK(UMK)
        // (HKDF-SHA256(umk, info="flagship.irk.v1") → Ed25519).
        val seed = ServerKeys.deriveProtocolIrkSeed(umk)
        return Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
    }

    @Test
    fun pinnedIrkPub() {
        assertEquals(pinnedIrkPub, HexUtil.encode(irkKeyPair().publicKey))
    }

    @Test
    fun pinnedBoxIdentityPub() {
        val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(boxSeed).publicKey
        assertEquals(pinnedBoxIdentityPub, HexUtil.encode(pub))
    }

    @Test
    fun pinnedSignatureVerifies() {
        val fixedSealed = ByteArray(76) { i -> ((i * 7 + 3) and 0xff).toByte() }
        val delivery = SwkDelivery.Delivery(serverDomain, fixedSealed, issuedAt)
        val canonical = SwkDelivery.canonicalBytes(delivery)
        assertEquals(
            "flagship/swk-delivery/v1|$serverDomain|${HexUtil.encode(fixedSealed)}|$issuedAt",
            String(canonical, Charsets.UTF_8),
        )
        // Tink Ed25519Sign is deterministic (RFC 8032) so we can assert the
        // exact pinned signature bytes AND that it verifies.
        val kp = irkKeyPair()
        val sig = SwkDelivery.sign(delivery, Ed25519Sign(kp.privateKey))
        assertEquals(pinnedSignature, HexUtil.encode(sig))
        // verify() returns Unit + THROWS on a bad sig — reaching past it = ok.
        Ed25519Verify(kp.publicKey).verify(HexUtil.decode(pinnedSignature)!!, canonical)
    }

    @Test
    fun sealRoundTripOpensExactSwk() {
        val swk = ServerKeys.deriveSwk(umk, serverId)
        val boxPub = Ed25519Sign.KeyPair.newKeyPairFromSeed(boxSeed).publicKey
        val kp = irkKeyPair()
        val (delivery, sig) = SwkDelivery.build(serverDomain, swk, boxPub, Ed25519Sign(kp.privateKey), issuedAt)
        Ed25519Verify(kp.publicKey).verify(sig, SwkDelivery.canonicalBytes(delivery))
        // The box opens with its identity seed (ed→x25519 map).
        val opened = SecretSeal.openWithEd25519Seed(delivery.sealed, boxSeed)
        assertEquals(HexUtil.encode(swk), HexUtil.encode(opened))
        // Carrier round-trips (non-empty hex JSON).
        val carrier = SwkDelivery.carrierHex(delivery, sig)
        assertTrue(carrier.isNotEmpty())
    }
}
