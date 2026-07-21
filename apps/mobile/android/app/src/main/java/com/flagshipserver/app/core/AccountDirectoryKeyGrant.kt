// Kotlin mirror of the sealed directory/profile-key delivery in
// packages/protocol/src/directoryKeyDelivery.ts (+ the AccountDirectoryKeyGrant
// envelope in accountMetadata.ts) and FlagshipCore/AccountDirectoryKeyGrant.swift.
//
// A RESTRICTED device never holds the account UMK, so it cannot derive the
// account-profile or device-directory keys and can list the private directory
// but decrypt no names. An admin seals the permitted 32-byte key to this
// device's Ed25519 identity pubkey via SecretSeal (the primitive pinned by the
// four cross-platform seal KATs) and publishes an admin-root-signed grant. This
// verifies the admin-root signature + account/device binding (+ expiry) BEFORE
// unsealing with the device's own Ed25519 seed, then hands the key to
// AccountMetadata.decrypt.
//
// The canonical bytes + `|` order MUST match canonicalAccountDirectoryKeyGrant
// byte-for-byte; the OPEN direction is pinned by the shared
// test-vectors/directory-key-delivery.json.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Verify

object AccountDirectoryKeyGrant {
    const val CANONICAL_TAG = "flagship/account-directory-key-grant/v1"

    enum class KeyKind(val wire: String) {
        ACCOUNT_PROFILE("account-profile"),
        DEVICE_DIRECTORY("device-directory");

        companion object {
            fun fromWire(v: String): KeyKind? = entries.firstOrNull { it.wire == v }
        }
    }

    private val deviceIdPattern = Regex("^[0-9a-f]{32}$")
    private val hex64Pattern = Regex("^[0-9a-f]{64}$")
    private val hexPattern = Regex("^[0-9a-f]+$")

    private fun validate(
        accountId: String,
        recipientDeviceId: String,
        sealedKeyHex: String,
        signerPubHex: String,
        issuedAt: Long,
        expiresAt: Long,
    ) {
        require(accountId.isNotEmpty()) { "AccountDirectoryKeyGrant: empty accountId" }
        require('|' !in accountId) { "AccountDirectoryKeyGrant: accountId contains separator" }
        require(deviceIdPattern.matches(recipientDeviceId)) { "AccountDirectoryKeyGrant: bad recipientDeviceId" }
        require(sealedKeyHex.length >= 2 && hexPattern.matches(sealedKeyHex)) { "AccountDirectoryKeyGrant: bad sealedKeyHex" }
        require(hex64Pattern.matches(signerPubHex)) { "AccountDirectoryKeyGrant: bad signerPubHex" }
        require(expiresAt > issuedAt) { "AccountDirectoryKeyGrant: expiresAt must be after issuedAt" }
    }

    fun canonicalBytes(
        accountId: String,
        recipientDeviceId: String,
        keyKind: KeyKind,
        sealedKeyHex: String,
        issuedAt: Long,
        expiresAt: Long,
        signerPubHex: String,
    ): ByteArray {
        validate(accountId, recipientDeviceId, sealedKeyHex, signerPubHex, issuedAt, expiresAt)
        return listOf(
            CANONICAL_TAG,
            accountId.lowercase(),
            recipientDeviceId,
            keyKind.wire,
            sealedKeyHex,
            issuedAt.toString(),
            expiresAt.toString(),
            signerPubHex,
        ).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** Verify the admin-root signature. Returns false (never throws) on any
     *  malformed input, mirroring verifyAccountDirectoryKeyGrant. */
    fun verify(
        signature: ByteArray,
        adminRootPub: ByteArray,
        accountId: String,
        recipientDeviceId: String,
        keyKind: KeyKind,
        sealedKeyHex: String,
        issuedAt: Long,
        expiresAt: Long,
        signerPubHex: String,
    ): Boolean = try {
        Ed25519Verify(adminRootPub).verify(
            signature,
            canonicalBytes(accountId, recipientDeviceId, keyKind, sealedKeyHex, issuedAt, expiresAt, signerPubHex),
        )
        true
    } catch (_: Throwable) {
        false
    }

    /**
     * RECIPIENT-side open: verify the admin-root signature + account/device
     * binding (+ expiry when `now` is supplied), THEN unseal the delivered key
     * with the device's Ed25519 identity seed. Returns the 32-byte key, or null
     * on ANY defect. Never throws — fails closed.
     */
    fun open(
        accountId: String,
        recipientDeviceId: String,
        keyKind: KeyKind,
        sealedKeyHex: String,
        issuedAt: Long,
        expiresAt: Long,
        signerPubHex: String,
        signature: ByteArray,
        adminRootPub: ByteArray,
        expectedAccountId: String,
        expectedRecipientDeviceId: String,
        recipientDeviceSeed: ByteArray,
        now: Long? = null,
    ): ByteArray? {
        if (accountId.lowercase() != expectedAccountId.lowercase()) return null
        if (recipientDeviceId != expectedRecipientDeviceId.lowercase()) return null
        if (now != null && (now < issuedAt || now >= expiresAt)) return null
        val ok = verify(
            signature, adminRootPub, accountId, recipientDeviceId, keyKind,
            sealedKeyHex, issuedAt, expiresAt, signerPubHex,
        )
        if (!ok) return null
        val blob = HexUtil.decode(sealedKeyHex) ?: return null
        return try {
            val key = SecretSeal.openWithEd25519Seed(blob, recipientDeviceSeed)
            if (key.size != 32) null else key
        } catch (_: Throwable) {
            null
        }
    }
}
