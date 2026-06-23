package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the Kotlin CgkDelivery envelope to the EXACT cross-platform vector in
 * packages/protocol/tests/cgkDelivery.test.ts (the Swift twin is
 * CgkDeliveryVectorTests.swift):
 *   UMK seed = 32×0x07 → deriveIRK → pub 3e4a50e7…  AND  deriveCGK → 1d8e3bc3…
 *   box identity seed = 32×0x09 → Ed25519 pub fd172438…
 *   fixed sealed blob = (i*7+3)&0xff over 76 bytes
 *   serverDomain = "kitchen.alice.flagship.services", issuedAt = 1750000000000
 *   → signature 147205c6…44417a0f
 *
 * The box re-derives these canonical bytes to verify the owner-IRK signature, so
 * any drift in the tag, `|` separator, field order, or issuedAt stringification
 * would break secret-free CGK delivery. The CGK is the per-CLOUD key (no
 * serverId).
 */
class CgkDeliveryVectorTest {
    private val serverDomain = "kitchen.alice.flagship.services"
    private val issuedAt = 1_750_000_000_000L

    private val pinnedIrkPub =
        "3e4a50e7afdfae54c86e1ccd70a8691d48155e9613cbdbf4d17bad5b6ba68045"
    private val pinnedBoxIdentityPub =
        "fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618"
    private val pinnedCgk =
        "1d8e3bc393a91de22edec0b862a0539856bdc73b42ab60a26d7d51fbb091badd"
    private val pinnedSignature =
        "147205c68400bbce5ac3f92d853ca6745715d7d7d092991eaad7cb769ee6b037" +
        "7f39497865292f667b3d5e3b94454d3517dd81f6d622e3cbcf375c1d44417a0f"

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

    /** The deterministic CGK = CloudGossip.deriveCGK(umk.seed) (per cloud, no
     *  serverId) must match the pinned cross-platform value. */
    @Test
    fun pinnedCgk() {
        assertEquals(pinnedCgk, HexUtil.encode(CloudGossip.deriveCGK(umk)))
    }

    @Test
    fun canonicalBytesShape() {
        val fixedSealed = ByteArray(76) { i -> ((i * 7 + 3) and 0xff).toByte() }
        val delivery = CgkDelivery.Delivery(serverDomain, fixedSealed, issuedAt)
        assertEquals(
            "flagship/cgk-delivery/v1|$serverDomain|${HexUtil.encode(fixedSealed)}|$issuedAt",
            String(CgkDelivery.canonicalBytes(delivery), Charsets.UTF_8),
        )
    }

    @Test
    fun pinnedSignatureVerifies() {
        val fixedSealed = ByteArray(76) { i -> ((i * 7 + 3) and 0xff).toByte() }
        val delivery = CgkDelivery.Delivery(serverDomain, fixedSealed, issuedAt)
        val canonical = CgkDelivery.canonicalBytes(delivery)
        // Tink Ed25519Sign is deterministic (RFC 8032) so we can assert the exact
        // pinned signature bytes AND that it verifies.
        val kp = irkKeyPair()
        val sig = CgkDelivery.sign(delivery, Ed25519Sign(kp.privateKey))
        assertEquals(pinnedSignature, HexUtil.encode(sig))
        // verify() returns Unit + THROWS on a bad sig — reaching past it = ok.
        Ed25519Verify(kp.publicKey).verify(HexUtil.decode(pinnedSignature)!!, canonical)
    }

    /** Full round-trip: phone seals the deterministic CGK to the box identity +
     *  signs; the SEAL uses a random ephemeral key, so this asserts the sealed
     *  CGK opens to the EXACT 32 bytes (via the box identity seed) and the
     *  signature verifies — exactly mirroring the swk-delivery Kotlin test. */
    @Test
    fun sealRoundTripOpensExactCgk() {
        val cgk = CloudGossip.deriveCGK(umk)
        assertEquals(pinnedCgk, HexUtil.encode(cgk))
        val boxPub = Ed25519Sign.KeyPair.newKeyPairFromSeed(boxSeed).publicKey
        val kp = irkKeyPair()
        val (delivery, sig) = CgkDelivery.build(serverDomain, cgk, boxPub, Ed25519Sign(kp.privateKey), issuedAt)
        Ed25519Verify(kp.publicKey).verify(sig, CgkDelivery.canonicalBytes(delivery))
        // The box opens with its identity seed (ed→x25519 map).
        val opened = SecretSeal.openWithEd25519Seed(delivery.sealed, boxSeed)
        assertEquals(HexUtil.encode(cgk), HexUtil.encode(opened))
        // Carrier round-trips (non-empty hex JSON).
        assertTrue(CgkDelivery.carrierHex(delivery, sig).isNotEmpty())
    }
}
