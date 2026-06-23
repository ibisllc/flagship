package com.flagshipserver.app.core

import com.flagshipserver.app.api.MailboxAuthEnvelope
import com.flagshipserver.app.api.SetLeaderDepositBody
import com.google.crypto.tink.subtle.Ed25519Sign
import java.security.SecureRandom

/**
 * Phone side of the "Set as preferred server" owner vote (per-service leadership
 * Phase 6, docs/multi-pod-liveness-session-leadership.md). Kotlin mirror of the
 * iOS FlagshipCore/SetLeaderDeposit.swift.
 *
 * The owner signs the existing `flagship/set-leader/v1` vote
 * ([CloudGossip.setLeaderCanonicalBytes]: owner IRK over
 * `user|preferredStkPubHex|issuedAt|nonce`) for the chosen pod's STK and deposits
 * it ADDRESSED TO that box's domain. Unlike the SWK/CGK deposits this carrier is
 * the PUBLIC vote (no secret) — `.com` verifies the owner-IRK signature before
 * storing, and the box re-verifies on consume, riding it on its gossip frame
 * (clout). `preferredStkPubHex == "none"` clears the vote.
 *
 * Body shape mirrors how `depositSwk`/`depositDecommission` build their
 * `{auth, ...}` mailbox wrapper, matching the Worker handler
 * (`handlePostSetLeaderDeposit`):
 *   `{auth, authSignature, deposit:{serverDomain,requestNonceHex},
 *     vote:{user,preferredStkPubHex,issuedAt,nonce}, signature}`.
 */
object SetLeaderDeposit {
    private val rng = SecureRandom()
    private fun randomHex(n: Int): String {
        val b = ByteArray(n); rng.nextBytes(b); return HexUtil.encode(b)
    }

    /** Build the full deposit body. `preferredStkPubHex` is the chosen box's STK
     *  (32-byte hex) or [CloudGossip.SET_LEADER_NONE] to clear the vote. Throws
     *  IllegalArgumentException on a malformed (non-"none", non-32-byte) pub. */
    fun buildDeposit(
        username: String,
        serverDomain: String,
        preferredStkPubHex: String,
        irk: Ed25519Sign,
        irkPubHex: String,
        now: Long = System.currentTimeMillis(),
        mailboxNonceHex: String = randomHex(32),
        depositNonceHex: String = randomHex(32),
        voteNonceHex: String = randomHex(32),
    ): SetLeaderDepositBody {
        val pref = preferredStkPubHex.lowercase()
        // Either the 32-byte hex pub or the "none" sentinel.
        if (pref != CloudGossip.SET_LEADER_NONE) {
            val raw = HexUtil.decode(pref)
            require(raw != null && raw.size == 32) { "preferred STK pub must be 32-byte hex or \"none\"" }
        }

        val canonical = CloudGossip.setLeaderCanonicalBytes(username, pref, now, voteNonceHex)
        val voteSig = irk.sign(canonical)

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

        return SetLeaderDepositBody(
            auth = MailboxAuthEnvelope.Auth(
                username = username,
                endpointLabel = "device",
                phoneIrkPub = irkPubHex,
                issuedAt = now,
                expiresAt = expiresAt,
                nonce = mailboxNonceHex,
            ),
            authSignature = HexUtil.encode(authSig),
            deposit = SetLeaderDepositBody.Deposit(
                serverDomain = serverDomain,
                requestNonceHex = depositNonceHex,
            ),
            vote = SetLeaderDepositBody.Vote(
                // The box re-lowercases when re-deriving the canonical bytes, so
                // these wire values match what was signed regardless of case.
                user = username,
                preferredStkPubHex = pref,
                issuedAt = now,
                nonce = voteNonceHex,
            ),
            signature = HexUtil.encode(voteSig),
        )
    }
}
