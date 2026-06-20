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
 * Pins the create-time pairing contract: the deposit the phone builds must be
 * exactly what the daemon's `consumePendingPairing` opens + verifies — sealed
 * FOR the recipe pairing key, carrying an owner-IRK-signed `add-paired-session`
 * order. Mirror of the iOS CreateTimePairingTests + the daemon round-trip.
 */
class CreateTimePairingTest {
    private val host = "home.alice.flagship.services"

    @Test
    fun depositRoundTripsToTheSignedOrder() {
        val irkKp = Ed25519Sign.KeyPair.newKeyPair()
        val irk = Ed25519Sign(irkKp.privateKey)
        val irkPubHex = HexUtil.encode(irkKp.publicKey)
        val pairingKp = Ed25519Sign.KeyPair.newKeyPair()
        val token = "ab".repeat(32)

        val built = CreateTimePairing.build(
            username = "alice",
            serverDomain = host,
            label = "Alice Phone",
            irk = irk,
            irkPubHex = irkPubHex,
            now = 1_700_000_000_000L,
            token = token,
            pairingKeyPair = pairingKp,
        )

        assertEquals(token, built.token)
        assertEquals(HexUtil.encode(pairingKp.privateKey), built.pairingKeyPrivHex)
        assertEquals(HexUtil.encode(pairingKp.publicKey), built.body.deposit.stkPub)
        assertEquals(host, built.body.deposit.serverDomain)
        assertEquals(irkPubHex, built.body.auth.phoneIrkPub)

        // The daemon's exact move: open with the recipe pairing key, parse
        // {request, signature}, re-verify the order under the owner IRK.
        val sealed = HexUtil.decode(built.body.deposit.sealed)!!
        val plain = SecretSeal.openWithEd25519Seed(sealed, pairingKp.privateKey)
        val env = Json.parseToJsonElement(String(plain, Charsets.UTF_8)).jsonObject
        val req = env["request"]!!.jsonObject
        assertEquals("add-paired-session", req["type"]!!.jsonPrimitive.content)
        assertEquals(host, req["serverId"]!!.jsonPrimitive.content)
        assertEquals(token, req["token"]!!.jsonPrimitive.content)

        val canonical = listOf(
            "flagship/order/add-paired-session/v1",
            host,
            token,
            req["label"]!!.jsonPrimitive.content,
            req["issuedAt"]!!.jsonPrimitive.content,
        ).joinToString("|").toByteArray(Charsets.UTF_8)
        val sig = HexUtil.decode(env["signature"]!!.jsonPrimitive.content)!!
        // Tink's verify() returns Unit and THROWS on a bad signature — reaching
        // the next line means the owner-IRK signature verified.
        Ed25519Verify(irkKp.publicKey).verify(sig, canonical)
    }

    @Test
    fun wrongPairingKeyCannotOpen() {
        val irkKp = Ed25519Sign.KeyPair.newKeyPair()
        val built = CreateTimePairing.build(
            username = "alice",
            serverDomain = host,
            label = "x",
            irk = Ed25519Sign(irkKp.privateKey),
            irkPubHex = HexUtil.encode(irkKp.publicKey),
        )
        val sealed = HexUtil.decode(built.body.deposit.sealed)!!
        val stranger = Ed25519Sign.KeyPair.newKeyPair().privateKey
        try {
            SecretSeal.openWithEd25519Seed(sealed, stranger)
            fail("a stranger pairing key must not open the sealed deposit")
        } catch (_: Throwable) {
            // expected — inert ciphertext for the wrong recipient
        }
    }
}
