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
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    fun reloadSeats() { _seats.value = keys.seats() }

    suspend fun load(seat: OrgSeatRecord) {
        _phase.value = Phase.Loading
        try {
            _snapshot.value = client.snapshot(seat.orgId, seat.genesisHash, now())
            _pendingJoins.value = runCatching { client.pendingJoins(seat.orgId) }.getOrDefault(emptyList())
            _phase.value = Phase.Loaded
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

    companion object {
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
