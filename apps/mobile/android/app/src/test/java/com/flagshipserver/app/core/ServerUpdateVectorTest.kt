package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Pins the Kotlin canonical bytes for the `flagship/server-update/v1` order
 * (phone-ordered dual-signed in-place update; docs/server-update-mechanism.md)
 * to the EXACT cross-platform vector. The `.com` gate and the box's update
 * consumer both re-derive these bytes (`canonicalUpdateOrder` in
 * `packages/protocol/src/serverUpdate.ts`) to verify the admin-authority
 * signature, so any drift in the tag, `|` separator, field order (fields ride
 * VERBATIM — no lowercasing), or the number stringification breaks the order.
 *
 * Mirror of the TS pin (`packages/protocol/tests/serverUpdateVector.test.ts`)
 * and the Swift pin (`ServerUpdateCanonicalTests.swift`). Tink's Ed25519 is
 * deterministic (RFC 8032), so — unlike CryptoKit — the exact TS-pinned
 * signature hex is asserted directly.
 */
class ServerUpdateVectorTest {
    private val server = "home.alice.flagship.services"
    private val target = "9f2c1ab3de4567890abcdef1234567890abcdef1"
    private val from = "1234567890abcdef1234567890abcdef12345678"
    private val nonce = "00112233445566778899aabbccddeeff"

    private val vectorCanonical =
        "flagship/server-update/v1|$server|$target|$from|$nonce|1700"

    /** The TS-pinned signature under the 32×0x07 admin seed. */
    private val pinnedSignatureHex =
        "c9c0085c9e50a9d27a8e130045bf302e5ee350f519d07df66fc03e1e7345737d" +
            "e299ba92448b5a05315f1ae9183f42d40eae90e9f6f0f30a78de5e2ea8e1690d"

    private fun adminSeed() = ByteArray(32) { 0x07 }

    @Test
    fun canonicalBytesMatchPinnedVector() {
        assertEquals(
            vectorCanonical,
            String(
                ServerUpdateOrder.canonicalBytes(server, target, from, nonce, 1700L),
                Charsets.UTF_8,
            ),
        )
    }

    @Test
    fun signingWithThePinnedAdminSeedReproducesThePinnedSignature() {
        val signer = Ed25519Sign(adminSeed())
        val sig = signer.sign(ServerUpdateOrder.canonicalBytes(server, target, from, nonce, 1700L))
        assertEquals(pinnedSignatureHex, HexUtil.encode(sig))
    }

    @Test
    fun tamperedOrderDoesNotVerify() {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val signer = Ed25519Sign(kp.privateKey)
        val verifier = Ed25519Verify(kp.publicKey)
        val canonical = ServerUpdateOrder.canonicalBytes(server, target, from, nonce, 1700L)
        val sig = signer.sign(canonical)
        verifier.verify(sig, canonical) // throws on mismatch — reaching here = ok

        // A different targetCommit ⇒ different bytes ⇒ the signature must fail.
        val other = ServerUpdateOrder.canonicalBytes(server, "d".repeat(40), from, nonce, 1700L)
        assertThrows(Throwable::class.java) { verifier.verify(sig, other) }
        // A shifted issuedAt too.
        val shifted = ServerUpdateOrder.canonicalBytes(server, target, from, nonce, 1701L)
        assertThrows(Throwable::class.java) { verifier.verify(sig, shifted) }
    }

    @Test
    fun fieldGuardRejectsSeparatorAndControlChars() {
        assertThrows(IllegalArgumentException::class.java) {
            ServerUpdateOrder.canonicalBytes(server, "a|b", from, nonce, 1700L)
        }
        assertThrows(IllegalArgumentException::class.java) {
            ServerUpdateOrder.canonicalBytes(server, target, "a\nb", nonce, 1700L)
        }
        assertThrows(IllegalArgumentException::class.java) {
            ServerUpdateOrder.canonicalBytes(server, target, from, "a|b", 1700L)
        }
    }

    // ── ServerUpdateDeposit builder ──────────────────────────────────────────

    @Test
    fun buildDepositSignsOrderWithOrderKeyAndAuthWithIrk() {
        val irkKp = Ed25519Sign.KeyPair.newKeyPair()
        val irk = Ed25519Sign(irkKp.privateKey)
        val adminRoot = Ed25519Sign(adminSeed())

        val body = ServerUpdateDeposit.buildDeposit(
            username = "alice",
            serverDomain = server,
            targetCommit = target.uppercase(), // input normalizes
            fromCommit = from,
            irk = irk,
            irkPubHex = HexUtil.encode(irkKp.publicKey),
            now = 1700L,
            mailboxNonceHex = "22".repeat(32),
            depositNonceHex = "33".repeat(32),
            orderNonceHex = nonce,
            orderKey = adminRoot,
        )
        assertEquals(server, body.deposit.serverDomain)
        assertEquals("33".repeat(32), body.deposit.requestNonceHex)
        assertEquals(target, body.order.targetCommit)
        assertEquals(from, body.order.fromCommit)
        assertEquals(1700L, body.order.issuedAt)
        // With the vector nonce + seed the order signature IS the pinned hex —
        // proves the builder signs the exact canonical bytes with the orderKey.
        assertEquals(pinnedSignatureHex, body.signature)
        // The mailbox AUTH stays IRK-bound.
        assertEquals(HexUtil.encode(irkKp.publicKey), body.auth.phoneIrkPub)
        val authOk = DeviceEndpointClaim.verify(
            signature = HexUtil.decode(body.authSignature)!!,
            irkPub = irkKp.publicKey,
            username = "alice",
            endpointLabel = "device",
            phoneIrkPubHex = body.auth.phoneIrkPub,
            issuedAt = body.auth.issuedAt,
            expiresAt = body.auth.expiresAt,
            nonceHex = body.auth.nonce,
        )
        assertEquals(true, authOk)
    }

    @Test
    fun buildDepositRejectsMalformedCommits() {
        val irkKp = Ed25519Sign.KeyPair.newKeyPair()
        val irk = Ed25519Sign(irkKp.privateKey)
        assertThrows(IllegalArgumentException::class.java) {
            ServerUpdateDeposit.buildDeposit(
                username = "alice", serverDomain = server,
                targetCommit = "deadbeef", fromCommit = from,
                irk = irk, irkPubHex = HexUtil.encode(irkKp.publicKey),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            ServerUpdateDeposit.buildDeposit(
                username = "alice", serverDomain = server,
                targetCommit = target, fromCommit = "",
                irk = irk, irkPubHex = HexUtil.encode(irkKp.publicKey),
            )
        }
    }
}
