// Device names for "Invited by <device>" (and the trusted-devices list): read
// from the signed account directory and decrypted on this phone, so `.com` and
// the box never see a name. A device that may not read the directory just gets
// no names; callers fall back to "another device".

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.api.AccountDirectoryAuthorization
import com.flagshipserver.app.api.AccountDirectoryDevice
import com.flagshipserver.app.api.AccountDirectoryResponse
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.core.AccountMetadata
import com.flagshipserver.app.core.AccountMetadataCiphertext
import com.flagshipserver.app.core.AccountMetadataCoordinates
import com.flagshipserver.app.core.AccountMetadataRecordType
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.keystore.Keystore

object AccountDeviceNames {
    private const val TTL_MS = 5 * 60_000L
    private val cache = mutableMapOf<String, Pair<Long, Map<String, String>>>()

    /** The owner-set (managed) name, else the device's own, else null. */
    fun decryptedName(directory: AccountDirectoryResponse, device: AccountDirectoryDevice, user: String, directoryKey: ByteArray): String? {
        val managed = directory.managedProfiles.firstOrNull { it.deviceId == device.deviceId }
        if (managed != null) {
            return runCatching {
                AccountMetadata.decrypt(
                    AccountMetadataCiphertext(managed.nonceHex, managed.ciphertextHex),
                    directoryKey,
                    AccountMetadataCoordinates(user, AccountMetadataRecordType.DEVICE_MANAGED_PROFILE, managed.revision, managed.keyVersion, device.deviceId),
                )
            }.getOrNull()
        }
        val own = directory.selfProfiles.firstOrNull { it.deviceId == device.deviceId } ?: return null
        return runCatching {
            AccountMetadata.decrypt(
                AccountMetadataCiphertext(own.nonceHex, own.ciphertextHex),
                directoryKey,
                AccountMetadataCoordinates(user, AccountMetadataRecordType.DEVICE_SELF_PROFILE, own.revision, own.keyVersion, device.deviceId),
            )
        }.getOrNull()
    }

    fun platformLabel(value: String?): String = when (value) {
        "ios" -> "iPhone"
        "android" -> "Android"
        "web" -> FSStrings.get(R.string.web_browser)
        "macos" -> "Mac"
        else -> "Device"
    }

    /** deviceId → the name the trusted-devices list shows, for every device the
     *  directory knows (revoked ones too: they may have invited someone). */
    fun names(directory: AccountDirectoryResponse, user: String, umk: ByteArray): Map<String, String> {
        val directoryKey = AccountMetadata.deriveDeviceDirectoryKey(umk)
        return directory.devices.associate { d ->
            d.deviceId to (decryptedName(directory, d, user, directoryKey) ?: FSStrings.get(R.string.device, platformLabel(d.platformClass), d.supportCode))
        }
    }

    /** Fetch, verify and decrypt the directory as [deviceId]; null when this
     *  device can't read it. Cached a few minutes per account and device. */
    suspend fun load(
        server: FlagshipServerClient,
        user: String,
        deviceId: String,
        now: () -> Long = { System.currentTimeMillis() },
        umk: () -> ByteArray = { check(Keystore.hasUmkSeed()) { "no account seed" }; Keystore.currentUmkSeed() },
    ): Map<String, String>? {
        if (deviceId.length != 32) return null
        val key = "${user.lowercase()}|$deviceId"
        synchronized(cache) {
            cache[key]?.let { (at, names) -> if (now() - at < TTL_MS) return names }
        }
        return try {
            val seed = umk()
            val signer = Keystore.accountDeviceSigner(seed, user, deviceId)
            val signerPubHex = HexUtil.encode(Keystore.accountDevicePublicKey(seed, user, deviceId))
            val requestId = AccountMetadata.generateDeviceId()
            val issuedAt = now()
            val canonical = AccountMetadata.canonicalDirectoryRequest(
                accountId = user,
                deviceId = deviceId,
                signerPubHex = signerPubHex,
                method = "GET",
                path = "/api/accounts/${user.lowercase()}/directory",
                requestId = requestId,
                issuedAt = issuedAt,
            )
            val directory = server.accountDirectory(
                user,
                AccountDirectoryAuthorization(deviceId, signerPubHex, requestId, issuedAt, HexUtil.encode(signer.sign(canonical))),
            )
            names(directory, user, seed).also { synchronized(cache) { cache[key] = now() to it } }
        } catch (_: Throwable) {
            null
        }
    }

    fun clear() = synchronized(cache) { cache.clear() }
}
