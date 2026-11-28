// The account-key work this phone does by itself (docs/account-key-rotation.md):
//   - a kept device notices that `.com` serves another account key, replays the lane from the admin root it
//     pinned, opens its delivery and installs the new account key (the old one kept, retired, for old backups);
//   - a rotator that crashed after staging its hop promotes it (or sends it again, or drops it) on its next start;
//   - every device publishes an X-Wing receive key, so a new account key reaches it sealed post-quantum;
//   - an admin device whose account device key was derived from the UMK replaces it with a random one.
// None of it prompts: it runs when the session is already unlocked, or waits for the next unlock.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.api.AccountDirectoryAuthorization
import com.flagshipserver.app.api.DirectoryProfileEnvelope
import com.flagshipserver.app.api.DirectoryProfileWriteRequest
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.core.AccountKeyRotation
import com.flagshipserver.app.core.AccountKeyRotationFlow
import com.flagshipserver.app.core.AccountMetadata
import com.flagshipserver.app.core.AccountMetadataCoordinates
import com.flagshipserver.app.core.AccountMetadataRecordType
import com.flagshipserver.app.core.ErrorLog
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

object AccountKeyService {
    /** What the kept-device banner shows. */
    sealed interface Status {
        data object Idle : Status
        /** `.com` holds a newer account key; this device opens it at the next unlock. */
        data object Waiting : Status
        data object Done : Status
        data object Failed : Status
    }

    private val _status = MutableStateFlow<Status>(Status.Idle)
    val status: StateFlow<Status> = _status.asStateFlow()
    private val mutex = Mutex()

    /** The push `.com` sends kept devices after a rotation (content-free; this device asks `.com` itself). */
    const val PUSH_CATEGORY = "account-key-rotated"

    /** Runs [onUnlockOrWake] for the signed-in account; set by MainActivity, null on a mock run. */
    @Volatile var wake: (suspend () -> Unit)? = null

    fun matchesPush(data: Map<String, String>): Boolean = data["category"] == PUSH_CATEGORY || data["kind"] == PUSH_CATEGORY

    /** Ask in the background; true when a check was started. */
    fun request(scope: kotlinx.coroutines.CoroutineScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO)): Boolean {
        val w = wake ?: return false
        scope.launch { runCatching { w() } }
        return true
    }

    fun dismiss() { if (_status.value == Status.Done) _status.value = Status.Idle }

    /** For tests and the gym: show a state without a network. */
    internal fun setStatusForTest(s: Status) { _status.value = s }

    private fun irkScheme(s: AccountKeyRotation.IrkScheme) = when (s) {
        AccountKeyRotation.IrkScheme.WEB -> IrkLineage.Scheme.WEB
        AccountKeyRotation.IrkScheme.IOS -> IrkLineage.Scheme.IOS
        AccountKeyRotation.IrkScheme.ANDROID -> IrkLineage.Scheme.ANDROID
    }

    /** A directory request signed by this device's account device key (stored; never prompts). */
    fun deviceAuth(user: String, deviceId: String, method: String, path: String, now: Long = System.currentTimeMillis()): AccountDirectoryAuthorization? {
        val key = runCatching { Keystore.sessionAccountDeviceKey(user, deviceId) }.getOrNull() ?: return null
        val requestId = AccountMetadata.generateDeviceId()
        val sig = key.signer.sign(AccountMetadata.canonicalDirectoryRequest(user.lowercase(), deviceId, key.pubHex, method, path, requestId, now))
        return AccountDirectoryAuthorization(deviceId, key.pubHex, requestId, now, HexUtil.encode(sig))
    }

    /**
     * Everything an unlock (or a foreground, or an `account-key-rotated` push) checks, in order. Never prompts;
     * each step that needs the open session waits for the next one.
     */
    suspend fun onUnlockOrWake(server: FlagshipServerClient, user: String?, deviceId: String?, deviceName: String?) {
        if (user.isNullOrEmpty() || deviceId.isNullOrEmpty() || !Regex("^[0-9a-f]{32}$").matches(deviceId)) return
        mutex.withLock {
            runCatching { resumePending(server, user, deviceId, deviceName) }.onFailure { ErrorLog.step("account-key", "resume: ${it.javaClass.simpleName}") }
            runCatching { receive(server, user, deviceId, deviceName) }.onFailure { ErrorLog.step("account-key", "receive: ${it.javaClass.simpleName}") }
            runCatching { migrateDeviceKey(server, user, deviceId, deviceName) }.onFailure { ErrorLog.step("account-key", "device key: ${it.javaClass.simpleName}") }
            runCatching { publishReceiveKey(server, user, deviceId) }.onFailure { ErrorLog.step("account-key", "receive key: ${it.javaClass.simpleName}") }
        }
    }

    // ── The kept device ─────────────────────────────────────────────────

    suspend fun receive(server: FlagshipServerClient, user: String, deviceId: String, deviceName: String?) {
        if (Keystore.pendingRotationBody() != null) return
        val state = server.accountKeyState(user)
        val localIrk = Keystore.irkPubHexIfKnown() ?: return
        if (state.irkPubHex == localIrk.lowercase()) {
            if (state.keyEpoch != Keystore.accountKeyEpoch()) Keystore.setAccountKeyEpoch(state.keyEpoch)
            if (_status.value == Status.Waiting) _status.value = Status.Idle
            return
        }
        _status.value = Status.Waiting
        val umk = Keystore.umkSeedIfOpen() ?: return
        try {
            // The root this device pinned from its own SAS-checked join (or holds itself); never `.com`'s word.
            val pin = Keystore.adminRootPin() ?: run { _status.value = Status.Failed; return }
            val path = "/api/accounts/${user.lowercase()}/devices/$deviceId/umk-rotation"
            val auth = deviceAuth(user, deviceId, "GET", path) ?: return
            val body = server.umkRotationDeliveries(user, deviceId, auth)
            val self = Keystore.sessionAccountDeviceKey(user, deviceId) ?: return
            val local = AccountKeyRotationFlow.Local(
                user, Keystore.accountKeyEpoch(), localIrk, PqHex.encode(PqHybrid.ed25519PublicKey(AccountKeyRotation.aidSeed(umk))), pin,
            )
            val replay = AccountKeyRotationFlow.replay(body["lane"] as? JsonArray ?: JsonArray(emptyList()), local)
            val deliveries = AccountKeyRotationFlow.parseDeliveries(body).associateBy { it.toEpoch }
            var installed = false
            for (hop in replay.hops) {
                val d = deliveries[hop.rotation.toEpoch] ?: break
                val secret = when (d.kind) {
                    AccountKeyRotation.SealKind.XWING -> Keystore.receiveKeySeed()
                    AccountKeyRotation.SealKind.ED25519 -> Keystore.storedAccountDeviceSeed(deviceId)
                } ?: break
                val plain = try {
                    AccountKeyRotationFlow.open(hop, d, AccountKeyRotation.KeptDevice(deviceId, self.pubHex), secret)
                } finally {
                    if (d.kind == AccountKeyRotation.SealKind.XWING) secret.fill(0)
                }
                Keystore.installRotatedUmk(plain.umk, irkScheme(plain.irkScheme), hop.rotation.toEpoch)
                plain.adminRootSeed?.let { seed ->
                    if (PqHex.encode(PqHybrid.ed25519PublicKey(seed)) == hop.rotation.adminRootPubHex) Keystore.importAdminRoot(seed)
                }
                Keystore.setAdminRootPin(hop.rotation.adminRootPubHex)
                plain.umk.fill(0)
                installed = true
                deviceAuth(user, deviceId, "POST", "$path/ack")?.let { a -> runCatching { server.ackUmkRotation(user, deviceId, a, hop.rotation.toEpoch) } }
            }
            if (replay.adminRoot != pin && !installed) Keystore.setAdminRootPin(replay.adminRoot)
            val now = server.accountKeyState(user)
            if (now.irkPubHex == Keystore.irkPubHexIfKnown()?.lowercase()) {
                afterNewAccountKey(server, user, deviceId, deviceName)
                _status.value = Status.Done
            } else {
                _status.value = Status.Failed
            }
        } catch (e: HttpException) {
            // A removed device hears `403 device-removed` and the account-gone path takes over.
            if (e.status != 403) _status.value = Status.Failed
        } catch (e: AccountKeyRotation.Failure) {
            _status.value = Status.Failed
        } finally {
            umk.fill(0)
        }
    }

    /** What a device does once it holds the new account key: tokens and delegates the old key signed go, its own
     *  name goes back into the directory under the new key, its identities get their PQ bindings again. */
    suspend fun afterNewAccountKey(server: FlagshipServerClient, user: String, deviceId: String, deviceName: String?) {
        runCatching { com.flagshipserver.app.core.AccountReadTokens.shared?.clear() }
        runCatching { Keystore.clearWatchDelegate() }
        deviceName?.let { runCatching { publishSelfProfile(server, user, deviceId, it) } }
        runCatching { PqIdentityUpgrade.trigger() }
    }

    /** This device's name, encrypted under the current account key and signed by its device key. */
    suspend fun publishSelfProfile(server: FlagshipServerClient, user: String, deviceId: String, name: String) {
        val u = user.lowercase()
        val key = Keystore.sessionAccountDeviceKey(u, deviceId) ?: return
        val umk = Keystore.umkSeedIfOpen() ?: return
        try {
            val dirPath = "/api/accounts/$u/directory"
            val directory = server.accountDirectory(u, deviceAuth(u, deviceId, "GET", dirPath) ?: return)
            val expected = directory.selfProfiles.firstOrNull { it.deviceId == deviceId }?.revision ?: 0
            val revision = expected + 1
            val c = AccountMetadata.encrypt(name, AccountMetadata.deriveDeviceDirectoryKey(umk),
                AccountMetadataCoordinates(u, AccountMetadataRecordType.DEVICE_SELF_PROFILE, revision, 1, deviceId))
            val issuedAt = System.currentTimeMillis()
            val sig = key.signer.sign(AccountMetadata.canonicalDeviceSelfProfile(u, deviceId, revision, 1, c, issuedAt, key.pubHex))
            val path = "/api/accounts/$u/devices/$deviceId/profile"
            server.putDeviceSelfProfile(u, deviceId, deviceAuth(u, deviceId, "PUT", path) ?: return, DirectoryProfileWriteRequest(
                DirectoryProfileEnvelope(u, deviceId, revision, 1, c.nonceHex, c.ciphertextHex, issuedAt, key.pubHex, HexUtil.encode(sig)), expected,
            ))
        } finally {
            umk.fill(0)
        }
    }

    // ── The rotator after a crash ───────────────────────────────────────

    suspend fun resumePending(server: FlagshipServerClient, user: String, deviceId: String, deviceName: String?) {
        val bodyText = Keystore.pendingRotationBody() ?: return
        val body = kotlinx.serialization.json.Json.parseToJsonElement(bodyText) as? JsonObject ?: run { Keystore.clearPendingRotation(); return }
        val r = AccountKeyRotationFlow.parseRotation(body["rotation"]) ?: run { Keystore.clearPendingRotation(); return }
        if (r.username != user.lowercase()) return
        val state = server.accountKeyState(user)
        when (AccountKeyRotationFlow.decidePending(r, state.irkPubHex, System.currentTimeMillis())) {
            AccountKeyRotationFlow.PendingAction.PROMOTE -> promote(server, user, deviceId, deviceName, r)
            AccountKeyRotationFlow.PendingAction.RETRY -> {
                try {
                    server.applyAccountKeyRotation(user, body)
                    promote(server, user, deviceId, deviceName, r)
                } catch (e: HttpException) {
                    if (e.status in 400..499) Keystore.clearPendingRotation()
                }
            }
            AccountKeyRotationFlow.PendingAction.DROP -> Keystore.clearPendingRotation()
        }
    }

    /** `.com` applied the staged hop: its UMK (and admin root, when it changed) become this device's. Throws while
     *  the session is locked (the next unlock promotes it). */
    suspend fun promote(server: FlagshipServerClient, user: String, deviceId: String, deviceName: String?, r: AccountKeyRotation.Rotation) {
        val umk = Keystore.pendingRotationUmk() ?: error("pending account key unreadable")
        val root = Keystore.pendingRotationAdminRoot()
        Keystore.installRotatedUmk(umk, irkScheme(AccountKeyRotationFlow.scheme(r)), r.toEpoch)
        root?.let { Keystore.importAdminRoot(it) }
        Keystore.setAdminRootPin(r.adminRootPubHex)
        Keystore.clearPendingRotation()
        umk.fill(0); root?.fill(0)
        afterNewAccountKey(server, user, deviceId, deviceName)
    }

    // ── Receive key (Phase 0) ───────────────────────────────────────────

    suspend fun publishReceiveKey(server: FlagshipServerClient, user: String, deviceId: String) {
        val pub = Keystore.ensureReceiveKey() ?: return
        val key = Keystore.sessionAccountDeviceKey(user, deviceId) ?: return
        if (Keystore.receiveKeyPublishedFor() == key.pubHex) return
        val u = user.lowercase()
        val issuedAt = System.currentTimeMillis()
        val sig = key.signer.sign(AccountKeyRotation.canonicalDeviceReceiveKey(u, deviceId, key.pubHex, pub, issuedAt))
        val path = "/api/accounts/$u/devices/$deviceId/receive-key"
        val auth = deviceAuth(u, deviceId, "PUT", path) ?: return
        server.putDeviceReceiveKey(u, deviceId, auth, buildJsonObject {
            put("receiveKey", buildJsonObject {
                put("username", u); put("deviceId", deviceId); put("devicePubHex", key.pubHex); put("xwingPubHex", pub); put("issuedAt", issuedAt)
            })
            put("signatureHex", HexUtil.encode(sig))
        })
        Keystore.setReceiveKeyPublishedFor(key.pubHex)
    }

    // ── Derived device key → random (Phase 0) ───────────────────────────

    /**
     * An admin device whose account device key is HKDF(UMK) replaces it: the admin root authorises the new random
     * key and signs its grant (same scopes). A device without the admin root cannot (see the doc); it is left as
     * it is and a rotation asks for it to be added again.
     */
    suspend fun migrateDeviceKey(server: FlagshipServerClient, user: String, deviceId: String, deviceName: String?) {
        if (Keystore.accountDeviceKeyIsRandom()) return
        val u = user.lowercase()
        val umk = Keystore.umkSeedIfOpen() ?: return
        try {
            val current = Keystore.sessionAccountDeviceKey(u, deviceId) ?: return
            if (!AccountKeyRotation.deviceKeyIsUmkDerived(umk, u, deviceId, current.pubHex)) { Keystore.markAccountDeviceKeyRandom(); return }
            if (!Keystore.hasAdminRoot()) return
            val rootSeed = runCatching { Keystore.adminRootSeed() }.getOrNull() ?: return
            val rootPub = PqHex.encode(PqHybrid.ed25519PublicKey(rootSeed))
            val directory = server.accountDirectory(u, deviceAuth(u, deviceId, "GET", "/api/accounts/$u/directory") ?: return)
            val body = deviceKeyRotateBody(u, deviceId, current.pubHex, directory, rootSeed, System.currentTimeMillis())
            rootSeed.fill(0)
            server.rotateDeviceKey(u, deviceId, body.body)
            Keystore.replaceAccountDeviceSeed(deviceId, body.newSeed)
            Keystore.setReceiveKeyPublishedFor(null)
            ErrorLog.step("account-key", "device key replaced by a random one (root ${rootPub.take(8)})")
            deviceName?.let { runCatching { publishSelfProfile(server, u, deviceId, it) } }
            runCatching { PqIdentityUpgrade.trigger() }
        } finally {
            umk.fill(0)
        }
    }

    class DeviceKeyRotateBody(val body: JsonObject, val newSeed: ByteArray, val newPubHex: String)

    /** `flagship/device-key-rotate/v1` for a new random key, with its grant: the device's live scopes, admin root. */
    fun deviceKeyRotateBody(
        u: String, deviceId: String, oldPubHex: String, directory: com.flagshipserver.app.api.AccountDirectoryResponse,
        rootSeed: ByteArray, now: Long, newSeed: ByteArray = ByteArray(32).also(java.security.SecureRandom()::nextBytes),
    ): DeviceKeyRotateBody {
        val newPub = PqHex.encode(PqHybrid.ed25519PublicKey(newSeed))
        val msg = AccountKeyRotation.canonicalDeviceKeyRotate(u, deviceId, oldPubHex, newPub, now)
        val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
        val scopes = directory.grants.filter { it.revokedAt == null && it.deviceId.lowercase() == deviceId && it.expiresAt > now }
            .flatMap { it.scopes(json) }.distinct().ifEmpty { listOf("view-directory") }
        val grantId = java.util.UUID.randomUUID().toString().lowercase()
        val expiresAt = now + 90L * 24 * 3_600_000
        val grantBytes = com.flagshipserver.app.core.DeviceCapabilityGrant.canonicalBytes(grantId, u, deviceId, newPub, scopes, now, expiresAt)
        val root = Ed25519Sign(rootSeed)
        val body = buildJsonObject {
            put("rotate", buildJsonObject {
                put("username", u); put("deviceId", deviceId); put("oldDevicePubHex", oldPubHex); put("newDevicePubHex", newPub); put("issuedAt", now)
            })
            put("newKeySignatureHex", HexUtil.encode(Ed25519Sign(newSeed).sign(msg)))
            put("adminRootSignatureHex", HexUtil.encode(root.sign(msg)))
            put("grant", buildJsonObject {
                put("grant", buildJsonObject {
                    put("grantId", grantId); put("username", u); put("deviceId", deviceId); put("devicePubKey", newPub)
                    put("scopes", JsonArray(scopes.map { kotlinx.serialization.json.JsonPrimitive(it) })); put("issuedAt", now); put("expiresAt", expiresAt)
                })
                put("signature", HexUtil.encode(root.sign(grantBytes)))
                put("signerRoot", "admin-root")
            })
        }
        return DeviceKeyRotateBody(body, newSeed, newPub)
    }
}
