package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/**
 * Pins the SECRET-FREE pairing contract (the first recipe carries ZERO pairing
 * secrets): the create-time order JSON the phone builds must be byte-identical to
 * the cross-platform vector in `packages/protocol/tests/pairingOrder.test.ts`,
 * and routed by mode — EMBEDDED plaintext (offline) or SEALED to the box identity
 * + deposited (default online). No pairing keypair, no `pairingKeyPrivHex`.
 */
class CreateTimePairingTest {
    private val host = "kitchen.alice.flagship.services"
    private val issuedAt = 1_750_000_000_000L

    // Pinned UMK seed → IRK + the deterministic-Tink order signature + envelope
    // JSON from the protocol vector.
    private val umk = ByteArray(32) { 7 }
    private val pinnedIrkPub =
        "3e4a50e7afdfae54c86e1ccd70a8691d48155e9613cbdbf4d17bad5b6ba68045"
    private val pinnedSignature =
        "6e63a086d673fa6e5dd8010aba6367a2aba1861210d21a63bce5dc1331b02f64" +
        "566120c1647b355a51b10a334e01203d48c4d4c279d21d135203d415a70fe109"
    private val token = "a".repeat(64)
    private val label = "Alice's iPhone"
    private val pinnedJson =
        "{\"request\":{\"type\":\"add-paired-session\"," +
        "\"serverId\":\"$host\",\"token\":\"$token\"," +
        "\"label\":\"$label\",\"issuedAt\":$issuedAt}," +
        "\"signature\":\"$pinnedSignature\"}"

    private fun irkKeyPair(): Ed25519Sign.KeyPair =
        Ed25519Sign.KeyPair.newKeyPairFromSeed(ServerKeys.deriveProtocolIrkSeed(umk))

    @Test
    fun pairingOrderJsonMatchesPinnedVector() {
        val kp = irkKeyPair()
        assertEquals(pinnedIrkPub, HexUtil.encode(kp.publicKey))
        val built = CreateTimePairing.build(
            serverDomain = host, label = label, irk = Ed25519Sign(kp.privateKey),
            now = issuedAt, token = token,
        )
        // Tink Ed25519 is deterministic (RFC 8032) → the order JSON is byte-stable.
        assertEquals(pinnedJson, built.pairingOrderJson)
        assertEquals(token, built.token)
        // The pinned signature verifies under the pinned IRK pub over the order
        // canonical bytes (verify() throws on mismatch).
        val canonical = listOf(
            "flagship/order/add-paired-session/v1", host, token, label, issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
        Ed25519Verify(kp.publicKey).verify(HexUtil.decode(pinnedSignature)!!, canonical)
    }

    @Test
    fun defaultDepositSealsOrderToBoxIdentity() {
        val irkKp = Ed25519Sign.KeyPair.newKeyPair()
        val irk = Ed25519Sign(irkKp.privateKey)
        val built = CreateTimePairing.build(
            serverDomain = host, label = "iPhone", irk = irk, now = issuedAt, token = "cd".repeat(32),
        )
        val boxKp = Ed25519Sign.KeyPair.newKeyPair()

        val body = PairingOrderDeposit.buildDeposit(
            username = "alice", serverDomain = host,
            pairingOrderJson = built.pairingOrderJson,
            boxIdentityPub = boxKp.publicKey, irk = irk,
            irkPubHex = HexUtil.encode(irkKp.publicKey), now = issuedAt,
        )
        // I2: the deposit binds the box's REGISTERED identity pub.
        assertEquals(HexUtil.encode(boxKp.publicKey), body.deposit.stkPub)
        assertEquals(host, body.deposit.serverDomain)
        assertEquals(HexUtil.encode(irkKp.publicKey), body.auth.phoneIrkPub)

        // The box opens deposit.sealed with its identity seed → the EXACT JSON.
        val sealed = HexUtil.decode(body.deposit.sealed)!!
        val plain = SecretSeal.openWithEd25519Seed(sealed, boxKp.privateKey)
        assertEquals(built.pairingOrderJson, String(plain, Charsets.UTF_8))

        // The opened JSON parses back to the signed order.
        val env = Json.parseToJsonElement(String(plain, Charsets.UTF_8)).jsonObject
        val req = env["request"]!!.jsonObject
        assertEquals("add-paired-session", req["type"]!!.jsonPrimitive.content)
        assertEquals(host, req["serverId"]!!.jsonPrimitive.content)
    }

    @Test
    fun wrongIdentityCannotOpenDeposit() {
        val irkKp = Ed25519Sign.KeyPair.newKeyPair()
        val irk = Ed25519Sign(irkKp.privateKey)
        val built = CreateTimePairing.build(serverDomain = host, label = "x", irk = irk)
        val boxKp = Ed25519Sign.KeyPair.newKeyPair()
        val body = PairingOrderDeposit.buildDeposit(
            username = "alice", serverDomain = host,
            pairingOrderJson = built.pairingOrderJson, boxIdentityPub = boxKp.publicKey,
            irk = irk, irkPubHex = HexUtil.encode(irkKp.publicKey),
        )
        val sealed = HexUtil.decode(body.deposit.sealed)!!
        val stranger = Ed25519Sign.KeyPair.newKeyPair().privateKey
        try {
            SecretSeal.openWithEd25519Seed(sealed, stranger)
            fail("a stranger identity key must not open the sealed deposit")
        } catch (_: Throwable) {
            // expected — inert ciphertext for the wrong recipient
        }
    }
}
