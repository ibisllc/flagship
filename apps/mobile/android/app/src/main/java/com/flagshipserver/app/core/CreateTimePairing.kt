package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import java.security.SecureRandom

/**
 * Builds the CREATE-TIME pairing ORDER — the phone's half of pairing the
 * creating device with a server, in the SECRET-FREE recipe. Kotlin mirror of iOS
 * `CreateTimePairing.build`.
 *
 * The first recipe carries ZERO pairing secrets: no pairing keypair, no
 * `pairingKeyPrivHex`. At create time the phone (which already holds the owner
 * IRK from the single create-server biometric) signs an `add-paired-session`
 * order and serializes it to the plaintext `pairingOrder` envelope JSON. The
 * `token` is the box's accepted paired-session token — persist it locally. The
 * caller routes the JSON by mode:
 *   - OFFLINE (embed-secrets ON):  EMBED it as the recipe's unsigned
 *     `pairingOrder` sibling; the box verifies + adds the session LOCALLY.
 *   - DEFAULT (online):  STASH it; once the box registers (carrying its identity
 *     pub in `/pods`), SwkDepositCoordinator SEALS it to that identity and
 *     deposits it on `.com`'s blind pairing-deposit lane (no second biometric).
 *
 * The order canonical bytes + the envelope JSON are byte-identical to the pinned
 * cross-platform vector (`packages/protocol/tests/pairingOrder.test.ts`).
 */
object CreateTimePairing {
    const val ORDER_TAG = "flagship/order/add-paired-session/v2"

    data class Built(
        /** The plaintext `{request, signature}` JSON (PairingOrderEnvelope shape)
         *  to embed (offline) or stash + seal-deposit (default online). */
        val pairingOrderJson: String,
        /** Paired-session token the box will accept — persist locally. */
        val token: String,
    )

    private val rng = SecureRandom()

    private fun randomHex(n: Int): String {
        val b = ByteArray(n)
        rng.nextBytes(b)
        return HexUtil.encode(b)
    }

    private fun orderCanonicalBytes(serverDomain: String, token: String, issuedAt: Long): ByteArray =
        listOf(ORDER_TAG, serverDomain, token, issuedAt.toString()).joinToString("|").toByteArray(Charsets.UTF_8)

    /**
     * @param irk    the account IRK signer (reused from the create-server
     *               biometric — no extra prompt).
     * Randomness is injectable so tests are deterministic; production passes
     * nothing.
     */
    fun build(
        serverDomain: String,
        irk: Ed25519Sign,
        now: Long = System.currentTimeMillis(),
        token: String = randomHex(32),
    ): Built {
        val orderSig = irk.sign(orderCanonicalBytes(serverDomain, token, now))
        val json = PairingOrderEnvelope.toJson(
            serverId = serverDomain,
            token = token,
            issuedAt = now,
            signatureHex = HexUtil.encode(orderSig),
        )
        return Built(pairingOrderJson = json, token = token)
    }
}
