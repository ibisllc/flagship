package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Pins the Kotlin SetLeaderDeposit body build for the "Set as preferred server"
 * owner vote (per-service leadership Phase 6). Asserts the body shape the Worker
 * handler (`handlePostSetLeaderDeposit`) expects and that the vote signature
 * verifies under the owner IRK over the EXACT `set-leader` canonical bytes
 * (`flagship/set-leader/v1|user|preferredStkPubHex|issuedAt|nonce`).
 */
class SetLeaderDepositTest {
    private val umk = ByteArray(32) { 7 }
    private fun irkKeyPair(): Ed25519Sign.KeyPair =
        Ed25519Sign.KeyPair.newKeyPairFromSeed(ServerKeys.deriveProtocolIrkSeed(umk))

    private val user = "alice"
    private val serverDomain = "kitchen.alice.flagship.services"
    // A valid 32-byte STK hex (the box's identity pub).
    private val stkHex = "fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618"
    private val issuedAt = 1_750_000_000_000L

    @Test
    fun buildsBodyAndVoteVerifiesUnderOwnerIrk() {
        val kp = irkKeyPair()
        val irk = Ed25519Sign(kp.privateKey)
        val irkPubHex = HexUtil.encode(kp.publicKey)
        val body = SetLeaderDeposit.buildDeposit(
            username = user,
            serverDomain = serverDomain,
            preferredStkPubHex = stkHex,
            irk = irk,
            irkPubHex = irkPubHex,
            now = issuedAt,
        )

        // Body shape mirrors the Worker handler.
        assertEquals(serverDomain, body.deposit.serverDomain)
        assertEquals(64, body.deposit.requestNonceHex.length)
        assertEquals(user, body.vote.user)
        assertEquals(stkHex, body.vote.preferredStkPubHex)   // already lowercase
        assertEquals(issuedAt, body.vote.issuedAt)
        assertEquals(128, body.signature.length)
        assertEquals(user, body.auth.username)
        assertEquals(irkPubHex, body.auth.phoneIrkPub)

        // The vote signature verifies under the owner IRK over the canonical bytes
        // the box re-derives (byte-identical to the TS verifySetLeader).
        val canonical = CloudGossip.setLeaderCanonicalBytes(
            body.vote.user, body.vote.preferredStkPubHex, body.vote.issuedAt, body.vote.nonce,
        )
        Ed25519Verify(kp.publicKey).verify(HexUtil.decode(body.signature)!!, canonical)
    }

    @Test
    fun clearVoteWithNoneSentinel() {
        val kp = irkKeyPair()
        val body = SetLeaderDeposit.buildDeposit(
            username = user,
            serverDomain = serverDomain,
            preferredStkPubHex = CloudGossip.SET_LEADER_NONE,
            irk = Ed25519Sign(kp.privateKey),
            irkPubHex = HexUtil.encode(kp.publicKey),
            now = issuedAt,
        )
        assertEquals("none", body.vote.preferredStkPubHex)
        val canonical = CloudGossip.setLeaderCanonicalBytes(
            body.vote.user, body.vote.preferredStkPubHex, body.vote.issuedAt, body.vote.nonce,
        )
        Ed25519Verify(kp.publicKey).verify(HexUtil.decode(body.signature)!!, canonical)
    }

    @Test
    fun rejectsMalformedPreferredStk() {
        val kp = irkKeyPair()
        val irk = Ed25519Sign(kp.privateKey)
        val pub = HexUtil.encode(kp.publicKey)
        assertThrows(IllegalArgumentException::class.java) {
            SetLeaderDeposit.buildDeposit(user, serverDomain, "not-hex", irk, pub, issuedAt)
        }
        // A 31-byte hex (too short) is rejected too.
        assertThrows(IllegalArgumentException::class.java) {
            SetLeaderDeposit.buildDeposit(user, serverDomain, "ab".repeat(31), irk, pub, issuedAt)
        }
    }
}
