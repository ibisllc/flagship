// Account master-key rotation on the phone (docs/account-key-rotation.md): which devices keep the account,
// the request an admin device sends `.com`, the lane a kept device replays from the admin root it pinned, and
// what a rotator with a staged hop does on its next start. Pure functions over the protocol port
// (AccountKeyRotation.kt), so the JVM tests drive them with real keys.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AccountDirectoryDevice
import com.flagshipserver.app.api.AccountDirectoryGrant
import com.flagshipserver.app.api.AccountDirectoryReceiveKey
import com.flagshipserver.app.api.AccountDirectoryResponse
import com.flagshipserver.app.core.AccountKeyRotation.KeptDevice
import com.flagshipserver.app.core.AccountKeyRotation.Rotation
import com.flagshipserver.app.core.AccountKeyRotation.Signatures
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.SecureRandom

object AccountKeyRotationFlow {
    /** What a box reports at GET /api/screens/account-key/status when it can follow a rotation. */
    const val CAPABILITY = "account-key-rotation/v1"
    /** A staged hop that `.com` never saw is sent again only while `.com` would still take it. */
    const val RETRY_WINDOW_MS = 15 * 60_000L
    private const val GRANT_TTL_MS = 90L * 24 * 3_600_000
    private val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }

    enum class ExcludeReason { DERIVED_KEY, NO_RECEIVE_KEY }

    data class Device(
        val deviceId: String,
        val devicePubHex: String,
        val displayName: String,
        val platformClass: String?,
        val createdAt: Long,
        /** The device's live grants. */
        val grants: List<AccountDirectoryGrant>,
        /** Its receive key, only when the signature by its own key verifies. */
        val receiveKey: AccountDirectoryReceiveKey?,
    ) {
        val isAdministrator: Boolean get() = grants.any { "admin" in it.scopes(json) }
    }

    data class Excluded(val device: Device, val reason: ExcludeReason)

    data class Plan(
        val self: Device,
        val removed: Device,
        val kept: List<Device>,
        val excluded: List<Excluded>,
    ) {
        /** The removed device may hold the admin root (an admin's grant): the root changes first. */
        val removedHeldAdminKey: Boolean get() = removed.isAdministrator
        val keptDevices: List<KeptDevice> get() = kept.map { KeptDevice(it.deviceId, it.devicePubHex) }
    }

    class PlanException(val code: String) : Exception(code)

    /** The account's active devices, with their live grants and verified receive keys. */
    fun devices(directory: AccountDirectoryResponse, username: String, name: (AccountDirectoryDevice) -> String, now: Long): List<Device> {
        val u = username.lowercase()
        val grants = directory.grants.filter { it.revokedAt == null && it.expiresAt > now }.groupBy { it.deviceId.lowercase() }
        val receive = directory.receiveKeys.associateBy { it.deviceId.lowercase() }
        return directory.devices.filter { it.revokedAt == null }.map { d ->
            val id = d.deviceId.lowercase()
            val pub = d.devicePubHex.lowercase()
            val rk = receive[id]?.takeIf { k ->
                k.devicePubHex.lowercase() == pub &&
                    AccountKeyRotation.verifyDeviceReceiveKey(u, id, pub, k.xwingPubHex.lowercase(), k.issuedAt, k.signatureHex.lowercase())
            }
            Device(id, pub, name(d), d.platformClass, d.createdAt, grants[id].orEmpty(), rk)
        }.sortedBy { it.createdAt }
    }

    /**
     * Which devices keep the account. The removed one goes; a device whose key comes from the old UMK goes (whoever
     * holds the old UMK can sign as it); under strict a device without a receive key goes (it can only be reached
     * with a classical seal). This device stays and must hold a random key.
     */
    fun plan(devices: List<Device>, selfId: String, removedId: String, oldUmk: ByteArray, username: String, strict: Boolean): Plan {
        val self = devices.firstOrNull { it.deviceId == selfId.lowercase() } ?: throw PlanException("self-not-active")
        val removed = devices.firstOrNull { it.deviceId == removedId.lowercase() } ?: throw PlanException("removed-not-active")
        if (self.deviceId == removed.deviceId) throw PlanException("removing-self")
        if (AccountKeyRotation.deviceKeyIsUmkDerived(oldUmk, username, self.deviceId, self.devicePubHex)) throw PlanException("self-derived")
        val kept = mutableListOf(self)
        val excluded = mutableListOf<Excluded>()
        for (d in devices) {
            if (d.deviceId == self.deviceId || d.deviceId == removed.deviceId) continue
            when {
                AccountKeyRotation.deviceKeyIsUmkDerived(oldUmk, username, d.deviceId, d.devicePubHex) -> excluded += Excluded(d, ExcludeReason.DERIVED_KEY)
                strict && d.receiveKey == null -> excluded += Excluded(d, ExcludeReason.NO_RECEIVE_KEY)
                else -> kept += d
            }
        }
        return Plan(self, removed, kept.sortedBy { it.createdAt }, excluded)
    }

    /** The admin root that signs the hop: the current one, or (when the removed device may hold it) a new one. */
    class Authority(
        val signer: (ByteArray) -> ByteArray,
        val pubHex: String,
        /** The new root's seed for kept admin devices, when the root changes in this request. */
        val newRootSeed: ByteArray? = null,
        /** The `adminRootRotation` field (`{ rotation, signatureHex, pq? }`), when the root changes. */
        val rotationBody: JsonObject? = null,
        /** The root's hybrid signer (purpose, payload), for the companion; null without a PQ half. */
        val hybrid: ((String, ByteArray) -> ByteArray)? = null,
    )

    class Inputs(
        val username: String,
        val fromEpoch: Long,
        val oldIrkPubHex: String,
        val oldUmk: ByteArray,
        val newUmk: ByteArray,
        val scheme: AccountKeyRotation.IrkScheme,
        val plan: Plan,
        val authority: Authority,
        val strict: Boolean,
        val directory: AccountDirectoryResponse,
        val issuedAt: Long,
        val nonceHex: String = PqHex.encode(ByteArray(16).also(SecureRandom()::nextBytes)),
        /** A fresh ML-DSA seed for the new IRK's binding; null sends no companion. */
        val newIrkMldsaSeed: ByteArray? = null,
        val grantId: () -> String = { java.util.UUID.randomUUID().toString().lowercase() },
    )

    class Built(val body: JsonObject, val rotation: Rotation, val signatures: Signatures, val digestHex: String)

    fun build(i: Inputs): Built {
        val u = i.username.lowercase()
        val newIrkSeed = AccountKeyRotation.irkSeed(i.newUmk, i.scheme)
        val newAidSeed = AccountKeyRotation.aidSeed(i.newUmk)
        val oldAidPub = PqHex.encode(PqHybrid.ed25519PublicKey(AccountKeyRotation.aidSeed(i.oldUmk)))
        val rotation = Rotation(
            username = u, fromEpoch = i.fromEpoch, toEpoch = i.fromEpoch + 1,
            oldIrkPubHex = i.oldIrkPubHex.lowercase(), newIrkPubHex = PqHex.encode(PqHybrid.ed25519PublicKey(newIrkSeed)),
            newIrkScheme = i.scheme.wire, oldAidPubHex = oldAidPub, newAidPubHex = PqHex.encode(PqHybrid.ed25519PublicKey(newAidSeed)),
            adminRootPubHex = i.authority.pubHex.lowercase(),
            removedDeviceIds = listOf(i.plan.removed.deviceId),
            keptDevicesDigestHex = AccountKeyRotation.keptDevicesDigestHex(i.plan.keptDevices),
            recoveryRecordDigestHex = null,
            nonceHex = i.nonceHex, issuedAt = i.issuedAt,
        )
        val signatures = AccountKeyRotation.sign(rotation, i.authority.signer, AccountKeyRotation.seedSigner(newIrkSeed), AccountKeyRotation.seedSigner(newAidSeed))

        val deliveries = buildJsonArray {
            for (d in i.plan.kept) {
                if (d.deviceId == i.plan.self.deviceId) continue
                val rootForDevice = i.authority.newRootSeed?.takeIf { d.isAdministrator }
                val plain = AccountKeyRotation.encodePlaintext(AccountKeyRotation.Plaintext(i.newUmk, i.scheme, rootForDevice))
                val rk = d.receiveKey
                val (sealed, kind) = when {
                    rk != null -> AccountKeyRotation.sealXWing(rotation, d.deviceId, plain, PqHex.decode(rk.xwingPubHex.lowercase())!!, i.issuedAt) to "xwing"
                    i.strict -> throw PlanException("strict-requires-xwing-delivery")
                    else -> AccountKeyRotation.sealEd25519(plain, PqHex.decode(d.devicePubHex)!!) to "ed25519"
                }
                plain.fill(0)
                val (delivery, sig) = AccountKeyRotation.buildDelivery(rotation, d.deviceId, d.devicePubHex, sealed, i.issuedAt, i.authority.signer)
                add(buildJsonObject {
                    put("delivery", deliveryJson(delivery))
                    put("signatureHex", sig)
                    put("sealKind", kind)
                    put("sealedHex", PqHex.encode(sealed))
                })
            }
        }

        // A kept device whose grant the old account key signed gets one from the admin root, same scopes.
        val grants = buildJsonArray {
            for (d in i.plan.kept) {
                val live = d.grants.filter { it.signerRoot != "admin-root" }
                if (live.isEmpty()) continue
                val scopes = live.flatMap { it.scopes(json) }.distinct().let { s -> DeviceCapabilityGrant.DEVICE_SCOPE_ORDER.filter { it in s } + s.filter { it !in DeviceCapabilityGrant.DEVICE_SCOPE_ORDER } }
                val grantId = i.grantId()
                val expiresAt = i.issuedAt + GRANT_TTL_MS
                val bytes = DeviceCapabilityGrant.canonicalBytes(grantId, u, d.deviceId, d.devicePubHex, scopes, i.issuedAt, expiresAt)
                add(buildJsonObject {
                    put("grant", buildJsonObject {
                        put("grantId", grantId); put("username", u); put("deviceId", d.deviceId); put("devicePubKey", d.devicePubHex)
                        put("scopes", JsonArray(scopes.map { JsonPrimitive(it) })); put("issuedAt", i.issuedAt); put("expiresAt", expiresAt)
                    })
                    put("signature", PqHex.encode(i.authority.signer(bytes)))
                    put("signerRoot", "admin-root")
                })
            }
        }

        val accountProfile = reencryptAccountProfile(i, u)
        val managed = buildJsonArray {
            val keptIds = i.plan.kept.map { it.deviceId }.toSet()
            val oldKey = AccountMetadata.deriveDeviceDirectoryKey(i.oldUmk)
            val newKey = AccountMetadata.deriveDeviceDirectoryKey(i.newUmk)
            for (m in i.directory.managedProfiles) {
                val id = m.deviceId.lowercase()
                if (id !in keptIds) continue
                val name = runCatching {
                    AccountMetadata.decrypt(AccountMetadataCiphertext(m.nonceHex, m.ciphertextHex), oldKey,
                        AccountMetadataCoordinates(u, AccountMetadataRecordType.DEVICE_MANAGED_PROFILE, m.revision, m.keyVersion, id))
                }.getOrNull() ?: continue
                val revision = m.revision + 1
                val c = AccountMetadata.encrypt(name, newKey, AccountMetadataCoordinates(u, AccountMetadataRecordType.DEVICE_MANAGED_PROFILE, revision, 1, id))
                val sig = i.authority.signer(AccountMetadata.canonicalDeviceManagedProfile(u, id, revision, 1, c, m.locked, i.issuedAt, i.authority.pubHex))
                add(buildJsonObject {
                    put("accountId", u); put("deviceId", id); put("revision", revision); put("keyVersion", 1)
                    put("nonceHex", c.nonceHex); put("ciphertextHex", c.ciphertextHex); put("locked", m.locked)
                    put("issuedAt", i.issuedAt); put("signerPubHex", i.authority.pubHex); put("signatureHex", PqHex.encode(sig))
                })
            }
        }

        val pq = i.newIrkMldsaSeed?.let { ml -> i.authority.hybrid?.let { sign -> companion(rotation, newIrkSeed, ml, sign) } }
        if (i.strict && pq == null) throw PlanException("strict-requires-hybrid")

        val body = buildJsonObject {
            put("rotation", rotationJson(rotation))
            put("signatures", buildJsonObject {
                put("adminRootSignatureHex", signatures.adminRootSignatureHex)
                put("newIrkSignatureHex", signatures.newIrkSignatureHex)
                put("newAidSignatureHex", signatures.newAidSignatureHex)
            })
            pq?.let { put("pq", it) }
            put("kept", JsonArray(i.plan.keptDevices.map { k -> buildJsonObject { put("deviceId", k.deviceId); put("devicePubHex", k.devicePubHex) } }))
            if (deliveries.isNotEmpty()) put("deliveries", deliveries)
            if (grants.isNotEmpty()) put("grants", grants)
            accountProfile?.let { put("accountProfile", it) }
            if (managed.isNotEmpty()) put("managedProfiles", managed)
            i.authority.rotationBody?.let { put("adminRootRotation", it) }
        }
        newIrkSeed.fill(0); newAidSeed.fill(0)
        return Built(body, rotation, signatures, AccountKeyRotation.digestHex(rotation))
    }

    private fun reencryptAccountProfile(i: Inputs, u: String): JsonObject? {
        val p = i.directory.accountProfile ?: return null
        val name = runCatching {
            AccountMetadata.decrypt(AccountMetadataCiphertext(p.nonceHex, p.ciphertextHex), AccountMetadata.deriveAccountProfileKey(i.oldUmk),
                AccountMetadataCoordinates(u, AccountMetadataRecordType.ACCOUNT_PROFILE, p.revision, p.keyVersion))
        }.getOrNull() ?: return null
        val revision = p.revision + 1
        val c = AccountMetadata.encrypt(name, AccountMetadata.deriveAccountProfileKey(i.newUmk), AccountMetadataCoordinates(u, AccountMetadataRecordType.ACCOUNT_PROFILE, revision, 1))
        val sig = i.authority.signer(AccountMetadata.canonicalAccountProfile(u, revision, 1, c, i.issuedAt, i.authority.pubHex))
        return buildJsonObject {
            put("accountId", u); put("revision", revision); put("keyVersion", 1); put("nonceHex", c.nonceHex); put("ciphertextHex", c.ciphertextHex)
            put("issuedAt", i.issuedAt); put("signerPubHex", i.authority.pubHex); put("signatureHex", PqHex.encode(sig))
        }
    }

    /** The hybrid companion: the new IRK's `account-irk` binding (both halves) and the admin root's hybrid signature. */
    private fun companion(r: Rotation, newIrkSeed: ByteArray, mlSeed: ByteArray, adminSign: (String, ByteArray) -> ByteArray): JsonObject {
        val edPub = PqHybrid.ed25519PublicKey(newIrkSeed)
        val st = com.flagshipserver.app.core.pq.PqTrust.Statement("account-irk", r.username, r.newIrkPubHex,
            PqHex.encode(PqHybrid.mldsa65PublicKey(mlSeed)), r.issuedAt)
        val binding = com.flagshipserver.app.core.pq.PqTrust.signPqKeyBinding(st) { m ->
            PqHybrid.hybridSignSplit(edPub, { PqHybrid.ed25519Sign(newIrkSeed, it) }, mlSeed, com.flagshipserver.app.core.pq.PqTrust.TAG_PQ_KEY_BINDING, m)
        }
        return AccountKeyRotation.signPq(r, binding, adminSign)
    }

    fun rotationJson(r: Rotation): JsonObject = buildJsonObject {
        put("username", r.username); put("fromEpoch", r.fromEpoch); put("toEpoch", r.toEpoch)
        put("oldIrkPubHex", r.oldIrkPubHex); put("newIrkPubHex", r.newIrkPubHex); put("newIrkScheme", r.newIrkScheme)
        put("oldAidPubHex", r.oldAidPubHex); put("newAidPubHex", r.newAidPubHex); put("adminRootPubHex", r.adminRootPubHex)
        put("removedDeviceIds", JsonArray(r.removedDeviceIds.sorted().map { JsonPrimitive(it) }))
        put("keptDevicesDigestHex", r.keptDevicesDigestHex)
        put("recoveryRecordDigestHex", r.recoveryRecordDigestHex?.let { JsonPrimitive(it) } ?: JsonNull)
        put("nonceHex", r.nonceHex); put("issuedAt", r.issuedAt)
    }

    private fun deliveryJson(d: AccountKeyRotation.Delivery): JsonObject = buildJsonObject {
        put("username", d.username); put("toEpoch", d.toEpoch); put("deviceId", d.deviceId); put("devicePubHex", d.devicePubHex)
        put("rotationDigestHex", d.rotationDigestHex); put("sealedDigestHex", d.sealedDigestHex); put("issuedAt", d.issuedAt)
    }

    // ── Reading what `.com` sends ───────────────────────────────────────

    private fun JsonObject.s(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.l(k: String): Long? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull()

    fun parseRotation(e: JsonElement?): Rotation? {
        val o = e as? JsonObject ?: return null
        val removed = (o["removedDeviceIds"] as? JsonArray)?.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: return null } ?: return null
        val rec = o["recoveryRecordDigestHex"]
        return Rotation(
            username = o.s("username") ?: return null, fromEpoch = o.l("fromEpoch") ?: return null, toEpoch = o.l("toEpoch") ?: return null,
            oldIrkPubHex = o.s("oldIrkPubHex") ?: return null, newIrkPubHex = o.s("newIrkPubHex") ?: return null,
            newIrkScheme = o.s("newIrkScheme") ?: return null, oldAidPubHex = o.s("oldAidPubHex") ?: return null,
            newAidPubHex = o.s("newAidPubHex") ?: return null, adminRootPubHex = o.s("adminRootPubHex") ?: return null,
            removedDeviceIds = removed, keptDevicesDigestHex = o.s("keptDevicesDigestHex") ?: return null,
            recoveryRecordDigestHex = if (rec == null || rec is JsonNull) null else (rec as? JsonPrimitive)?.content ?: return null,
            nonceHex = o.s("nonceHex") ?: return null, issuedAt = o.l("issuedAt") ?: return null,
        )
    }

    fun parseSignatures(e: JsonElement?): Signatures? {
        val o = e as? JsonObject ?: return null
        return Signatures(o.s("adminRootSignatureHex") ?: return null, o.s("newIrkSignatureHex") ?: return null, o.s("newAidSignatureHex") ?: return null)
    }

    private fun parseKept(e: JsonElement?): List<KeptDevice>? =
        (e as? JsonArray)?.map { k -> (k as? JsonObject)?.let { o -> KeptDevice(o.s("deviceId") ?: return null, o.s("devicePubHex") ?: return null) } ?: return null }

    /** One account-key hop of the lane this device verified, with the root that signed it. */
    data class VerifiedHop(val rotation: Rotation, val signatures: Signatures, val kept: List<KeptDevice>)

    /** The local state a replay starts from: this device's epoch, IRK and AID, and the admin root it pinned. */
    data class Local(val username: String, val epoch: Long, val irkPubHex: String, val aidPubHex: String, val adminRootPin: String)

    class Replay(val hops: List<VerifiedHop>, val adminRoot: String)

    /**
     * Replay the lane from [local]: an admin-root rotation counts only when the root this device trusts signed it;
     * an account-key hop only when that root signed it and it moves on from the state before it. `.com` can leave
     * events out (this device then stays where it is) but cannot make one this device accepts.
     */
    fun replay(lane: JsonArray, local: Local): Replay {
        var root = local.adminRootPin.lowercase()
        var epoch = local.epoch
        var irk = local.irkPubHex.lowercase()
        var aid = local.aidPubHex.lowercase()
        val out = mutableListOf<VerifiedHop>()
        for (ev in lane) {
            val o = ev as? JsonObject ?: continue
            when (o.s("kind")) {
                "admin-root-rotation" -> {
                    val r = o["rotation"] as? JsonObject ?: continue
                    val old = r.s("oldAdminRootPubHex")?.lowercase() ?: continue
                    val new = r.s("newAdminRootPubHex")?.lowercase() ?: continue
                    val at = r.l("issuedAt") ?: continue
                    if (old != root) continue
                    val msg = AdminRootRotationClaim.canonicalBytes(local.username.lowercase(), old, new, at)
                    val sig = o.s("signatureHex") ?: continue
                    if (!AccountKeyRotation.isAcceptableEd25519Key(new)) continue
                    if (!PqHybrid.ed25519VerifyStrict(PqHex.decode(sig) ?: continue, msg, PqHex.decode(old)!!)) continue
                    root = new
                }
                "account-key-rotation" -> {
                    val r = parseRotation(o["rotation"]) ?: continue
                    if (r.toEpoch <= epoch) continue
                    val s = parseSignatures(o["signatures"]) ?: continue
                    val kept = parseKept(o["kept"]) ?: continue
                    try {
                        AccountKeyRotation.verify(r, s, AccountKeyRotation.KeyState(local.username, epoch, irk, aid, root))
                    } catch (_: AccountKeyRotation.Failure) {
                        continue
                    }
                    if (runCatching { AccountKeyRotation.keptDevicesDigestHex(kept) }.getOrNull() != r.keptDevicesDigestHex) continue
                    out += VerifiedHop(r, s, kept)
                    epoch = r.toEpoch; irk = r.newIrkPubHex; aid = r.newAidPubHex
                }
            }
        }
        return Replay(out, root)
    }

    /** A delivery as `.com` stores it for one device. */
    data class Delivery(val toEpoch: Long, val delivery: AccountKeyRotation.Delivery, val signatureHex: String, val kind: AccountKeyRotation.SealKind, val sealed: ByteArray)

    fun parseDeliveries(body: JsonObject): List<Delivery> =
        (body["deliveries"] as? JsonArray).orEmpty().mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val d = o["delivery"] as? JsonObject ?: return@mapNotNull null
            val kind = when (o.s("sealKind")) { "xwing" -> AccountKeyRotation.SealKind.XWING; "ed25519" -> AccountKeyRotation.SealKind.ED25519; else -> return@mapNotNull null }
            Delivery(
                toEpoch = o.l("toEpoch") ?: return@mapNotNull null,
                delivery = AccountKeyRotation.Delivery(
                    d.s("username") ?: return@mapNotNull null, d.l("toEpoch") ?: return@mapNotNull null, d.s("deviceId") ?: return@mapNotNull null,
                    d.s("devicePubHex") ?: return@mapNotNull null, d.s("rotationDigestHex") ?: return@mapNotNull null,
                    d.s("sealedDigestHex") ?: return@mapNotNull null, d.l("issuedAt") ?: return@mapNotNull null,
                ),
                signatureHex = o.s("signatureHex") ?: return@mapNotNull null,
                kind = kind,
                sealed = PqHex.decode(o.s("sealedHex") ?: return@mapNotNull null) ?: return@mapNotNull null,
            )
        }.sortedBy { it.toEpoch }

    /** Open this device's delivery for a hop it verified: in the kept list, signed by the hop's root, the UMK it names. */
    fun open(hop: VerifiedHop, d: Delivery, self: KeptDevice, secret: ByteArray): AccountKeyRotation.Plaintext {
        AccountKeyRotation.verifyKept(hop.rotation, hop.kept, self)
        return AccountKeyRotation.open(hop.rotation, d.delivery, d.signatureHex, d.sealed, d.kind, self, secret)
    }

    // ── The rotator's staged hop on its next start ──────────────────────

    enum class PendingAction { PROMOTE, RETRY, DROP }

    /** `.com` holds the hop's new IRK: it was applied. It still holds the old one, recently: send it again. */
    fun decidePending(r: Rotation, comIrkPubHex: String, now: Long): PendingAction = when {
        comIrkPubHex.lowercase() == r.newIrkPubHex -> PendingAction.PROMOTE
        comIrkPubHex.lowercase() == r.oldIrkPubHex && now - r.issuedAt < RETRY_WINDOW_MS -> PendingAction.RETRY
        else -> PendingAction.DROP
    }

    fun scheme(r: Rotation): AccountKeyRotation.IrkScheme = AccountKeyRotation.IrkScheme.of(r.newIrkScheme) ?: AccountKeyRotation.IrkScheme.ANDROID
}
