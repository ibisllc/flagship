// Mirror of FlagshipUI.ViewModels.SettingsViewModel's trusted-devices
// slice on iOS — extracted into its own ViewModel on Android because
// the Material 3 idiom is a separate screen (NavHost destination)
// rather than an in-Settings section.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.flagshipserver.app.api.AccountDirectoryAuthorization
import com.flagshipserver.app.api.AccountDirectoryResponse
import com.flagshipserver.app.api.DirectoryManagedProfileEnvelope
import com.flagshipserver.app.api.DirectoryManagedProfileWriteRequest
import com.flagshipserver.app.api.DirectoryProfileEnvelope
import com.flagshipserver.app.api.DirectoryProfileWriteRequest
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.PendingRePairSnapshot
import com.flagshipserver.app.core.AccountMetadata
import com.flagshipserver.app.core.AccountMetadataCiphertext
import com.flagshipserver.app.core.AccountMetadataCoordinates
import com.flagshipserver.app.core.AccountMetadataRecordType
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.Profile
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class TrustedDevicesViewModel(
    private val server: FlagshipServerClient,
    private val username: () -> String?,
    private val profile: () -> Profile? = { null },
    private val cacheNames: (String, String?) -> Unit = { _, _ -> },
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {

    data class DirectoryDevice(
        val deviceId: String,
        val displayName: String,
        val platformClass: String?,
        val supportCode: String,
        val createdAt: Long,
        val lastSeenAt: Long,
        val isCurrent: Boolean,
        val isAdministrator: Boolean,
        val isRestricted: Boolean,
        val isManaged: Boolean,
        val isLocked: Boolean,
    )

    sealed interface State {
        data object Idle : State
        data object Loading : State
        data class Loaded(val devices: List<DirectoryDevice>) : State
        data class Failed(val reason: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()
    private val _etag = MutableStateFlow<String?>(null)
    val etag: StateFlow<String?> = _etag.asStateFlow()
    private val _accountDisplayName = MutableStateFlow<String?>(null)
    val accountDisplayName: StateFlow<String?> = _accountDisplayName.asStateFlow()
    private var directorySnapshot: AccountDirectoryResponse? = null

    /** M4 — the pending re-pair snapshot (GET /api/users/:u/re-pair),
     *  mirroring the webapp + iOS. Drives the "Replace pending" banner so
     *  a device replacement started on ANY device surfaces here with a
     *  grace countdown + a "Finalize now" entry into the finalize screen.
     *  null while loading / nothing pending / endpoint unavailable. */
    private val _pendingRePair = MutableStateFlow<PendingRePairSnapshot?>(null)
    val pendingRePair: StateFlow<PendingRePairSnapshot?> = _pendingRePair.asStateFlow()

    fun load() {
        viewModelScope.launch {
            val user = username()
            if (user.isNullOrEmpty()) {
                _state.value = State.Loaded(emptyList())
                _pendingRePair.value = null
                return@launch
            }
            val activeProfile = profile()
            if (activeProfile == null || activeProfile.deviceId.length != 32) {
                _state.value = State.Failed("This device has no account-scoped identity.")
                return@launch
            }
            _state.value = State.Loading
            try {
                val umk = Keystore.currentUmkSeed()
                val signer = Keystore.accountDeviceSigner(umk, user, activeProfile.deviceId)
                val signerPubHex = HexUtil.encode(Keystore.accountDevicePublicKey(umk, user, activeProfile.deviceId))
                val requestId = AccountMetadata.generateDeviceId()
                val issuedAt = now()
                val path = "/api/accounts/${user.lowercase()}/directory"
                val canonical = AccountMetadata.canonicalDirectoryRequest(
                    accountId = user,
                    deviceId = activeProfile.deviceId,
                    signerPubHex = signerPubHex,
                    method = "GET",
                    path = path,
                    requestId = requestId,
                    issuedAt = issuedAt,
                )
                val directory = server.accountDirectory(
                    user,
                    AccountDirectoryAuthorization(
                        deviceId = activeProfile.deviceId,
                        signerPubHex = signerPubHex,
                        requestId = requestId,
                        issuedAt = issuedAt,
                        signatureHex = HexUtil.encode(signer.sign(canonical)),
                    ),
                )
                directorySnapshot = directory
                val accountKey = AccountMetadata.deriveAccountProfileKey(umk)
                val directoryKey = AccountMetadata.deriveDeviceDirectoryKey(umk)
                val accountName = directory.accountProfile?.let { record ->
                    runCatching {
                        AccountMetadata.decrypt(
                            AccountMetadataCiphertext(record.nonceHex, record.ciphertextHex),
                            accountKey,
                            AccountMetadataCoordinates(user, AccountMetadataRecordType.ACCOUNT_PROFILE, record.revision, record.keyVersion),
                        )
                    }.getOrNull()
                }
                _accountDisplayName.value = accountName
                val selfProfiles = directory.selfProfiles.associateBy { it.deviceId }
                val managedProfiles = directory.managedProfiles.associateBy { it.deviceId }
                val grants = directory.grants.groupBy { it.deviceId }
                val devices = directory.devices.filter { it.revokedAt == null }.map { device ->
                    val managed = managedProfiles[device.deviceId]
                    val own = selfProfiles[device.deviceId]
                    val decrypted = if (managed != null) {
                        runCatching {
                            AccountMetadata.decrypt(
                                AccountMetadataCiphertext(managed.nonceHex, managed.ciphertextHex),
                                directoryKey,
                                AccountMetadataCoordinates(user, AccountMetadataRecordType.DEVICE_MANAGED_PROFILE, managed.revision, managed.keyVersion, device.deviceId),
                            )
                        }.getOrNull()
                    } else own?.let { record ->
                        runCatching {
                            AccountMetadata.decrypt(
                                AccountMetadataCiphertext(record.nonceHex, record.ciphertextHex),
                                directoryKey,
                                AccountMetadataCoordinates(user, AccountMetadataRecordType.DEVICE_SELF_PROFILE, record.revision, record.keyVersion, device.deviceId),
                            )
                        }.getOrNull()
                    }
                    val scopes = grants[device.deviceId].orEmpty().flatMap { it.scopes(kotlinx.serialization.json.Json) }.toSet()
                    DirectoryDevice(
                        deviceId = device.deviceId,
                        displayName = decrypted ?: "${platformDisplay(device.platformClass)} · Device ${device.supportCode}",
                        platformClass = device.platformClass,
                        supportCode = device.supportCode,
                        createdAt = device.createdAt,
                        lastSeenAt = device.lastSeenAt,
                        isCurrent = device.deviceId == activeProfile.deviceId,
                        isAdministrator = "admin" in scopes,
                        isRestricted = "view-directory" !in scopes,
                        isManaged = managed != null,
                        isLocked = managed?.locked == true,
                    )
                }.sortedBy { it.createdAt }
                _state.value = State.Loaded(devices)
                cacheNames(accountName ?: user, devices.firstOrNull { it.isCurrent }?.displayName)
            } catch (t: Throwable) {
                _state.value = State.Failed(t.message ?: "Couldn't load trusted devices")
            }
            loadPendingRePair()
        }
    }

    /** M4 — read the pending re-pair snapshot. Best-effort: a network /
     *  decode failure (or an older Worker, surfaced as `unavailable`) just
     *  leaves the banner hidden rather than erroring the section. Mirrors
     *  the webapp's try/catch-to-null + iOS `loadPendingRePair`. */
    suspend fun loadPendingRePair() {
        val user = username()
        if (user.isNullOrEmpty()) {
            _pendingRePair.value = null
            return
        }
        _pendingRePair.value = try {
            server.fetchPendingRePair(user)
        } catch (_: Throwable) {
            null
        }
    }

    suspend fun disconnect(device: DirectoryDevice): Boolean {
        val user = username() ?: return false
        if (device.isCurrent) return false
        val path = "/api/accounts/${user.lowercase()}/devices/${device.deviceId}"
        return runCatching {
            val context = directoryContext("DELETE", path)
            server.revokeAccountDevice(user, device.deviceId, context.authorization)
            load()
            true
        }.getOrDefault(false)
    }

    suspend fun renameAccount(displayName: String): Boolean {
        val user = username() ?: return false
        val snapshot = directorySnapshot ?: return false
        val expected = snapshot.accountProfile?.revision ?: 0
        val revision = expected + 1
        val path = "/api/accounts/${user.lowercase()}/profile"
        return runCatching {
            val context = directoryContext("PUT", path)
            val admin = Keystore.adminRootKey("Rename this account")
            val signerPub = requireNotNull(Keystore.adminRootPubHex())
            val ciphertext = AccountMetadata.encrypt(
                displayName,
                AccountMetadata.deriveAccountProfileKey(context.umk),
                AccountMetadataCoordinates(user, AccountMetadataRecordType.ACCOUNT_PROFILE, revision, 1),
            )
            val issuedAt = now()
            val signature = admin.sign(AccountMetadata.canonicalAccountProfile(
                user, revision, 1, ciphertext, issuedAt, signerPub,
            ))
            server.putAccountProfile(
                user, context.authorization,
                DirectoryProfileWriteRequest(
                    DirectoryProfileEnvelope(
                        user, revision = revision, keyVersion = 1,
                        nonceHex = ciphertext.nonceHex, ciphertextHex = ciphertext.ciphertextHex,
                        issuedAt = issuedAt, signerPubHex = signerPub,
                        signatureHex = HexUtil.encode(signature),
                    ),
                    expected,
                ),
            )
            load()
            true
        }.getOrDefault(false)
    }

    suspend fun renameCurrentDevice(displayName: String): Boolean {
        val user = username() ?: return false
        val active = profile() ?: return false
        val snapshot = directorySnapshot ?: return false
        val expected = snapshot.selfProfiles.firstOrNull { it.deviceId == active.deviceId }?.revision ?: 0
        val revision = expected + 1
        val path = "/api/accounts/${user.lowercase()}/devices/${active.deviceId}/profile"
        return runCatching {
            val context = directoryContext("PUT", path)
            val signer = Keystore.accountDeviceSigner(context.umk, user, active.deviceId)
            val signerPub = HexUtil.encode(Keystore.accountDevicePublicKey(context.umk, user, active.deviceId))
            val ciphertext = AccountMetadata.encrypt(
                displayName,
                AccountMetadata.deriveDeviceDirectoryKey(context.umk),
                AccountMetadataCoordinates(user, AccountMetadataRecordType.DEVICE_SELF_PROFILE, revision, 1, active.deviceId),
            )
            val issuedAt = now()
            val signature = signer.sign(AccountMetadata.canonicalDeviceSelfProfile(
                user, active.deviceId, revision, 1, ciphertext, issuedAt, signerPub,
            ))
            server.putDeviceSelfProfile(
                user, active.deviceId, context.authorization,
                DirectoryProfileWriteRequest(
                    DirectoryProfileEnvelope(
                        user, active.deviceId, revision, 1,
                        ciphertext.nonceHex, ciphertext.ciphertextHex,
                        issuedAt, signerPub, HexUtil.encode(signature),
                    ),
                    expected,
                ),
            )
            load()
            true
        }.getOrDefault(false)
    }

    suspend fun setManagedName(deviceId: String, displayName: String, locked: Boolean): Boolean {
        val user = username() ?: return false
        val snapshot = directorySnapshot ?: return false
        val expected = snapshot.managedProfiles.firstOrNull { it.deviceId == deviceId }?.revision ?: 0
        val revision = expected + 1
        val path = "/api/accounts/${user.lowercase()}/devices/$deviceId/managed-profile"
        return runCatching {
            val context = directoryContext("PUT", path)
            val admin = Keystore.adminRootKey("Manage this device name")
            val signerPub = requireNotNull(Keystore.adminRootPubHex())
            val ciphertext = AccountMetadata.encrypt(
                displayName,
                AccountMetadata.deriveDeviceDirectoryKey(context.umk),
                AccountMetadataCoordinates(user, AccountMetadataRecordType.DEVICE_MANAGED_PROFILE, revision, 1, deviceId),
            )
            val issuedAt = now()
            val signature = admin.sign(AccountMetadata.canonicalDeviceManagedProfile(
                user, deviceId, revision, 1, ciphertext, locked, issuedAt, signerPub,
            ))
            server.putDeviceManagedProfile(
                user, deviceId, context.authorization,
                DirectoryManagedProfileWriteRequest(
                    DirectoryManagedProfileEnvelope(
                        user, deviceId, revision, 1,
                        ciphertext.nonceHex, ciphertext.ciphertextHex,
                        locked, issuedAt, signerPub, HexUtil.encode(signature),
                    ),
                    expected,
                ),
            )
            load()
            true
        }.getOrDefault(false)
    }

    suspend fun removeManagedName(deviceId: String): Boolean {
        val user = username() ?: return false
        val expected = directorySnapshot?.managedProfiles?.firstOrNull { it.deviceId == deviceId }?.revision ?: return false
        val path = "/api/accounts/${user.lowercase()}/devices/$deviceId/managed-profile"
        return runCatching {
            Keystore.adminRootKey("Remove the managed device name")
            val context = directoryContext("DELETE", path)
            server.deleteDeviceManagedProfile(user, deviceId, context.authorization, expected)
            load()
            true
        }.getOrDefault(false)
    }

    private data class DirectoryContext(val umk: ByteArray, val authorization: AccountDirectoryAuthorization)

    private suspend fun directoryContext(method: String, path: String): DirectoryContext {
        val user = requireNotNull(username())
        val active = requireNotNull(profile())
        val umk = Keystore.currentUmkSeed()
        val signer = Keystore.accountDeviceSigner(umk, user, active.deviceId)
        val signerPub = HexUtil.encode(Keystore.accountDevicePublicKey(umk, user, active.deviceId))
        val requestId = AccountMetadata.generateDeviceId()
        val issuedAt = now()
        val signature = signer.sign(AccountMetadata.canonicalDirectoryRequest(
            user, active.deviceId, signerPub, method, path, requestId, issuedAt,
        ))
        return DirectoryContext(umk, AccountDirectoryAuthorization(
            active.deviceId, signerPub, requestId, issuedAt, HexUtil.encode(signature),
        ))
    }

    private fun platformDisplay(value: String?): String = when (value) {
        "ios" -> "iPhone"
        "android" -> "Android"
        "web" -> "Web browser"
        "macos" -> "Mac"
        else -> "Device"
    }
}
