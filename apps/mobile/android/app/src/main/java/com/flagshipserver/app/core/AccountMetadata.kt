package com.flagshipserver.app.core

import java.nio.charset.StandardCharsets.UTF_8
import java.security.SecureRandom
import java.security.MessageDigest
import java.text.Normalizer
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import com.google.crypto.tink.subtle.Ed25519Sign

enum class AccountMetadataRecordType(val wireValue: String) {
    ACCOUNT_PROFILE("account-profile"),
    DEVICE_SELF_PROFILE("device-self-profile"),
    DEVICE_MANAGED_PROFILE("device-managed-profile"),
}

data class AccountMetadataCoordinates(
    val accountId: String,
    val recordType: AccountMetadataRecordType,
    val revision: Long,
    val keyVersion: Long,
    val deviceId: String? = null,
)

data class AccountMetadataCiphertext(val nonceHex: String, val ciphertextHex: String)

object AccountMetadata {
    private const val SALT = "flagship/account-metadata/v1"
    private val deviceIdPattern = Regex("^[0-9a-f]{32}$")
    private val graphemePattern = Regex("\\X")
    private val bidiControls = setOf(
        0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
        0x2066, 0x2067, 0x2068, 0x2069,
    )

    fun deriveAccountProfileKey(umk: ByteArray): ByteArray = deriveKey(umk, "account-profile")

    fun deriveDeviceDirectoryKey(umk: ByteArray): ByteArray = deriveKey(umk, "device-directory")

    internal fun deriveAccountDeviceSeed(umk: ByteArray, accountId: String, deviceId: String): ByteArray {
        require(accountId.isNotEmpty() && '|' !in accountId && deviceIdPattern.matches(deviceId))
        val info = "flagship/account-device-key/v1|${accountId.lowercase()}|$deviceId".toByteArray(UTF_8)
        val extract = Mac.getInstance("HmacSHA256")
        extract.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
        val prk = extract.doFinal(umk)
        val expand = Mac.getInstance("HmacSHA256")
        expand.init(SecretKeySpec(prk, "HmacSHA256"))
        expand.update(info)
        expand.update(1)
        return expand.doFinal()
    }

    fun deriveAccountDeviceKey(umk: ByteArray, accountId: String, deviceId: String): Ed25519Sign =
        Ed25519Sign(deriveAccountDeviceSeed(umk, accountId, deviceId))

    fun deriveAccountDevicePub(umk: ByteArray, accountId: String, deviceId: String): ByteArray {
        return Ed25519Sign.KeyPair.newKeyPairFromSeed(deriveAccountDeviceSeed(umk, accountId, deviceId)).publicKey
    }

    fun generateDeviceId(): String = HexUtil.encode(ByteArray(16).also(SecureRandom()::nextBytes))

    fun deviceSupportCode(accountId: String, deviceId: String, devicePublicKey: ByteArray): String {
        val input = "flagship/device-support-code/v1|$accountId|$deviceId|${HexUtil.encode(devicePublicKey)}"
        val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(UTF_8))
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        var accumulator = 0
        var bits = 0
        val encoded = StringBuilder(8)
        for (byte in digest) {
            accumulator = (accumulator shl 8) or (byte.toInt() and 0xff)
            bits += 8
            while (bits >= 5 && encoded.length < 8) {
                bits -= 5
                encoded.append(alphabet[(accumulator shr bits) and 31])
            }
            if (encoded.length == 8) break
        }
        return "${encoded.substring(0, 4)}-${encoded.substring(4, 8)}"
    }

    fun validateDisplayName(input: String): String {
        val value = Normalizer.normalize(input.trim(), Normalizer.Form.NFC)
        require(value.isNotEmpty()) { "display name must not be empty" }
        value.codePoints().forEach { codePoint ->
            require(codePoint !in 0x00..0x1f && codePoint !in 0x7f..0x9f) {
                "display name contains a control character"
            }
            require(codePoint !in bidiControls) { "display name contains a text-direction control character" }
        }
        require(graphemePattern.findAll(value).count() <= 64) { "display name is too long" }
        require(value.toByteArray(UTF_8).size <= 256) { "display name is too long" }
        return value
    }

    fun encrypt(
        displayName: String,
        keyBytes: ByteArray,
        coordinates: AccountMetadataCoordinates,
        nonceBytes: ByteArray = ByteArray(12).also(SecureRandom()::nextBytes),
    ): AccountMetadataCiphertext {
        val name = validateDisplayName(displayName)
        validate(coordinates)
        require(keyBytes.size == 32) { "profile key must be 32 bytes" }
        require(nonceBytes.size == 12) { "profile nonce must be 12 bytes" }
        val plaintext = "{\"version\":1,\"displayName\":${JsonPrimitive(name)}}".toByteArray(UTF_8)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, nonceBytes))
        cipher.updateAAD(aad(coordinates))
        return AccountMetadataCiphertext(
            nonceHex = HexUtil.encode(nonceBytes),
            ciphertextHex = HexUtil.encode(cipher.doFinal(plaintext)),
        )
    }

    fun decrypt(
        ciphertext: AccountMetadataCiphertext,
        keyBytes: ByteArray,
        coordinates: AccountMetadataCoordinates,
    ): String {
        validate(coordinates)
        require(keyBytes.size == 32) { "profile key must be 32 bytes" }
        val nonce = requireNotNull(HexUtil.decode(ciphertext.nonceHex))
        val encrypted = requireNotNull(HexUtil.decode(ciphertext.ciphertextHex))
        require(nonce.size == 12 && encrypted.size >= 16) { "malformed profile ciphertext" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad(coordinates))
        val parsed = Json.parseToJsonElement(cipher.doFinal(encrypted).toString(UTF_8))
        require(parsed is JsonObject && parsed.keys == setOf("version", "displayName")) {
            "invalid profile plaintext"
        }
        require(parsed["version"]?.jsonPrimitive?.intOrNull == 1) { "invalid profile version" }
        return validateDisplayName(requireNotNull(parsed["displayName"]).jsonPrimitive.content)
    }

    fun canonicalAccountProfile(accountId: String, revision: Long, keyVersion: Long, ciphertext: AccountMetadataCiphertext, issuedAt: Long, signerPubHex: String): ByteArray =
        canonicalSigned("flagship/account-profile/v1", accountId, "", revision, keyVersion, ciphertext, "", issuedAt, signerPubHex)

    fun canonicalDeviceSelfProfile(accountId: String, deviceId: String, revision: Long, keyVersion: Long, ciphertext: AccountMetadataCiphertext, issuedAt: Long, signerPubHex: String): ByteArray =
        canonicalSigned("flagship/device-profile-self/v1", accountId, deviceId, revision, keyVersion, ciphertext, "", issuedAt, signerPubHex)

    fun canonicalDeviceManagedProfile(accountId: String, deviceId: String, revision: Long, keyVersion: Long, ciphertext: AccountMetadataCiphertext, locked: Boolean, issuedAt: Long, signerPubHex: String): ByteArray =
        canonicalSigned("flagship/device-profile-admin/v1", accountId, deviceId, revision, keyVersion, ciphertext, if (locked) "1" else "0", issuedAt, signerPubHex)

    fun canonicalDirectoryRequest(accountId: String, deviceId: String, signerPubHex: String, method: String, path: String, requestId: String, issuedAt: Long): ByteArray =
        listOf("flagship/account-directory-request/v1", method, path, accountId.lowercase(), deviceId, signerPubHex, requestId, issuedAt.toString())
            .joinToString("|").toByteArray(UTF_8)

    private fun canonicalSigned(tag: String, accountId: String, deviceId: String, revision: Long, keyVersion: Long, ciphertext: AccountMetadataCiphertext, locked: String, issuedAt: Long, signerPubHex: String): ByteArray =
        listOf(tag, accountId.lowercase(), deviceId, revision.toString(), keyVersion.toString(), ciphertext.nonceHex, ciphertext.ciphertextHex, locked, issuedAt.toString(), signerPubHex)
            .joinToString("|").toByteArray(UTF_8)

    private fun deriveKey(umk: ByteArray, info: String): ByteArray {
        require(umk.size == 32) { "UMK must be 32 bytes" }
        val extract = Mac.getInstance("HmacSHA256")
        extract.init(SecretKeySpec(SALT.toByteArray(UTF_8), "HmacSHA256"))
        val prk = extract.doFinal(umk)
        val expand = Mac.getInstance("HmacSHA256")
        expand.init(SecretKeySpec(prk, "HmacSHA256"))
        expand.update(info.toByteArray(UTF_8))
        expand.update(1)
        return expand.doFinal()
    }

    private fun validate(coordinates: AccountMetadataCoordinates) {
        require(coordinates.accountId.isNotEmpty() && '|' !in coordinates.accountId)
        require(coordinates.revision > 0 && coordinates.keyVersion > 0)
        when (coordinates.recordType) {
            AccountMetadataRecordType.ACCOUNT_PROFILE -> require(coordinates.deviceId.isNullOrEmpty())
            else -> require(coordinates.deviceId != null && deviceIdPattern.matches(coordinates.deviceId))
        }
    }

    private fun aad(coordinates: AccountMetadataCoordinates): ByteArray = listOf(
        "flagship/account-metadata-aad/v1",
        coordinates.accountId.lowercase(),
        coordinates.recordType.wireValue,
        coordinates.deviceId.orEmpty(),
        coordinates.revision.toString(),
        coordinates.keyVersion.toString(),
    ).joinToString("|").toByteArray(UTF_8)
}
