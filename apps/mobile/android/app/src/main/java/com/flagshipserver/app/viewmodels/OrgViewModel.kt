package com.flagshipserver.app.viewmodels

import androidx.compose.runtime.staticCompositionLocalOf
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.OrgCeremony
import com.flagshipserver.app.core.OrgClient
import com.flagshipserver.app.core.OrgClientException
import com.flagshipserver.app.core.OrgJson
import com.flagshipserver.app.core.OrgPendingJoin
import com.flagshipserver.app.core.OrgSnapshot
import com.flagshipserver.app.core.str
import com.flagshipserver.app.core.memberKey
import com.flagshipserver.app.core.genesis
import com.flagshipserver.app.core.randomId
import com.flagshipserver.app.core.pq.keys
import com.flagshipserver.app.core.pq.newestVersion
import com.flagshipserver.app.core.pq.OrgApproval
import com.flagshipserver.app.core.pq.OrgAuthority
import com.flagshipserver.app.core.pq.OrgAuthorityException
import com.flagshipserver.app.core.pq.OrgAuthorityWire
import com.flagshipserver.app.core.pq.OrgSeatGrant
import com.flagshipserver.app.core.pq.OrgVerifiedFreeze
import com.flagshipserver.app.keystore.OrgSeatRecord
import com.flagshipserver.app.keystore.OrgSeatStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** What the org screens need, provided once by the activity. */
class OrgRuntime(
    val client: OrgClient,
    val keys: OrgSeatStore,
    val umk: suspend (reason: String) -> ByteArray,
)

val LocalOrgs = staticCompositionLocalOf<OrgRuntime?> { null }

/**
 * Settings → Organizations on Android (docs/enterprise-accounts.md E4); the Kotlin twin of the
 * parts of iOS `OrgViewModel` an Android seat needs: the people waiting to join with their code,
 * "Codes match: admit", and the approvals inbox (a second admin completes an admin-role grant).
 * Everything shown is verified from the genesis hash this phone pinned; every action is a
 * hybrid-signed approval by this phone's seat admin key.
 */
class OrgViewModel(
    private val client: OrgClient,
    private val keys: OrgSeatStore,
    private val umk: suspend (reason: String) -> ByteArray,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    sealed interface Phase {
        data object Idle : Phase
        data object Loading : Phase
        data object Loaded : Phase
        data class Failed(val message: String) : Phase
    }

    private val _seats = MutableStateFlow(keys.seats())
    val seats: StateFlow<List<OrgSeatRecord>> = _seats.asStateFlow()
    private val _phase = MutableStateFlow<Phase>(Phase.Idle)
    val phase: StateFlow<Phase> = _phase.asStateFlow()
    private val _snapshot = MutableStateFlow<OrgSnapshot?>(null)
    val snapshot: StateFlow<OrgSnapshot?> = _snapshot.asStateFlow()
    private val _pendingJoins = MutableStateFlow<List<OrgPendingJoin>>(emptyList())
    val pendingJoins: StateFlow<List<OrgPendingJoin>> = _pendingJoins.asStateFlow()
    private val _rotations = MutableStateFlow<List<com.flagshipserver.app.core.pq.OrgPendingRotation>>(emptyList())
    /** Departed seats whose keys still need rotating, as this phone verified them. */
    val rotations: StateFlow<List<com.flagshipserver.app.core.pq.OrgPendingRotation>> = _rotations.asStateFlow()
    private var plan: com.flagshipserver.app.core.pq.OrgRotationPlan? = null
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    private val _names = MutableStateFlow<Map<String, String>>(emptyMap())
    /** Pseudonyms from the org directory (seat id → name), opened on this phone with the directory key. */
    val names: StateFlow<Map<String, String>> = _names.asStateFlow()
    private var directoryKeys: Map<Long, ByteArray> = emptyMap()
    private val _people = MutableStateFlow<Map<String, com.flagshipserver.app.core.pq.OrgDirectoryEntry>>(emptyMap())
    /** The admin console's Directory: everyone's entry (seat id → entry). */
    val people: StateFlow<Map<String, com.flagshipserver.app.core.pq.OrgDirectoryEntry>> = _people.asStateFlow()
    class DirectoryProposal(val id: String, val kind: String, val entry: com.flagshipserver.app.core.pq.OrgDirectoryEntry,
        val roles: List<com.flagshipserver.app.core.pq.OrgSeatRole>, val subject: String)
    private val _proposals = MutableStateFlow<List<DirectoryProposal>>(emptyList())
    /** Open proposals from directory connectors, each checked against its connector and opened on this phone. */
    val proposals: StateFlow<List<DirectoryProposal>> = _proposals.asStateFlow()
    private val _connectors = MutableStateFlow<List<com.flagshipserver.app.core.pq.OrgConnector>>(emptyList())
    val connectors: StateFlow<List<com.flagshipserver.app.core.pq.OrgConnector>> = _connectors.asStateFlow()
    private val _newConnector = MutableStateFlow<Pair<String, String>?>(null)
    /** The SCIM URL and token of a connector just added: shown once, never stored on the phone. */
    val newConnector: StateFlow<Pair<String, String>?> = _newConnector.asStateFlow()
    private var directoryEntryIds: Map<String, String> = emptyMap()
    private val _inviteLink = MutableStateFlow<String?>(null)
    /** The link of the last invitation made, shown as a QR and shared. */
    val inviteLink: StateFlow<String?> = _inviteLink.asStateFlow()

    fun reloadSeats() { _seats.value = keys.seats() }

    /** What a screen calls a seat: "You", its pseudonym from the directory, or a placeholder until the directory opens. */
    fun name(seat: OrgSeatRecord, seatId: String): String = when {
        seatId == seat.seatId -> FSStrings.get(R.string.org_you)
        else -> _names.value[seatId] ?: FSStrings.get(R.string.org_name_hidden, seatId.take(6))
    }

    class AdminRow(val seatId: String, val kind: com.flagshipserver.app.core.pq.OrgAdminKind, val isFounder: Boolean, val isMe: Boolean, val frozenUntil: Long?)

    fun admins(seat: OrgSeatRecord): List<AdminRow> {
        val s = _snapshot.value ?: return emptyList()
        val r = s.state.current
        return r.admins.map { a ->
            AdminRow(a.seatId, a.kind, a.seatId == r.founderSeatId, a.seatId == seat.seatId,
                s.book.freezes.firstOrNull { it.seatId == a.seatId && it.issuedAt <= now() && now() < it.untilMs }?.untilMs)
        }
    }

    /** Creates an org with this phone as its founder and only admin; more admins join by invite. */
    suspend fun create(name: String): Boolean {
        val n = name.trim().lowercase()
        if (n.isEmpty()) return false
        _busy.value = true
        val orgId = OrgAuthority.randomId()
        val seatId = OrgAuthority.randomId()
        val t = now()
        return try {
            val (binding, secret) = keys.makeKey(orgId, seatId, t)
            try {
                val record = OrgAuthority.genesis(orgId, seatId, binding, t)
                val keyId = OrgAuthority.keyIdHex(binding.ed25519PubHex, binding.mldsaPubHex)
                val approval = OrgAuthority.signApproval(orgId, 0, OrgAuthority.canonicalAuthority(record), seatId, keyId, t, t + DAY) { p, m ->
                    com.flagshipserver.app.core.pq.PqHybrid.hybridSign(secret, p, m)
                }
                client.create(n, com.flagshipserver.app.core.pq.OrgAuthorityEntry(record, "genesis", listOf(approval), null, null))
                keys.remember(orgId, seatId, n, OrgAuthority.authorityHash(record), binding, secret)
            } finally { secret.fill(0) }
            reloadSeats()
            true
        } catch (e: OrgClientException) {
            _message.value = if (e.code == "taken" || e.status == 409) FSStrings.get(R.string.org_name_taken) else FSStrings.get(R.string.org_create_failed)
            false
        } catch (e: Exception) {
            _message.value = FSStrings.get(R.string.org_create_failed)
            false
        } finally {
            _busy.value = false
        }
    }

    /** Freezes another admin for 72 hours (one admin may, at most once a week). */
    suspend fun freeze(seat: OrgSeatRecord, target: String) {
        val s = _snapshot.value ?: return
        _busy.value = true
        try {
            val t = now()
            val body = com.flagshipserver.app.core.pq.OrgSeatFreeze(seat.orgId, target, t + 72 * 3_600_000L, s.state.current.version, t)
            val a = approval(seat, OrgAuthority.canonical(body))
            client.freeze(seat.orgId, com.flagshipserver.app.core.pq.OrgSigned(body, listOf(a)))
            _message.value = FSStrings.get(R.string.org_frozen_done)
            load(seat)
        } catch (e: OrgClientException) {
            _message.value = if (e.code == "org-freeze-refused") FSStrings.get(R.string.org_freeze_refused) else FSStrings.get(R.string.org_try_again)
        } catch (e: Exception) {
            failed(e)
        } finally {
            _busy.value = false
        }
    }

    enum class InviteRole { MEMBER, SERVER_ADMIN, APP_ADMIN }

    /**
     * Makes an invitation. The pseudonym is required first: `.com` keeps only its digest and the copy
     * sealed under the link key; the admins' copy goes into the org directory under the directory key.
     */
    suspend fun invite(seat: OrgSeatRecord, pseudonym: String, role: InviteRole, target: String) {
        val name = pseudonym.trim()
        if (name.isEmpty()) { _message.value = FSStrings.get(R.string.org_invite_name_needed); return }
        val roles = when (role) {
            InviteRole.MEMBER -> listOf(com.flagshipserver.app.core.pq.OrgSeatRole.Member)
            InviteRole.SERVER_ADMIN -> listOf(com.flagshipserver.app.core.pq.OrgSeatRole.ServerAdmin(listOf(target.trim().lowercase())))
            InviteRole.APP_ADMIN -> listOf(com.flagshipserver.app.core.pq.OrgSeatRole.ServiceAdmin(listOf(target.trim().lowercase())))
        }
        _busy.value = true
        try {
            makeInvite(seat, name, roles, null)
        } catch (e: Exception) {
            failed(e)
        } finally {
            _busy.value = false
        }
    }

    /** Posts an invitation for [roles] and records the person in the directory; returns the invite's digest. */
    private suspend fun makeInvite(seat: OrgSeatRecord, name: String, roles: List<com.flagshipserver.app.core.pq.OrgSeatRole>, entry: com.flagshipserver.app.core.pq.OrgDirectoryEntry?): String {
        val s = _snapshot.value ?: throw OrgAuthorityException("stale-oar")
        run {
            val seatId = OrgAuthority.randomId()
            val t = now()
            val linkKey = ByteArray(32).also(java.security.SecureRandom()::nextBytes)
            val sealedLabel = gcmSeal(linkKey, name.toByteArray(Charsets.UTF_8))
            val rolesJson = OrgJson.roles(roles)
            val offer = gcmSeal(linkKey, buildJsonObject {
                put("orgId", seat.orgId); put("orgName", seat.orgName); put("genesisHash", seat.genesisHash); put("seatId", seatId)
                put("roles", rolesJson); put("pseudonym", name)
            }.toString().toByteArray(Charsets.UTF_8))
            val rolesHash = OrgAuthority.rolesHash(roles)
            val labelSha = OrgAuthority.sha256Hex(sealedLabel)
            val v = s.state.current.version
            val expires = t + 7 * DAY
            val order = OrgAuthority.canonicalSeatInvite(seat.orgId, seatId, labelSha, rolesHash, v, t, expires)
            val a = approval(seat, order)
            client.createInvite(seat.orgId, buildJsonObject {
                put("invite", buildJsonObject {
                    put("orgId", seat.orgId); put("seatId", seatId); put("labelSha256", labelSha); put("rolesHash", rolesHash)
                    put("oarVersion", v); put("issuedAt", t); put("expiresAt", expires)
                })
                put("roles", rolesJson)
                put("approvals", buildJsonArray { add(OrgJson.approval(a)) })
                put("sealedLabelHex", com.flagshipserver.app.core.pq.PqHex.encode(sealedLabel))
                put("offerHex", com.flagshipserver.app.core.pq.PqHex.encode(offer))
            })
            runCatching { recordEntry(seat, (entry ?: com.flagshipserver.app.core.pq.OrgDirectoryEntry(seatId = seatId, pseudonym = name, updatedAt = t)).copy(seatId = seatId, pendingId = "")) }
            _inviteLink.value = "${com.flagshipserver.app.core.Endpoints.controlBaseUrl}/org-join#o=${seat.orgId}&s=$seatId&k=${com.flagshipserver.app.core.pq.PqHex.encode(linkKey)}"
            linkKey.fill(0)
            return OrgAuthority.sha256Hex(order)
        }
    }

    fun clearInvite() { _inviteLink.value = null }

    private fun gcmSeal(key: ByteArray, plain: ByteArray): ByteArray {
        val nonce = ByteArray(12).also(java.security.SecureRandom()::nextBytes)
        val c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        c.init(javax.crypto.Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec(key, "AES"), javax.crypto.spec.GCMParameterSpec(128, nonce))
        return nonce + c.doFinal(plain)
    }

    // ── directory (docs/org-directory.md §2) ──

    /**
     * Opens the org directory with this admin's seat KEM key. The first admin to look makes the
     * directory key (sealed to every admin with a KEM key); an admin whose KEM key `.com` lacks
     * announces it first. Names stay on this phone; nothing reaches `.com` unsealed.
     */
    suspend fun loadNames(seat: OrgSeatRecord) {
        val s = _snapshot.value ?: return
        if (s.state.current.admins.none { it.seatId == seat.seatId && it.kind == com.flagshipserver.app.core.pq.OrgAdminKind.ADMIN }) return
        try {
            val seed = umk(FSStrings.get(R.string.org_show_names_reason))
            val kp = try {
                val kemSeed = com.flagshipserver.app.core.pq.OrgServers.seatKemSeed(seed, seat.orgId)
                try { com.flagshipserver.app.core.pq.PqHybrid.hybridSealKeygen(kemSeed) } finally { kemSeed.fill(0) }
            } finally { seed.fill(0) }
            if (plan?.ctx?.kems?.get("seat:${seat.seatId}")?.kemKeyId != com.flagshipserver.app.core.pq.OrgServers.kemKeyIdHex(kp.publicKey)) {
                publishSeatKem(seat, s)
                plan = client.rotationPlan(s, now())
            }
            var p = plan ?: return
            if (com.flagshipserver.app.core.pq.OrgDirectory.newestVersion(p) == null) {
                val key = ByteArray(32).also(java.security.SecureRandom()::nextBytes)
                val b = try {
                    com.flagshipserver.app.core.pq.OrgRotation.rotate(p, com.flagshipserver.app.core.pq.OrgKeyKind.DIRECTORY_KEY, "*", now(), key) { order, _ -> approval(seat, order) }
                } finally { key.fill(0) }
                client.postKeyRing(seat.orgId, com.flagshipserver.app.core.pq.OrgRotation.bundleJson(b))
                p = client.rotationPlan(s, now())
                plan = p
            }
            directoryKeys = com.flagshipserver.app.core.pq.OrgDirectory.keys(p, seat.seatId, kp.secretKey)
            val (bySeat, _) = com.flagshipserver.app.core.pq.OrgDirectory.openAll(seat.orgId, client.directory(seat.orgId), directoryKeys)
            _names.value = bySeat.mapValues { it.value.entry.pseudonym }
            _people.value = bySeat.mapValues { it.value.entry }
            directoryEntryIds = bySeat.mapValues { it.value.entryId }
            loadConsole(seat, kp.secretKey)
        } catch (e: Exception) {
            _names.value = emptyMap()
        }
    }

    /** Writes (or updates) one person's entry under the newest directory key; returns the write's digest. */
    suspend fun recordEntry(seat: OrgSeatRecord, entry: com.flagshipserver.app.core.pq.OrgDirectoryEntry): String {
        if (directoryKeys.isEmpty()) loadNames(seat)
        val p = plan ?: throw OrgAuthorityException("locked")
        val version = com.flagshipserver.app.core.pq.OrgDirectory.newestVersion(p) ?: throw OrgAuthorityException("locked")
        val key = directoryKeys[version] ?: throw OrgAuthorityException("locked")
        val t = now()
        val e = entry.copy(updatedAt = t)
        val sealed = com.flagshipserver.app.core.pq.OrgDirectory.seal(seat.orgId, directoryEntryIds[e.seatId] ?: OrgAuthority.randomId(), version, key, e, t)
        val order = com.flagshipserver.app.core.pq.OrgDirectory.canonicalWrite(sealed)
        client.putDirectory(seat.orgId, sealed, approval(seat, order))
        _names.value = _names.value + (e.seatId to e.pseudonym)
        _people.value = _people.value + (e.seatId to e)
        directoryEntryIds = directoryEntryIds + (e.seatId to sealed.entryId)
        return OrgAuthority.sha256Hex(order)
    }

    /** After the directory key changes, every entry is sealed again under the new version. */
    private suspend fun resealDirectory(seat: OrgSeatRecord) {
        val p = plan ?: return
        val version = com.flagshipserver.app.core.pq.OrgDirectory.newestVersion(p) ?: return
        val key = directoryKeys[version] ?: return
        val all = runCatching { client.directory(seat.orgId) }.getOrNull() ?: return
        val (bySeat, byPending) = com.flagshipserver.app.core.pq.OrgDirectory.openAll(seat.orgId, all, directoryKeys)
        val stale = all.filter { it.keyVersion < version }.map { it.entryId }.toSet()
        for (e in bySeat.values + byPending.values) {
            if (e.entryId !in stale) continue
            runCatching {
                val t = now()
                val sealed = com.flagshipserver.app.core.pq.OrgDirectory.seal(seat.orgId, e.entryId, version, key, e.entry, t)
                client.putDirectory(seat.orgId, sealed, approval(seat, com.flagshipserver.app.core.pq.OrgDirectory.canonicalWrite(sealed)))
            }
        }
    }

    suspend fun load(seat: OrgSeatRecord) {
        _phase.value = Phase.Loading
        try {
            _snapshot.value = client.snapshot(seat.orgId, seat.genesisHash, now())
            _pendingJoins.value = runCatching { client.pendingJoins(seat.orgId) }.getOrDefault(emptyList())
            plan = if (seat.memberOnly) null else runCatching { client.rotationPlan(_snapshot.value!!, now()) }.getOrNull()
            _rotations.value = plan?.pending ?: emptyList()
            _phase.value = Phase.Loaded
            if (!seat.memberOnly) loadNames(seat)
        } catch (e: Exception) {
            _snapshot.value = null
            _phase.value = Phase.Failed(FSStrings.get(R.string.org_records_bad))
        }
    }

    fun myFreeze(seat: OrgSeatRecord): OrgVerifiedFreeze? = _snapshot.value?.book?.freezes?.firstOrNull {
        it.seatId == seat.seatId && it.issuedAt <= now() && now() < it.untilMs
    }

    fun hasApproved(seat: OrgSeatRecord, c: OrgCeremony) = c.approvals.any { it.seatId == seat.seatId }

    private fun approval(seat: OrgSeatRecord, order: ByteArray): OrgApproval {
        val s = _snapshot.value ?: throw OrgAuthorityException("stale-oar")
        val t = now()
        return OrgAuthority.signApproval(seat.orgId, s.state.current.version, order, seat.seatId, seat.keyId, t, t + DAY) { p, m ->
            keys.sign(seat, p, m) ?: throw OrgAuthorityException("locked")
        }
    }

    private fun failed(e: Exception) {
        _message.value = when {
            e is OrgAuthorityException && e.code == "locked" -> FSStrings.get(R.string.org_unlock_to_sign)
            e is OrgClientException && e.code == "org-seat-limit" -> FSStrings.get(R.string.org_no_seats)
            else -> FSStrings.get(R.string.org_try_again)
        }
    }

    private fun grantBody(j: OrgPendingJoin, version: Long, t: Long): Pair<ByteArray, JsonObject> {
        val roles = OrgAuthorityWire.roles(j.roles)
        val label = str(j.invite, "labelSha256") ?: throw OrgAuthorityException("malformed")
        val rolesHash = str(j.invite, "rolesHash") ?: throw OrgAuthorityException("malformed")
        if (OrgAuthority.rolesHash(roles) != rolesHash) throw OrgAuthorityException("malformed", "roles")
        val memberKeyId = str(j.accept, "memberKeyId") ?: throw OrgAuthorityException("malformed")
        val adminKeyId = str(j.accept, "adminKeyId") ?: ""
        val orgId = str(j.invite, "orgId") ?: throw OrgAuthorityException("malformed")
        val expiresAt = t + 365 * DAY
        val grant = OrgSeatGrant(orgId, j.seatId, label, memberKeyId, adminKeyId, rolesHash, version, t, expiresAt)
        val body = buildJsonObject {
            put("grant", buildJsonObject {
                put("orgId", orgId); put("seatId", j.seatId); put("labelSha256", label); put("memberKeyId", memberKeyId)
                put("adminKeyId", adminKeyId); put("rolesHash", rolesHash); put("oarVersion", version); put("issuedAt", t); put("expiresAt", expiresAt)
            })
            put("roles", j.roles)
            put("memberBinding", j.memberBinding.toJson())
            put("adminBinding", j.adminBinding?.toJson() ?: JsonNull)
        }
        return OrgAuthority.canonical(grant) to body
    }

    /**
     * Admits a person whose code matched: one admin for a member; for an admin role the second
     * admin's approval in the inbox completes it (two org admins raise a seat to admin).
     */
    suspend fun admit(seat: OrgSeatRecord, j: OrgPendingJoin) {
        val s = _snapshot.value ?: return
        _busy.value = true
        try {
            val (order, body) = grantBody(j, s.state.current.version, now())
            val a = approval(seat, order)
            if (OrgAuthority.grantThreshold(s.state.current, OrgAuthorityWire.roles(j.roles)) <= 1) {
                client.grant(seat.orgId, JsonObject(body + ("approvals" to buildJsonArray { add(OrgJson.approval(a)) })))
                _message.value = FSStrings.get(R.string.org_admitted)
            } else {
                client.openCeremony(seat.orgId, String(order, Charsets.UTF_8), JsonObject(body + ("kind" to kotlinx.serialization.json.JsonPrimitive("grant"))), a)
                _message.value = FSStrings.get(R.string.org_needs_second_admin)
            }
            load(seat)
        } catch (e: Exception) {
            failed(e)
        } finally {
            _busy.value = false
        }
    }

    /** Approves a ceremony; a seat grant that now has enough approvals is submitted. */
    suspend fun approve(seat: OrgSeatRecord, c: OrgCeremony) {
        _busy.value = true
        try {
            val a = approval(seat, c.order.toByteArray(Charsets.UTF_8))
            client.approve(seat.orgId, c.sha256, a)
            val s = _snapshot.value
            if (s != null && c.purpose == OrgAuthority.TAG_SEAT_GRANT && str(c.payload, "kind") == "grant") {
                val roles = OrgAuthorityWire.roles(c.payload["roles"])
                val all = c.approvals.filter { it.seatId != seat.seatId } + a
                if (all.size >= OrgAuthority.grantThreshold(s.state.current, roles)) {
                    val body = JsonObject(c.payload - "kind" + ("approvals" to JsonArray(all.map { OrgJson.approval(it) })))
                    client.grant(seat.orgId, body)
                }
            }
            _message.value = FSStrings.get(R.string.org_approved)
            load(seat)
        } catch (e: Exception) {
            failed(e)
        } finally {
            _busy.value = false
        }
    }

    /** Keys this seat can rotate now (a disk key changes only with the server's own re-key, not built yet). */
    fun rotatable(r: com.flagshipserver.app.core.pq.OrgPendingRotation) =
        r.keys.filter { it.first != com.flagshipserver.app.core.pq.OrgKeyKind.DISK_KEY }

    /**
     * "Rotate keys" for one departed seat: this phone first announces its own seat KEM key (so it
     * keeps receiving the new versions), then seals a fresh key for each chain the seat could read
     * to the recipients it verified, approved by this seat's admin key, and posts each version.
     */
    suspend fun rotate(seat: OrgSeatRecord, r: com.flagshipserver.app.core.pq.OrgPendingRotation) {
        val s = _snapshot.value ?: return
        _busy.value = true
        try {
            publishSeatKem(seat, s)
            load(seat)
            var p = plan ?: throw OrgAuthorityException("malformed", "no plan")
            for ((kind, scope) in rotatable(r)) {
                val key = ByteArray(32).also(java.security.SecureRandom()::nextBytes)
                val b = try {
                    com.flagshipserver.app.core.pq.OrgRotation.rotate(p, kind, scope, now(), key) { order, _ -> approval(seat, order) }
                } finally { key.fill(0) }
                client.postKeyRing(seat.orgId, com.flagshipserver.app.core.pq.OrgRotation.bundleJson(b))
                p = client.rotationPlan(_snapshot.value!!, now())
            }
            _message.value = FSStrings.get(R.string.org_keys_rotated)
            load(seat)
            if (rotatable(r).any { it.first == com.flagshipserver.app.core.pq.OrgKeyKind.DIRECTORY_KEY }) resealDirectory(seat)
        } catch (e: Exception) {
            failed(e)
        } finally {
            _busy.value = false
        }
    }

    /** This seat's X-Wing key from the UMK, signed by the seat's admin key (an org admin) or its member key. */
    private suspend fun publishSeatKem(seat: OrgSeatRecord, s: OrgSnapshot) {
        val t = now()
        val seed = umk(FSStrings.get(R.string.org_rotate_reason))
        try {
            val kemSeed = com.flagshipserver.app.core.pq.OrgServers.seatKemSeed(seed, seat.orgId)
            val kp = com.flagshipserver.app.core.pq.PqHybrid.hybridSealKeygen(kemSeed)
            kemSeed.fill(0)
            val kemKeyId = com.flagshipserver.app.core.pq.OrgServers.kemKeyIdHex(kp.publicKey)
            val msg = com.flagshipserver.app.core.pq.OrgServers.canonicalSeatKem(seat.orgId, seat.seatId, kemKeyId, t)
            val purpose = com.flagshipserver.app.core.pq.OrgServers.TAG_SEAT_KEM
            val sig = if (s.state.current.admins.any { it.seatId == seat.seatId }) {
                keys.sign(seat, purpose, msg) ?: throw OrgAuthorityException("locked")
            } else {
                val (_, secret) = OrgAuthority.memberKey(seed, seat.orgId, seat.seatId, t)
                try { com.flagshipserver.app.core.pq.PqHybrid.hybridSign(secret, purpose, msg) } finally { secret.fill(0) }
            }
            client.postSeatKem(seat.orgId, buildJsonObject {
                put("statement", buildJsonObject { put("orgId", seat.orgId); put("seatId", seat.seatId); put("kemKeyId", kemKeyId); put("issuedAt", t) })
                put("kemPubHex", com.flagshipserver.app.core.pq.PqHex.encode(kp.publicKey))
                put("signature", com.flagshipserver.app.core.pq.PqHex.encode(sig))
            })
        } finally {
            seed.fill(0)
        }
    }

    // ── admin console: directory proposals and connectors (docs/org-directory.md §6) ──

    private suspend fun loadConsole(seat: OrgSeatRecord, kemSecret: ByteArray) {
        val raw = runCatching { client.connectors(seat.orgId) }.getOrDefault(emptyList())
        val byId = raw.associateBy { str(it["connector"] as? JsonObject, "connectorId") ?: "" }
        _connectors.value = raw.mapNotNull { runCatching { com.flagshipserver.app.core.pq.OrgConnectors.connector(it["connector"] as JsonObject) }.getOrNull() }
        val out = mutableListOf<DirectoryProposal>()
        for (p in runCatching { client.proposals(seat.orgId) }.getOrDefault(emptyList())) {
            if (p["decision"] != null && p["decision"] !is JsonNull) continue
            runCatching {
                val b = p["bundle"] as JsonObject
                val cb = byId[str(b["proposal"] as JsonObject, "connectorId")] ?: return@runCatching
                val roles = (b["roles"] as? JsonArray)?.let { OrgAuthorityWire.roles(it) } ?: emptyList()
                val v = com.flagshipserver.app.core.pq.OrgConnectors.verifyProposal(cb, b, if (roles.isEmpty()) "" else OrgAuthority.rolesHash(roles), now())
                val entry = com.flagshipserver.app.core.pq.OrgDirectory.parseBody(
                    com.flagshipserver.app.core.pq.OrgConnectors.openProposal(b, "seat:${seat.seatId}", kemSecret))
                out += DirectoryProposal(v.proposalId, v.kind, entry, roles, v.subject)
            }
        }
        _proposals.value = out.sortedBy { it.entry.pseudonym }
    }

    private suspend fun decide(seat: OrgSeatRecord, p: DirectoryProposal, ref: String?) {
        val t = now()
        val r = ref ?: "0".repeat(64)
        val d = if (ref == null) "declined" else "done"
        val order = com.flagshipserver.app.core.pq.OrgConnectors.canonicalDecision(seat.orgId, p.id, d, r, t)
        client.decideProposal(seat.orgId, buildJsonObject {
            put("orgId", seat.orgId); put("proposalId", p.id); put("decision", d); put("refSha256", r); put("issuedAt", t)
        }, approval(seat, order))
        _proposals.value = _proposals.value.filter { it.id != p.id }
    }

    /** Carries a proposal out with the usual order, then records it (an invitation, a removal or the updated entry). */
    suspend fun approveProposal(seat: OrgSeatRecord, p: DirectoryProposal) {
        val s = _snapshot.value ?: return
        _busy.value = true
        try {
            when (p.kind) {
                "invite" -> {
                    val ref = makeInvite(seat, p.entry.pseudonym, p.roles.ifEmpty { listOf(com.flagshipserver.app.core.pq.OrgSeatRole.Member) }, p.entry)
                    decide(seat, p, ref)
                    _message.value = FSStrings.get(R.string.org_proposal_invited)
                }
                "offboard" -> {
                    val t = now()
                    val v = s.state.current.version
                    val order = OrgAuthority.canonical(com.flagshipserver.app.core.pq.OrgSeatRevokeBundle(seat.orgId, p.subject, "offboarded", v, t, emptyList(), null))
                    val a = approval(seat, order)
                    client.revoke(seat.orgId, buildJsonObject {
                        put("revoke", buildJsonObject { put("orgId", seat.orgId); put("seatId", p.subject); put("reason", "offboarded"); put("oarVersion", v); put("issuedAt", t) })
                        put("approvals", buildJsonArray { add(OrgJson.approval(a)) })
                    })
                    decide(seat, p, OrgAuthority.sha256Hex(order))
                    _message.value = FSStrings.get(R.string.org_proposal_removed)
                    load(seat)
                }
                "entry-update" -> {
                    decide(seat, p, recordEntry(seat, p.entry.copy(seatId = p.subject, pendingId = "")))
                    _message.value = FSStrings.get(R.string.org_proposal_updated)
                }
                else -> _message.value = FSStrings.get(R.string.org_proposal_role_from_seat)
            }
        } catch (e: Exception) {
            failed(e)
        } finally {
            _busy.value = false
        }
    }

    suspend fun declineProposal(seat: OrgSeatRecord, p: DirectoryProposal) {
        _busy.value = true
        try { decide(seat, p, null) } catch (e: Exception) { failed(e) } finally { _busy.value = false }
    }

    /** The org's servers this phone verified (the connector's server picker). */
    fun servers(): List<String> = plan?.ctx?.servers?.sorted() ?: emptyList()

    /**
     * Adds a SCIM connector on one of the org's servers: this phone makes its key and bearer token,
     * approves the record and seals the setup to that server. The token is shown once.
     */
    suspend fun addScimConnector(seat: OrgSeatRecord, serverDomain: String) {
        val boxKem = plan?.ctx?.kems?.get("box:$serverDomain")
        if (boxKem == null) { _message.value = FSStrings.get(R.string.org_connector_no_key); return }
        _busy.value = true
        try {
            val t = now()
            val mapping = com.flagshipserver.app.core.pq.OrgConnectorConsole.defaultMapping()
            val made = com.flagshipserver.app.core.pq.OrgConnectorConsole.newConnector(seat.orgId, OrgAuthority.randomId(), "scim", serverDomain, mapping, t)
            val token = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also(java.security.SecureRandom()::nextBytes))
            val setup = buildJsonObject {
                put("connectorSeedsHex", made.seedsHex); put("mapping", mapping)
                put("scimTokenSha256", OrgAuthority.sha256Hex(token.toByteArray(Charsets.UTF_8))); put("scimTokenIssuedAt", t)
            }
            val a = approval(seat, com.flagshipserver.app.core.pq.OrgConnectors.canonical(made.connector))
            client.postConnector(seat.orgId, buildJsonObject {
                put("connector", com.flagshipserver.app.core.pq.OrgConnectorConsole.json(made.connector)); put("connectorPubHex", made.pubHex)
                put("approvals", buildJsonArray { add(OrgJson.approval(a)) })
                put("setup", com.flagshipserver.app.core.pq.OrgConnectorConsole.sealSetup(made.connector, boxKem, setup, t))
            })
            _newConnector.value = "https://$serverDomain/scim/v2" to token
            _connectors.value = _connectors.value + made.connector
        } catch (e: Exception) {
            failed(e)
        } finally {
            _busy.value = false
        }
    }

    fun clearNewConnector() { _newConnector.value = null }

    companion object {
        fun proposalText(kind: String): String = when (kind) {
            "invite" -> FSStrings.get(R.string.org_proposal_invite)
            "offboard" -> FSStrings.get(R.string.org_proposal_offboard)
            "role-change" -> FSStrings.get(R.string.org_proposal_role)
            else -> FSStrings.get(R.string.org_proposal_entry)
        }

        fun connectorText(kind: String): String = when (kind) {
            "scim" -> FSStrings.get(R.string.org_connector_scim)
            "ldap" -> FSStrings.get(R.string.org_connector_ldap)
            else -> FSStrings.get(R.string.org_connector_custom)
        }

        fun statusText(status: String): String = when (status) {
            "active" -> FSStrings.get(R.string.org_connector_active)
            "paused" -> FSStrings.get(R.string.org_connector_paused)
            else -> FSStrings.get(R.string.org_connector_retired)
        }

        fun kindText(kind: com.flagshipserver.app.core.pq.OrgAdminKind, founder: Boolean): String = when {
            founder -> FSStrings.get(R.string.org_kind_founder)
            kind == com.flagshipserver.app.core.pq.OrgAdminKind.BOARD -> FSStrings.get(R.string.org_kind_board)
            kind == com.flagshipserver.app.core.pq.OrgAdminKind.RECOVERY -> FSStrings.get(R.string.org_kind_recovery)
            else -> FSStrings.get(R.string.org_kind_admin)
        }

        fun keyText(kind: com.flagshipserver.app.core.pq.OrgKeyKind, scope: String): String = when (kind) {
            com.flagshipserver.app.core.pq.OrgKeyKind.CGK -> FSStrings.get(R.string.org_key_cgk)
            com.flagshipserver.app.core.pq.OrgKeyKind.DIRECTORY_KEY -> FSStrings.get(R.string.org_key_directory)
            com.flagshipserver.app.core.pq.OrgKeyKind.ARCHIVE_KEYS -> FSStrings.get(R.string.org_key_archive, scope)
            com.flagshipserver.app.core.pq.OrgKeyKind.DISK_KEY -> FSStrings.get(R.string.org_key_disk, scope)
        }

        const val DAY = 24 * 3_600_000L

        fun purposeText(tag: String): String = when (tag) {
            OrgAuthority.TAG_OVERTURN -> FSStrings.get(R.string.org_purpose_overturn)
            OrgAuthority.TAG_AUTHORITY -> FSStrings.get(R.string.org_purpose_authority)
            OrgAuthority.TAG_SEAT_GRANT -> FSStrings.get(R.string.org_purpose_grant)
            OrgAuthority.TAG_DELAYED_CHANGE -> FSStrings.get(R.string.org_purpose_delayed)
            "flagship/servers-self-delete/v1" -> FSStrings.get(R.string.org_purpose_delete_server)
            "flagship/server-update/v1" -> FSStrings.get(R.string.org_purpose_update_server)
            else -> FSStrings.get(R.string.org_purpose_other)
        }
    }
}