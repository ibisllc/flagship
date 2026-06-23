package com.flagshipserver.app.core

import com.flagshipserver.app.api.MailboxAuthEnvelope
import com.flagshipserver.app.api.PairingDepositBody
import com.google.crypto.tink.subtle.Ed25519Sign
import java.security.SecureRandom

/**
 * Kotlin mirror of packages/protocol/src/cgkDelivery.ts — the sealed
 * CGK-delivery envelope, the EXACT twin of [SwkDelivery] (only the payload + tag
 * differ). The post-boot hand-off of the Cloud Gossip Key for per-service
 * leadership (Phase 6, docs/multi-pod-liveness-session-leadership.md).
 *
 * The secret-free recipe carries NO CGK; a box runs gossip only once it has a
 * CGK (else gossip stays dark — no brick). The phone seals the 32-byte CGK to
 * the box's Ed25519 identity pubkey (via [SecretSeal.sealForEd25519Recipient] —
 * the same seal the SWK/disk-key flows use) and IRK-signs the wrapper binding
 * `(serverDomain, sealed, issuedAt)`:
 *
 *   flagship/cgk-delivery/v1|<serverDomain>|<hex(sealed)>|<issuedAt>
 *
 * The CGK is a SECRET (it authenticates + transports gossip frames between
 * siblings) so it is SEALED for the box identity exactly like the SWK — unlike
 * the set-leader vote (a PUBLIC carrier). The carrier deposited on `.com` is
 * hex-encoded UTF-8 JSON `{serverDomain, sealed, issuedAt, signature}` —
 * byte-identical to the TS `cgkDeliveryToCarrierHex`. `.com` holds only opaque
 * ciphertext (I1/I3); the box verifies the owner-IRK signature, then unseals the
 * CGK with its identity key. The pinned cross-platform vector in
 * packages/protocol/tests/cgkDelivery.test.ts is reproduced by CgkDeliveryTest.
 *
 * CGK is PER CLOUD, not per server — there is NO serverId in its derivation
 * ([CloudGossip.deriveCGK]).
 */
object CgkDelivery {
    const val TAG = "flagship/cgk-delivery/v1"

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

    /** PHONE side. Seal the 32-byte CGK to the box's Ed25519 identity pubkey and
     *  IRK-sign the wrapper. Returns the envelope + its signature. */
    fun build(
        serverDomain: String,
        cgk: ByteArray,
        boxIdentityPub: ByteArray,
        irk: Ed25519Sign,
        issuedAt: Long,
    ): Pair<Delivery, ByteArray> {
        require(cgk.size == 32) { "CGK must be 32 bytes" }
        require(boxIdentityPub.size == 32) { "box identity pubkey must be 32 bytes" }
        val sealed = SecretSeal.sealForEd25519Recipient(cgk, boxIdentityPub)
        val delivery = Delivery(serverDomain, sealed, issuedAt)
        return delivery to sign(delivery, irk)
    }

    /** Turn a built delivery + signature into the hex carrier the deposit lane
     *  stores. Byte-identical (by VALUE) to the TS `cgkDeliveryToCarrierHex` —
     *  the box re-parses by field name, so key ORDER is irrelevant. */
    fun carrierHex(delivery: Delivery, signature: ByteArray): String {
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

    /** Build the full deposit body for [com.flagshipserver.app.api.SecretMailboxClient.depositCgk].
     *  The CGK is sealed to the box's REGISTERED identity pub (`stkPub` — its
     *  registered STK), the wrapper IRK-signed, and the carrier hex placed in
     *  `deposit.sealed`. `auth`/`authSignature` are the SAME IRK mailbox-auth shape
     *  as every other phone-mailbox call. Reuses [PairingDepositBody] (the
     *  swk/cgk/pairing deposits share its shape). */
    fun buildDeposit(
        username: String,
        serverDomain: String,
        cgk: ByteArray,
        boxIdentityPub: ByteArray,
        irk: Ed25519Sign,
        irkPubHex: String,
        now: Long = System.currentTimeMillis(),
        mailboxNonceHex: String = randomHex(32),
        depositNonceHex: String = randomHex(32),
    ): PairingDepositBody {
        val (delivery, signature) = build(serverDomain, cgk, boxIdentityPub, irk, now)
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
                // The deposit binds the box's REGISTERED STK = its identity pub.
                stkPub = HexUtil.encode(boxIdentityPub),
                sealed = carrier,
                issuedAt = now,
            ),
        )
    }
}
