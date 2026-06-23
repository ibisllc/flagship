package com.flagshipserver.app.core

import com.flagshipserver.app.api.MailboxAuthEnvelope
import com.flagshipserver.app.api.PairingDepositBody
import com.google.crypto.tink.subtle.Ed25519Sign
import java.security.SecureRandom

/**
 * DEFAULT (online) pairing deposit builder — the secret-free twin of
 * [SwkDelivery.buildDeposit], for the paired-session order. Kotlin mirror of iOS
 * `PairingOrderDeposit.buildDeposit`.
 *
 * Once the box has registered (carrying its Ed25519 IDENTITY pub in `/pods`), the
 * phone seals the create-time plaintext `pairingOrder` JSON DIRECTLY to that
 * identity ([SecretSeal.sealForEd25519Recipient]) and deposits it on `.com`'s
 * blind pairing-deposit lane. Unlike the SWK lane (which wraps the seal in a
 * carrier JSON), the pairing-deposit consumer unseals `deposit.sealed` and
 * decodes the bytes as the `{request, signature}` JSON verbatim — so the sealed
 * blob IS the seal output, no carrier wrapper.
 *
 * `.com` holds only opaque ciphertext (I1); the box unseals with its identity
 * key, verifies the owner-IRK order under its config-pinned owner IRK, and adds
 * the session. Sealing is a public-key op — NO second biometric.
 */
object PairingOrderDeposit {
    private val rng = SecureRandom()
    private fun randomHex(n: Int): String {
        val b = ByteArray(n); rng.nextBytes(b); return HexUtil.encode(b)
    }

    /** Build the full deposit body for [com.flagshipserver.app.api.SecretMailboxClient.depositPairing].
     *  The order JSON is sealed to the box's REGISTERED identity pub (`stkPub` —
     *  what `.com`'s pairing-deposit handler binds I2); `auth`/`authSignature`
     *  are the SAME IRK mailbox-auth shape as every other phone-mailbox call. */
    fun buildDeposit(
        username: String,
        serverDomain: String,
        pairingOrderJson: String,
        boxIdentityPub: ByteArray,
        irk: Ed25519Sign,
        irkPubHex: String,
        now: Long = System.currentTimeMillis(),
        mailboxNonceHex: String = randomHex(32),
        depositNonceHex: String = randomHex(32),
    ): PairingDepositBody {
        require(boxIdentityPub.size == 32) { "box identity pubkey must be 32 bytes" }
        val sealed = SecretSeal.sealForEd25519Recipient(
            pairingOrderJson.toByteArray(Charsets.UTF_8),
            boxIdentityPub,
        )
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
                sealed = HexUtil.encode(sealed),
                issuedAt = now,
            ),
        )
    }
}
