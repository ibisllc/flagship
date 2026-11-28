// "Change your account key" (docs/account-key-rotation.md): an admin device removes a device someone else may
// be able to unlock, and the account gets a new master key in the same step. Kept devices receive it sealed to
// their own keys; servers follow the admin-root-signed hop by themselves.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.R
import com.flagshipserver.app.api.AccountDirectoryResponse
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.AccountKeyRotation
import com.flagshipserver.app.core.AccountKeyRotationFlow
import com.flagshipserver.app.core.AccountMetadata
import com.flagshipserver.app.core.AdminRootRotation
import com.flagshipserver.app.core.AdminRootRotationClaim
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import com.flagshipserver.app.keystore.AccountKeyService
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.QuantumSafetyService
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.SecureRandom

class RotateAccountKeyViewModel(
    private val server: FlagshipServerClient,
    private val username: String,
    private val deviceId: String,
    private val deviceName: () -> String?,
    private val pods: () -> List<PodInfo>,
    private val clientFor: (PodInfo) -> ScreensClient?,
    private val keys: Keys = Keys.Device,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val rng: SecureRandom = SecureRandom(),
) : ViewModel() {

    /** The keys this flow reads and writes; the tests give it in-memory ones. */
    interface Keys {
        fun hasAdminRoot(): Boolean
        fun adminRootPubHex(): String?
        suspend fun unlock(reason: String)
        fun umk(): ByteArray
        fun adminRootSeed(): ByteArray?
        fun irkPubHex(): String?
        fun epoch(): Long
        fun stage(newUmk: ByteArray, newRoot: ByteArray?, body: String)
        fun clearStaged()
        fun strict(user: String): Boolean
        fun adminHybrid(user: String, rootSeed: ByteArray, rootPub: String): ((String, ByteArray) -> ByteArray)?
        suspend fun migrateOwnKey(server: FlagshipServerClient, user: String, deviceId: String, name: String?)
        suspend fun promote(server: FlagshipServerClient, user: String, deviceId: String, name: String?, r: AccountKeyRotation.Rotation)

        object Device : Keys {
            override fun hasAdminRoot() = Keystore.hasAdminRoot()
            override fun adminRootPubHex() = Keystore.adminRootPubHex()
            override suspend fun unlock(reason: String) = Keystore.ensureUnlocked(reason)
            override fun umk() = Keystore.currentUmkSeed()
            override fun adminRootSeed() = Keystore.adminRootSeed()
            override fun irkPubHex() = Keystore.irkPubHexIfKnown()
            override fun epoch() = Keystore.accountKeyEpoch()
            override fun stage(newUmk: ByteArray, newRoot: ByteArray?, body: String) = Keystore.stagePendingRotation(newUmk, newRoot, body)
            override fun clearStaged() = Keystore.clearPendingRotation()
            override fun strict(user: String) = QuantumSafetyService.anyStrict(user)
            override fun adminHybrid(user: String, rootSeed: ByteArray, rootPub: String) =
                QuantumSafetyService.rootSigner(user, "admin-root", Ed25519Sign(rootSeed), rootPub)
            override suspend fun migrateOwnKey(server: FlagshipServerClient, user: String, deviceId: String, name: String?) =
                AccountKeyService.migrateDeviceKey(server, user, deviceId, name)
            override suspend fun promote(server: FlagshipServerClient, user: String, deviceId: String, name: String?, r: AccountKeyRotation.Rotation) =
                AccountKeyService.promote(server, user, deviceId, name, r)
        }
    }

    data class Row(val name: String, val reason: String? = null, val addedAt: Long? = null)

    sealed interface Phase {
        data object Idle : Phase
        data object Checking : Phase
        data class Unavailable(val message: String) : Phase
        data class Summary(
            val removedName: String,
            val removedHeldAdminKey: Boolean,
            val kept: List<Row>,
            val excluded: List<Row>,
            val recoveryOn: Boolean,
        ) : Phase
        data object Rotating : Phase
        data class Done(val needsRecovery: Boolean) : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Idle)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    private var plan: AccountKeyRotationFlow.Plan? = null
    private var directory: AccountDirectoryResponse? = null
    private var strict = false
    private var recoveryOn = false

    private fun s(id: Int, vararg a: Any) = FSStrings.get(id, *a)

    /** Check the account can change its key now, and work out who keeps it. One unlock prompt. */
    suspend fun prepare(removedDeviceId: String) {
        _phase.value = Phase.Checking
        try {
            if (!keys.hasAdminRoot()) { _phase.value = Phase.Unavailable(s(R.string.akr_needs_admin_device)); return }
            keys.unlock(s(R.string.akr_change_account_key))
            val state = server.accountKeyState(username)
            val root = keys.adminRootPubHex()
            if (state.adminRootPubHex == null || state.adminRootPubHex != root || state.irkPubHex != keys.irkPubHex()?.lowercase()) {
                _phase.value = Phase.Unavailable(s(R.string.akr_failed_nothing_changed)); return
            }
            val behind = pods().filter { it.pendingAuthCodeSerial == null }.filter { pod ->
                val status = runCatching { clientFor(pod)?.accountKeyStatus()?.status }.getOrNull()
                status?.capability != AccountKeyRotationFlow.CAPABILITY
            }
            if (behind.isNotEmpty()) {
                _phase.value = Phase.Unavailable(s(R.string.akr_update_servers_first, behind.joinToString(", ") { it.name })); return
            }
            keys.migrateOwnKey(server, username, deviceId, deviceName())
            val dir = loadDirectory()
            val umk = keys.umk()
            try {
                strict = keys.strict(username)
                val names = AccountDeviceNames.names(dir, username, umk)
                val devices = AccountKeyRotationFlow.devices(dir, username, { d -> names[d.deviceId] ?: d.supportCode }, now())
                val p = AccountKeyRotationFlow.plan(devices, deviceId, removedDeviceId, umk, username, strict)
                recoveryOn = runCatching { server.hasCloudRecovery(username) }.getOrDefault(false)
                plan = p
                directory = dir
                _phase.value = Phase.Summary(
                    removedName = p.removed.displayName,
                    removedHeldAdminKey = p.removedHeldAdminKey,
                    kept = p.kept.map { Row(it.displayName, addedAt = it.createdAt) },
                    excluded = p.excluded.map {
                        Row(it.device.displayName, when (it.reason) {
                            AccountKeyRotationFlow.ExcludeReason.DERIVED_KEY -> s(R.string.akr_excluded_derived, it.device.displayName)
                            AccountKeyRotationFlow.ExcludeReason.NO_RECEIVE_KEY -> s(R.string.akr_excluded_no_receive_key, it.device.displayName)
                        })
                    },
                    recoveryOn = recoveryOn,
                )
            } finally {
                umk.fill(0)
            }
        } catch (e: AccountKeyRotationFlow.PlanException) {
            _phase.value = Phase.Unavailable(s(R.string.akr_failed_nothing_changed))
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (t: Throwable) {
            _phase.value = Phase.Failed(com.flagshipserver.app.core.UserErrorText.of(t, s(R.string.akr_failed_nothing_changed)))
        }
    }

    private suspend fun loadDirectory(): AccountDirectoryResponse {
        val auth = AccountKeyService.deviceAuth(username, deviceId, "GET", "/api/accounts/${username.lowercase()}/directory")
            ?: error("no device key")
        return server.accountDirectory(username, auth)
    }

    /** Build, stage and send the hop; promote the new key once `.com` applied it. */
    suspend fun confirm() {
        val p = plan ?: return
        val dir = directory ?: return
        _phase.value = Phase.Rotating
        val oldUmk = keys.umk()
        val rootSeed = keys.adminRootSeed() ?: run { _phase.value = Phase.Failed(s(R.string.akr_needs_admin_device)); return }
        val rootPub = PqHex.encode(PqHybrid.ed25519PublicKey(rootSeed))
        val newUmk = ByteArray(32).also(rng::nextBytes)
        var newRoot: ByteArray? = null
        var rotationDraft: QuantumSafetyService.RotationDraft? = null
        val issuedAt = now()
        try {
            val authority = if (p.removedHeldAdminKey) {
                val seed = ByteArray(32).also(rng::nextBytes).also { newRoot = it }
                val newPub = PqHex.encode(PqHybrid.ed25519PublicKey(seed))
                val ar = AdminRootRotation(username.lowercase(), rootPub, newPub, issuedAt)
                val sig = HexUtil.encode(AdminRootRotationClaim.sign(ar, Ed25519Sign(rootSeed)))
                rotationDraft = runCatching { QuantumSafetyService.rotationCompanion(ar, Ed25519Sign(rootSeed), seed) }.getOrNull()
                val draft = rotationDraft
                AccountKeyRotationFlow.Authority(
                    signer = AccountKeyRotation.seedSigner(seed),
                    pubHex = newPub,
                    newRootSeed = seed,
                    rotationBody = buildJsonObject {
                        put("rotation", buildJsonObject {
                            put("username", ar.username); put("oldAdminRootPub", ar.oldAdminRootPub); put("newAdminRootPub", ar.newAdminRootPub); put("issuedAt", ar.issuedAt)
                        })
                        put("signatureHex", sig)
                        draft?.let { put("pq", it.companion) }
                    },
                    hybrid = draft?.let { d ->
                        { purpose: String, payload: ByteArray ->
                            PqHybrid.hybridSignSplit(PqHybrid.ed25519PublicKey(seed), { m -> PqHybrid.ed25519Sign(seed, m) }, d.newMldsaSeed, purpose, payload)
                        }
                    },
                )
            } else {
                AccountKeyRotationFlow.Authority(
                    signer = AccountKeyRotation.seedSigner(rootSeed),
                    pubHex = rootPub,
                    hybrid = keys.adminHybrid(username, rootSeed, rootPub),
                )
            }
            val irkMl = if (authority.hybrid != null) ByteArray(32).also(rng::nextBytes) else null
            val built = AccountKeyRotationFlow.build(AccountKeyRotationFlow.Inputs(
                username = username, fromEpoch = keys.epoch(), oldIrkPubHex = requireNotNull(keys.irkPubHex()),
                oldUmk = oldUmk, newUmk = newUmk, scheme = AccountKeyRotation.IrkScheme.ANDROID, plan = p, authority = authority,
                strict = strict, directory = dir, issuedAt = issuedAt, newIrkMldsaSeed = irkMl,
            ))
            keys.stage(newUmk, newRoot, built.body.toString())
            try {
                server.applyAccountKeyRotation(username, built.body)
            } catch (e: HttpException) {
                if (e.status == 409) {
                    val state = server.accountKeyState(username)
                    if (AccountKeyRotationFlow.decidePending(built.rotation, state.irkPubHex, now()) != AccountKeyRotationFlow.PendingAction.PROMOTE) {
                        keys.clearStaged()
                        _phase.value = Phase.Failed(s(R.string.akr_conflict))
                        return
                    }
                } else {
                    if (e.status in 400..499) keys.clearStaged()
                    _phase.value = Phase.Failed(s(R.string.akr_failed_nothing_changed))
                    return
                }
            }
            keys.promote(server, username, deviceId, deviceName(), built.rotation)
            rotationDraft?.let { QuantumSafetyService.keepRotatedRootSeed(username, authority.pubHex, it) }
            irkMl?.let { ml ->
                runCatching { QuantumSafetyService.pqKeys?.importSeed("account-irk", username.lowercase(), built.rotation.newIrkPubHex, ml, now()) }
                ml.fill(0)
            }
            _phase.value = Phase.Done(needsRecovery = recoveryOn)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: AccountKeyRotationFlow.PlanException) {
            keys.clearStaged()
            _phase.value = Phase.Failed(s(R.string.akr_failed_nothing_changed))
        } catch (t: Throwable) {
            // A network failure after staging: `.com` may have applied it; the next start finds out and promotes.
            _phase.value = Phase.Failed(s(R.string.akr_failed_nothing_changed))
        } finally {
            oldUmk.fill(0); rootSeed.fill(0); newUmk.fill(0)
        }
    }

    // ── Progress after a rotation ──────────────────────────────────────

    data class Progress(
        val devicesUpdated: Int,
        val devicesTotal: Int,
        val serversOnNewKey: Int,
        val serversTotal: Int,
        val waitingFor: List<String>,
        val rekeyDue: List<Pair<String, List<String>>>,
    ) {
        val complete: Boolean get() = devicesUpdated >= devicesTotal && serversOnNewKey >= serversTotal
    }

    private val _progress = MutableStateFlow<Progress?>(null)
    val progress: StateFlow<Progress?> = _progress.asStateFlow()

    /** Devices x/y (a kept device is updated once its name is back in the directory: `.com` dropped every
     *  device's own name at the hop, and each one re-publishes it under the new key); servers x/y. */
    suspend fun refreshProgress() {
        _progress.value = runCatching {
            val laneBody = server.accountKeyLane(username)
            val epoch = (laneBody["keyEpoch"] as? JsonPrimitive)?.content?.toLongOrNull() ?: 0L
            if (epoch == 0L) return@runCatching null
            val lastHop = (laneBody["lane"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
                .lastOrNull { (it["kind"] as? JsonPrimitive)?.content == "account-key-rotation" } ?: return@runCatching null
            val kept = (lastHop["kept"] as? JsonArray).orEmpty().mapNotNull { ((it as? JsonObject)?.get("deviceId") as? JsonPrimitive)?.content }
            val dir = loadDirectory()
            progressOf(kept, dir, epoch, pods().filter { it.pendingAuthCodeSerial == null }.map { pod ->
                pod.name to runCatching { clientFor(pod)?.accountKeyStatus()?.status }.getOrNull()
            })
        }.getOrNull()
    }

    companion object {
        fun progressOf(
            kept: List<String>,
            dir: AccountDirectoryResponse,
            epoch: Long,
            servers: List<Pair<String, com.flagshipserver.app.api.AccountKeyBoxStatus?>>,
        ): Progress {
            val withName = dir.selfProfiles.map { it.deviceId.lowercase() }.toSet()
            val onNew = servers.filter { (it.second?.trustedEpoch ?: -1) >= epoch }
            return Progress(
                devicesUpdated = kept.count { it.lowercase() in withName },
                devicesTotal = kept.size,
                serversOnNewKey = onNew.size,
                serversTotal = servers.size,
                waitingFor = servers.filter { it !in onNew }.map { it.first },
                rekeyDue = servers.mapNotNull { (name, st) -> st?.rekeyDue?.takeIf { it.isNotEmpty() }?.let { name to it } },
            )
        }
    }
}
