package com.flagshipserver.app.core

import com.flagshipserver.app.api.MailboxAuthEnvelope
import com.flagshipserver.app.api.UpdateDepositBody
import com.google.crypto.tink.subtle.Ed25519Sign
import java.security.SecureRandom

/**
 * Phone side of "Update this server" (docs/server-update-mechanism.md). Kotlin
 * mirror of the iOS FlagshipCore/ServerUpdateFlow.swift.
 *
 * Builds the exact wire body the `.com` update lane accepts —
 * `{auth, authSignature, deposit:{serverDomain,requestNonceHex},
 *   order:{serverDomain,targetCommit,fromCommit,nonce,issuedAt}, signature}` —
 * byte-identical to the TS `handlePostUpdateDeposit` body and the webapp
 * builder.
 *
 * TWO KEYS (the set-leader pattern, NOT the sealed lanes): the ORDER is
 * MAXIMALLY sensitive and signs with the admin master root (`orderKey`) when
 * this device holds one, else the IRK (legacy); the mailbox AUTH envelope
 * STAYS IRK-signed — it is the account-owner deposit credential
 * (`phoneIrkPub` MUST equal the registered IRK), NOT the sensitive authority.
 */
object ServerUpdateDeposit {
    private val rng = SecureRandom()
    private fun randomHex(n: Int): String {
        val b = ByteArray(n); rng.nextBytes(b); return HexUtil.encode(b)
    }

    /** A full lowercase git commit SHA — the only commit form this phase
     *  accepts (the maintainer-endorsement check is box-side). */
    fun isValidCommit(s: String): Boolean =
        s.length == 40 && s.all { it in '0'..'9' || it in 'a'..'f' }

    /**
     * Mint + sign a `flagship/server-update/v1` order naming this box + the
     * target commit, and wrap it with the IRK mailbox-auth into the deposit
     * body. `fromCommit` is the BOX-REPORTED current commit (server-detail
     * `currentCommit`) — never a guess; the box refuses a mismatch. Throws
     * IllegalArgumentException on a malformed commit.
     */
    fun buildDeposit(
        username: String,
        serverDomain: String,
        targetCommit: String,
        fromCommit: String,
        irk: Ed25519Sign,
        irkPubHex: String,
        now: Long = System.currentTimeMillis(),
        mailboxNonceHex: String = randomHex(32),
        depositNonceHex: String = randomHex(32),
        orderNonceHex: String = randomHex(32),
        // Slice D — the update ORDER is SENSITIVE: sign it with the admin master
        // root (`orderKey`) when supplied, else the IRK (legacy / no admin
        // root). The mailbox AUTH envelope below STAYS IRK-signed.
        orderKey: Ed25519Sign? = null,
    ): UpdateDepositBody {
        val target = targetCommit.lowercase()
        val from = fromCommit.lowercase()
        require(isValidCommit(target)) { "targetCommit must be a full lowercase 40-hex commit" }
        require(isValidCommit(from)) { "fromCommit must be a full lowercase 40-hex commit" }

        val canonical = ServerUpdateOrder.canonicalBytes(
            serverDomain = serverDomain,
            targetCommit = target,
            fromCommit = from,
            nonce = orderNonceHex,
            issuedAt = now,
        )
        val orderSig = (orderKey ?: irk).sign(canonical)

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

        return UpdateDepositBody(
            auth = MailboxAuthEnvelope.Auth(
                username = username,
                endpointLabel = "device",
                phoneIrkPub = irkPubHex,
                issuedAt = now,
                expiresAt = expiresAt,
                nonce = mailboxNonceHex,
            ),
            authSignature = HexUtil.encode(authSig),
            deposit = UpdateDepositBody.Deposit(
                serverDomain = serverDomain,
                requestNonceHex = depositNonceHex,
            ),
            order = UpdateDepositBody.Order(
                serverDomain = serverDomain,
                targetCommit = target,
                fromCommit = from,
                nonce = orderNonceHex,
                issuedAt = now,
            ),
            signature = HexUtil.encode(orderSig),
        )
    }
}
