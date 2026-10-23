// An active admin's veto of a pending recovery (SECURITY-HARDENING-PLAN.md 10.6, N04).
// Kotlin mirror of FlagshipCore/RePairVeto.swift and @flagship/protocol recovery.ts; canonical
// bytes are pinned by packages/protocol/test-vectors/re-pair-veto/vectors.json.
//
// Signed with the account's admin root behind the device's biometric. It names the exact
// attempt (the pending device key, when it began, its deadline), so it can never be replayed
// onto a later attempt.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign

data class RePairVeto(
    val username: String,
    val newIrkPubHex: String,
    val initiatedAt: Long,
    val completesAt: Long,
    val vetoerPubHex: String,
    val issuedAt: Long,
) {
    /** `flagship/re-pair-veto/v1|<username lowercase>|<newIrkPubHex>|<initiatedAt>|<completesAt>|<vetoerPubHex>|<issuedAt>` */
    fun canonicalBytes(): ByteArray {
        guard("username", username)
        guard("newIrkPub", newIrkPubHex)
        guard("vetoerPub", vetoerPubHex)
        require(initiatedAt >= 0) { "re-pair-veto: bad initiatedAt" }
        require(completesAt >= 0) { "re-pair-veto: bad completesAt" }
        require(issuedAt >= 0) { "re-pair-veto: bad issuedAt" }
        return listOf(CANONICAL_TAG, username.lowercase(), newIrkPubHex, initiatedAt.toString(), completesAt.toString(), vetoerPubHex, issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun sign(key: Ed25519Sign): ByteArray = key.sign(canonicalBytes())

    private fun guard(name: String, v: String) {
        require(v.isNotEmpty()) { "re-pair-veto: empty $name" }
        for (ch in v) require(ch != '|' && ch.code > 0x1f && ch.code != 0x7f) { "re-pair-veto: bad character in $name" }
    }

    companion object {
        const val CANONICAL_TAG = "flagship/re-pair-veto/v1"
    }
}

/** The sentences the recovery screens show; the same words as iOS and the webapp. */
object RecoveryReviewCopy {
    const val CONFIRM_TITLE = "Reject this recovery?"
    const val CONFIRM_MESSAGE =
        "This cancels the recovery attempt. If the real owner is trying to get back in, they will have to start again and wait the full time. Only reject it if you do not expect it."
    const val UNUSUAL_NOTE = "If this is unusual, please check on the physical safety of your device and server."
}
