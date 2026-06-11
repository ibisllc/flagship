// Kotlin mirror of the AcmeAccountKeyGrant envelope in
// packages/protocol/src/auth.ts (canonicalAcmeAccountKeyGrant /
// signAcmeAccountKeyGrant) and FlagshipCore/AcmeAccountKeyGrant.swift.
//
// #28 — SEAL-TO-BOX of the user's shared ACME account key. The ACME account
// key is the authority to mint Let's Encrypt certs in the user's namespace
// (cert model A′: the box's per-box `[<server>.<user>, *.<server>.<user>]`
// cert). An admin device seals the raw PKCS#8 account key FOR a box's STK
// (SecretSeal.sealForEd25519Recipient), then IRK-signs THIS envelope binding
// the sealed blob to the recipient STK + accountKeyId. The box later unseals
// with its own STK seed and mints under the user's shared LE account; `.com`
// stores only the ciphertext (audit / escrow) and never sees the key.
//
// The canonical bytes + `|`-joined field order MUST match the Worker
// byte-for-byte or server verification fails. recipientPubKey + sealedAccountKey
// are emitted as LOWERCASE hex (HexUtil.encode); issuedAt / expiresAt are raw
// millisecond integers. The TS canonical does NOT lowercase username or
// accountKeyId — they are joined verbatim, so callers pass them already-normalized
// (the control-plane handler lowercases username on its own before storage, but
// the SIGNED bytes use whatever the producer passed).

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify

object AcmeAccountKeyGrant {
    const val CANONICAL_TAG = "flagship/acme-account-key-grant/v1"

    /** Generous bound mirroring MAX_SEALED_ACCOUNT_KEY in auth.ts — a sealed
     *  P-256 PKCS#8 keypair is far under this. */
    const val MAX_SEALED_ACCOUNT_KEY = 4096

    /** Reject the structural defects the TS canonical-bytes pass throws on, so
     *  a malformed envelope fails here rather than producing bytes the Worker
     *  will refuse. Mirrors validateAcmeAccountKeyGrantFields. */
    private fun validate(
        grantId: String,
        username: String,
        accountKeyId: String,
        recipientPubKey: ByteArray,
        sealedAccountKey: ByteArray,
        issuedAt: Long,
        expiresAt: Long,
    ) {
        for ((name, value) in listOf(
            "grantId" to grantId,
            "username" to username,
            "accountKeyId" to accountKeyId,
        )) {
            require(value.isNotEmpty()) { "AcmeAccountKeyGrant: empty \"$name\"" }
            for (ch in value) {
                val c = ch.code
                require(c != 0x7c) { "AcmeAccountKeyGrant field \"$name\" contains separator '|'" }
                require(c > 0x1f && c != 0x7f) { "AcmeAccountKeyGrant field \"$name\" contains a control char" }
            }
        }
        require(expiresAt > issuedAt) { "AcmeAccountKeyGrant: expiresAt must be strictly after issuedAt" }
        require(recipientPubKey.size == 32) { "AcmeAccountKeyGrant: recipientPubKey must be 32 bytes, got ${recipientPubKey.size}" }
        require(sealedAccountKey.isNotEmpty() && sealedAccountKey.size <= MAX_SEALED_ACCOUNT_KEY) {
            "AcmeAccountKeyGrant: sealedAccountKey must be non-empty within bounds"
        }
    }

    fun canonicalBytes(
        grantId: String,
        username: String,
        accountKeyId: String,
        recipientPubKey: ByteArray,
        sealedAccountKey: ByteArray,
        issuedAt: Long,
        expiresAt: Long,
    ): ByteArray {
        validate(grantId, username, accountKeyId, recipientPubKey, sealedAccountKey, issuedAt, expiresAt)
        return listOf(
            CANONICAL_TAG,
            grantId,
            username,
            accountKeyId,
            HexUtil.encode(recipientPubKey),
            HexUtil.encode(sealedAccountKey),
            issuedAt.toString(),
            expiresAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** Sign with the account's CURRENT IRK — the only key the cloud accepts. */
    fun sign(
        irk: Ed25519Sign,
        grantId: String,
        username: String,
        accountKeyId: String,
        recipientPubKey: ByteArray,
        sealedAccountKey: ByteArray,
        issuedAt: Long,
        expiresAt: Long,
    ): ByteArray = irk.sign(
        canonicalBytes(grantId, username, accountKeyId, recipientPubKey, sealedAccountKey, issuedAt, expiresAt)
    )

    /** Verify a signature under the account IRK public key. Returns false
     *  (never throws) on malformed input, mirroring verifyAcmeAccountKeyGrant. */
    fun verify(
        signature: ByteArray,
        irkPub: ByteArray,
        grantId: String,
        username: String,
        accountKeyId: String,
        recipientPubKey: ByteArray,
        sealedAccountKey: ByteArray,
        issuedAt: Long,
        expiresAt: Long,
    ): Boolean = try {
        Ed25519Verify(irkPub).verify(
            signature,
            canonicalBytes(grantId, username, accountKeyId, recipientPubKey, sealedAccountKey, issuedAt, expiresAt),
        )
        true
    } catch (_: Throwable) {
        false
    }
}
