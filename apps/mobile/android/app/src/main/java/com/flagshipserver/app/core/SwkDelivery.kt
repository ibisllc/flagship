package com.flagshipserver.app.core

import com.flagshipserver.app.api.MailboxAuthEnvelope
import com.flagshipserver.app.api.PairingDepositBody
import com.google.crypto.tink.subtle.Ed25519Sign
import java.security.SecureRandom

/**
 * Kotlin mirror of packages/protocol/src/swkDelivery.ts — the sealed
 * SWK-delivery envelope for the secret-free recipe
 * (docs/recipe-delivery-and-remote-install.md).
 *
 * The phone seals the 32-byte SWK to the box's Ed25519 identity pubkey (via the
 * ed→x25519 birational map, the same [SecretSeal.sealForEd25519Recipient] the
 * disk-key / pairing flows use) and IRK-signs the wrapper binding
 * `(serverDomain, sealed, issuedAt)`:
 *
 *   flagship/swk-delivery/v1|<serverDomain>|<hex(sealed)>|<issuedAt>
 *
 * The carrier deposited on `.com` is hex-encoded UTF-8 JSON
 * `{serverDomain, sealed, issuedAt, signature}` — byte-identical to the TS
 * `swkDeliveryToCarrierHex`. `.com` holds only opaque ciphertext (I1); the box
 * verifies the owner-IRK signature, then unseals the SWK with its identity key.
 * The pinned cross-platform vector in
 * packages/protocol/tests/swkDelivery.test.ts is reproduced by SwkDeliveryTest.
 */
object SwkDelivery {
    const val TAG = "flagship/swk-delivery/v1"

    data class Delivery(val serverDomain: String, val sealed: ByteArray, val issuedAt: Long)

    private val rng = SecureRandom()
    private fun randomHex(n: Int): String {
        val b = ByteArray(n); rng.nextBytes(b); return HexUtil.encode(b)
    }

    /** Canonical bytes signed by the owner IRK. Field-guards `serverDomain`
     *  (rejects '|' + control chars) to match `legacyFieldGuard` in the TS. */
    fun canonicalBytes(d: Delivery): ByteArray {
        PhoneEndpointFieldGuard.check("serverDomain", d.serverDomain)
        return listOf(TAG, d.serverDomain, HexUtil.encode(d.sealed), d.issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** Sign an already-sealed delivery with the owner IRK. */
    fun sign(d: Delivery, irk: Ed25519Sign): ByteArray = irk.sign(canonicalBytes(d))

    /** PHONE side. Seal the 32-byte SWK to the box's Ed25519 identity pubkey and
     *  IRK-sign the wrapper. Returns the envelope + its signature. */
    fun build(
        serverDomain: String,
        swk: ByteArray,
        boxIdentityPub: ByteArray,
        irk: Ed25519Sign,
        issuedAt: Long,
    ): Pair<Delivery, ByteArray> {
        require(swk.size == 32) { "SWK must be 32 bytes" }
        require(boxIdentityPub.size == 32) { "box identity pubkey must be 32 bytes" }
        val sealed = SecretSeal.sealForEd25519Recipient(swk, boxIdentityPub)
        val delivery = Delivery(serverDomain, sealed, issuedAt)
        return delivery to sign(delivery, irk)
    }

    /** Turn a built delivery + signature into the hex carrier the deposit lane
     *  stores. Byte-identical (by VALUE) to the TS `swkDeliveryToCarrierHex` —
     *  the box re-parses by field name, so key ORDER is irrelevant. */
    fun carrierHex(delivery: Delivery, signature: ByteArray): String {
        // Build the JSON by hand to match the TS field set + value encoding
        // exactly (strings quoted, issuedAt a bare number).
        val json = buildString {
            append('{')
            append("\"serverDomain\":\"").append(delivery.serverDomain).append("\",")
            append("\"sealed\":\"").append(HexUtil.encode(delivery.sealed)).append("\",")
            append("\"issuedAt\":").append(delivery.issuedAt).append(',')
            append("\"signature\":\"").append(HexUtil.encode(signature)).append('"')
            append('}')
        }
        return HexUtil.encode(json.toByteArray(Charsets.UTF_8))
    }

    /** Build the full deposit body for [com.flagshipserver.app.api.SecretMailboxClient.depositSwk].
     *  The SWK is sealed to the box's REGISTERED identity pub (`stkPub` — what
     *  `.com`'s swk-deposit handler binds I2), the wrapper IRK-signed, and the
     *  carrier hex placed in `deposit.sealed`. `auth`/`authSignature` are the SAME
     *  IRK mailbox-auth shape as every other phone-mailbox call. */
    fun buildDeposit(
        username: String,
        serverDomain: String,
        swk: ByteArray,
        boxIdentityPub: ByteArray,
        irk: Ed25519Sign,
        irkPubHex: String,
        now: Long = System.currentTimeMillis(),
        mailboxNonceHex: String = randomHex(32),
        depositNonceHex: String = randomHex(32),
    ): PairingDepositBody {
        val (delivery, signature) = build(serverDomain, swk, boxIdentityPub, irk, now)
        val carrier = carrierHex(delivery, signature)
        val expiresAt = now + 120_000
        val authSig = DeviceEndpointClaim.sign(
            irk = irk,
            username = username,
            endpointLabel = "device",
            phoneIrkPubHex = irkPubHex,
            issuedAt = now,
            expiresAt = expiresAt,
            nonceHex = mailboxNonceHex,
        )
        return PairingDepositBody(
            auth = MailboxAuthEnvelope.Auth(
                username = username,
                endpointLabel = "device",
                phoneIrkPub = irkPubHex,
                issuedAt = now,
                expiresAt = expiresAt,
                nonce = mailboxNonceHex,
            ),
            authSignature = HexUtil.encode(authSig),
            deposit = PairingDepositBody.Deposit(
                serverDomain = serverDomain,
                requestNonceHex = depositNonceHex,
                // I2: the deposit binds the box's REGISTERED STK = its identity pub.
                stkPub = HexUtil.encode(boxIdentityPub),
                sealed = carrier,
                issuedAt = now,
            ),
        )
    }
}
