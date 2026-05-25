// Kotlin mirror of Flagship/InstallBlob.swift.
//
// Phone-issued InstallBlob — the on-wire shape that mirrors
// apps/web/public/webapp/lib/buildDraft.js `canonicalInstallBlob`.
// Both mobile clients derive their signature input from
// `canonicalBytes()` so the wire-format bytes are guaranteed
// identical.

package com.flagshipserver.app.core

// v2: blob.issuedAt + blob.expiresAt dropped. authCode.expiresAt is
// the sole TTL on the recipe.
data class InstallBlob(
    var version: Int = 2,
    var serverDomain: String,
    var username: String,
    var serverName: String,
    var phoneDelegatedPubKey: ByteArray,
    var registrationUrl: String = "https://flagshipserver.com/api/server/register",
    var authCode: AuthCode,
    var authCodeUserSignature: ByteArray,
    var installerGitRef: String = "main",
    var rckPubKey: ByteArray,
    // Boot-unlock policy from server creation: "auto" (box-sealed lease
    // self-unlock, default) or "approve" (phone-gated every boot). Optional +
    // conditionally appended below — null ⇒ legacy bytes (absence == "auto").
    var bootUnlockMode: String? = null,
) {
    companion object {
        // Tag stays v1 — the inner `version` field discriminates the
        // v1-vs-v2 inputs by byte difference. MUST match the TS
        // canonicalInstallBlob byte-for-byte.
        const val CANONICAL_TAG = "flagship/install-blob/v1"
    }

    fun canonicalBytes(): ByteArray {
        val parts = mutableListOf(
            CANONICAL_TAG,
            version.toString(),
            serverDomain,
            username,
            serverName,
            HexUtil.encode(phoneDelegatedPubKey),
            registrationUrl,
            authCode.serial,
            HexUtil.encode(authCode.userPubKey),
            HexUtil.encode(authCodeUserSignature),
            installerGitRef,
            HexUtil.encode(rckPubKey),
        )
        // Backward-compatible: absent ⇒ exact legacy bytes; present ⇒ appended
        // last so the signer commits to it. MUST match TS canonicalInstallBlob.
        bootUnlockMode?.let { parts.add(it) }
        return parts.joinToString("|").toByteArray()
    }
}

data class AuthCode(
    var version: Int = 1,
    var serial: String,
    var username: String,
    var serverName: String,
    var serverDomain: String,
    var delegatedPubKey: ByteArray,
    var userPubKey: ByteArray,
    var issuedAt: Long,
    var expiresAt: Long,
) {
    companion object {
        const val CANONICAL_TAG = "flagship/auth-code/v1"
    }

    fun canonicalBytes(): ByteArray = listOf(
        CANONICAL_TAG,
        version.toString(),
        serial,
        username,
        serverName,
        serverDomain,
        HexUtil.encode(delegatedPubKey),
        HexUtil.encode(userPubKey),
        issuedAt.toString(),
        expiresAt.toString(),
    ).joinToString("|").toByteArray()
}

object UsernameClaim {
    const val CANONICAL_TAG = "flagship/claim-username/v1"
    fun canonicalBytes(username: String, irkPubHex: String, issuedAt: Long): ByteArray =
        listOf(CANONICAL_TAG, username, irkPubHex, issuedAt.toString())
            .joinToString("|").toByteArray()
}

object RckRegister {
    const val CANONICAL_TAG = "flagship/rck-register/v1"
    fun canonicalBytes(username: String, subdomain: String, rckPubHex: String, issuedAt: Long): ByteArray =
        listOf(CANONICAL_TAG, username, subdomain, rckPubHex, issuedAt.toString())
            .joinToString("|").toByteArray()
}

object AuthCodeRevoke {
    const val CANONICAL_TAG = "flagship/auth-code-revoke/v1"
    fun canonicalBytes(serial: String, username: String, issuedAt: Long): ByteArray =
        listOf(CANONICAL_TAG, serial, username, issuedAt.toString())
            .joinToString("|").toByteArray()
}

/** V3 — Service URL-stem rename envelope. Signed by the user's CURRENT
 *  IRK. The internal serviceId is preserved across renames; only the
 *  user-visible newDisplayLabel changes. Mirrors
 *  packages/protocol/src/auth.ts TAG_SERVICE_RENAME. */
object ServiceRenameClaim {
    const val CANONICAL_TAG = "flagship/service-rename/v1"
    fun canonicalBytes(
        username: String,
        serviceId: String,
        newDisplayLabel: String,
        issuedAt: Long,
    ): ByteArray = listOf(
        CANONICAL_TAG,
        username,
        serviceId,
        newDisplayLabel.lowercase(),
        issuedAt.toString(),
    ).joinToString("|").toByteArray()
}

/** #79A — attach an external (custom) domain to a service. Signed by the
 *  user's current IRK. Mirrors @flagship/protocol
 *  canonicalSetCustomDomain (auth.ts TAG_SET_CUSTOM_DOMAIN) and the
 *  iOS / webapp clients byte-for-byte so Live == Mock on the wire. */
object SetCustomDomainClaim {
    const val CANONICAL_TAG = "flagship/custom-domain/v1"
    fun canonicalBytes(
        username: String,
        serviceId: String,
        fqdn: String,
        issuedAt: Long,
    ): ByteArray = listOf(
        CANONICAL_TAG,
        username,
        serviceId,
        fqdn.lowercase(),
        issuedAt.toString(),
    ).joinToString("|").toByteArray()
}

/** V3 — voi.ci one-off short link envelope. Signed by IRK. Optional
 *  serviceId binds the link to a specific service so a rename can
 *  cascade-delete it. Mirrors TAG_VOICI_SHORTEN. */
object VoiciShortenClaim {
    const val CANONICAL_TAG = "flagship/voici-shorten/v1"
    fun canonicalBytes(
        username: String,
        serviceId: String?,
        targetUrl: String,
        issuedAt: Long,
    ): ByteArray = listOf(
        CANONICAL_TAG,
        username,
        serviceId ?: "",
        targetUrl,
        issuedAt.toString(),
    ).joinToString("|").toByteArray()
}

/** C7 — Re-pair initiate envelope. Signed by the NEW IRK. Mirrors
 *  packages/protocol/src/auth.ts TAG_RE_PAIR_INITIATE. */
object RePairInitiateClaim {
    const val CANONICAL_TAG = "flagship/re-pair-initiate/v1"
    fun canonicalBytes(
        username: String,
        newIrkPubHex: String,
        oldIrkPubHex: String,
        issuedAt: Long,
    ): ByteArray = listOf(
        CANONICAL_TAG,
        username,
        newIrkPubHex.lowercase(),
        oldIrkPubHex.lowercase(),
        issuedAt.toString(),
    ).joinToString("|").toByteArray()
}

/** E4 — Wipe & restart envelope. Signed by the OLD IRK. Mirrors
 *  packages/protocol/src/auth.ts TAG_WIPE_RESTART. */
object WipeRestartClaim {
    const val CANONICAL_TAG = "flagship/wipe-restart/v1"
    fun canonicalBytes(
        username: String,
        oldIrkPubHex: String,
        newIrkPubHex: String,
        newCredentialIdHex: String,
        newWrappedUmkHashHex: String,
        issuedAt: Long,
    ): ByteArray = listOf(
        CANONICAL_TAG,
        username,
        oldIrkPubHex.lowercase(),
        newIrkPubHex.lowercase(),
        newCredentialIdHex.lowercase(),
        newWrappedUmkHashHex.lowercase(),
        issuedAt.toString(),
    ).joinToString("|").toByteArray()
}

object PushTokenRegister {
    const val CANONICAL_TAG = "flagship/push-token-register/v1"

    /**
     * Field order must match the Worker's canonicalPushTokenRegister
     * in packages/protocol/src/auth.ts. The `label` field was added
     * pre-launch (no v2 bump needed); it slots between pushX25519Pub
     * and issuedAt on both sides.
     */
    fun canonicalBytes(
        username: String,
        platform: String,
        providerToken: String,
        pushX25519PubHex: String,
        label: String,
        issuedAt: Long,
    ): ByteArray = listOf(
        CANONICAL_TAG, username, platform, providerToken, pushX25519PubHex, label, issuedAt.toString()
    ).joinToString("|").toByteArray()
}

object HexUtil {
    fun encode(data: ByteArray): String {
        val sb = StringBuilder(data.size * 2)
        for (b in data) sb.append(String.format("%02x", b.toInt() and 0xff))
        return sb.toString()
    }
    fun decode(hex: String): ByteArray? {
        if (hex.length % 2 != 0) return null
        return try {
            ByteArray(hex.length / 2) { i ->
                hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
            }
        } catch (e: NumberFormatException) { null }
    }
}

object SerialGen {
    private val rng = java.security.SecureRandom()
    fun random(): String {
        val raw = ByteArray(10).also(rng::nextBytes)
        return "01" + raw.joinToString("") { String.format("%02X", it.toInt() and 0xff) }
    }
}
