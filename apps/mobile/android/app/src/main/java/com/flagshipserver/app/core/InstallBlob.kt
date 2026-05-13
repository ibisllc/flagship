// Kotlin mirror of Flagship/InstallBlob.swift.
//
// Phone-issued InstallBlob — the on-wire shape that mirrors
// apps/web/public/webapp/lib/buildDraft.js `canonicalInstallBlob`.
// Both mobile clients derive their signature input from
// `canonicalBytes()` so the wire-format bytes are guaranteed
// identical.

package com.flagshipserver.app.core

data class InstallBlob(
    var version: Int = 1,
    var serverDomain: String,
    var username: String,
    var serverName: String,
    var phoneDelegatedPubKey: ByteArray,
    var registrationUrl: String = "https://flagship.services/api/server/register",
    var authCode: AuthCode,
    var authCodeUserSignature: ByteArray,
    var issuedAt: Long,
    var expiresAt: Long,
    var installerGitRef: String = "main",
    var rckPubKey: ByteArray,
) {
    companion object {
        const val CANONICAL_TAG = "flagship/install-blob/v1"
    }

    fun canonicalBytes(): ByteArray {
        val parts = listOf(
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
            issuedAt.toString(),
            expiresAt.toString(),
            installerGitRef,
            HexUtil.encode(rckPubKey),
        )
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

object PushTokenRegister {
    const val CANONICAL_TAG = "flagship/push-token-register/v1"
    fun canonicalBytes(
        username: String,
        platform: String,
        providerToken: String,
        pushX25519PubHex: String,
        issuedAt: Long
    ): ByteArray = listOf(
        CANONICAL_TAG, username, platform, providerToken, pushX25519PubHex, issuedAt.toString()
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
