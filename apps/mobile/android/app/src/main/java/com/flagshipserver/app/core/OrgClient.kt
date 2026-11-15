package com.flagshipserver.app.core

import com.flagshipserver.app.core.pq.OrgApproval
import com.flagshipserver.app.core.pq.OrgAuthority
import com.flagshipserver.app.core.pq.OrgAuthorityState
import com.flagshipserver.app.core.pq.OrgAuthorityWire
import com.flagshipserver.app.core.pq.OrgSeatBook
import com.flagshipserver.app.core.pq.OrgSeatGrantBundle
import com.flagshipserver.app.core.pq.OrgSeatRevokeBundle
import com.flagshipserver.app.core.pq.OrgSigned
import com.flagshipserver.app.core.pq.OrgSeatFreeze
import com.flagshipserver.app.core.pq.PqHybrid
import com.flagshipserver.app.core.pq.PqTrust
import com.flagshipserver.app.core.pq.PqHex
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The `.com` org routes (docs/enterprise-accounts.md §6, §7; packages/control-plane/src/orgs.ts),
 * Kotlin twin of iOS `OrgClient`. Every object read is re-verified on this phone
 * (`OrgAuthority.verifyChain`, `buildSeatBook`) before a screen uses it.
 */
class OrgClientException(val status: Int, val code: String) : Exception(code.ifEmpty { "http $status" })

/** One HTTP exchange with `.com`: status and the JSON object it answered (empty when none). */
fun interface OrgHttp {
    suspend fun call(method: String, path: String, body: JsonObject?): Pair<Int, JsonObject>
}

class LiveOrgHttp(private val transport: JsonHttpTransport, private val base: () -> String = { Endpoints.controlBaseUrl }) : OrgHttp {
    override suspend fun call(method: String, path: String, body: JsonObject?): Pair<Int, JsonObject> {
        val res = transport.execute(
            method, base().trimEnd('/') + path,
            body = body?.toString()?.toByteArray(Charsets.UTF_8),
            contentType = if (body != null) "application/json" else null,
            accept = (100..599).toSet(),
        )
        val json = runCatching { Json.parseToJsonElement(String(res.body, Charsets.UTF_8)) as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())
        return res.status to json
    }
}

data class OrgCeremony(val sha256: String, val order: String, val payload: JsonObject, val approvals: List<OrgApproval>) {
    val purpose: String get() = order.substringBefore('|')
}

class OrgSnapshot(
    val name: String,
    val state: OrgAuthorityState,
    val book: OrgSeatBook,
    val freezes: List<OrgSigned<OrgSeatFreeze>>,
    val ceremonies: List<OrgCeremony>,
    val grants: List<OrgSeatGrantBundle>,
    val revokes: List<OrgSeatRevokeBundle>,
)

/** A person who accepted an invitation and waits for an admin to compare the code and admit them. */
class OrgPendingJoin(
    val seatId: String,
    val invite: JsonObject,
    val roles: JsonArray,
    val accept: JsonObject,
    val memberBinding: PqTrust.Wire,
    val adminBinding: PqTrust.Wire?,
) {
    /** The 6-digit code both phones show (`flagship/org-seat-sas/v1`). */
    val sas: String?
        get() = runCatching {
            OrgAuthority.seatSas(str(accept, "inviteSha256")!!, str(accept, "memberKeyId")!!, str(accept, "adminKeyId") ?: "")
        }.getOrNull()
}

internal fun str(o: JsonObject?, k: String): String? = (o?.get(k) as? JsonPrimitive)?.takeIf { it.isString }?.content
internal fun num(o: JsonObject?, k: String): Long? = (o?.get(k) as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull()

class OrgClient(private val http: OrgHttp) {
    private suspend fun call(method: String, path: String, body: JsonObject? = null): JsonObject {
        val (status, json) = http.call(method, path, body)
        if (status !in 200..299) throw OrgClientException(status, str(json, "code") ?: str(json, "error") ?: "")
        return json
    }

    private fun arr(o: JsonObject, k: String): List<JsonElement> = (o[k] as? JsonArray)?.toList() ?: emptyList()

    /** Fetches and verifies the org from the genesis hash this phone pinned when it joined. */
    suspend fun snapshot(orgId: String, genesisHash: String, now: Long): OrgSnapshot {
        val a = call("GET", "/api/orgs/$orgId/authority")
        val s = call("GET", "/api/orgs/$orgId/seats")
        val c = call("GET", "/api/orgs/$orgId/ceremonies")
        val entries = arr(a, "entries").map { OrgAuthorityWire.entry(it) }
        val freezes = arr(a, "freezes").map { OrgAuthorityWire.freeze(it) }
        val overturns = arr(a, "overturns").map { OrgAuthorityWire.overturn(it) }
        val vetoes = arr(a, "vetoes").map { OrgAuthorityWire.veto(it) }
        val state = OrgAuthority.verifyChain(entries, genesisHash, now, freezes, overturns, vetoes)
        val grants = arr(s, "grants").mapNotNull { runCatching { OrgAuthorityWire.grantBundle(it) }.getOrNull() }
        val revokes = arr(s, "revokes").mapNotNull { runCatching { OrgAuthorityWire.revokeBundle(it) }.getOrNull() }
        val book = OrgAuthority.buildSeatBook(state, grants, revokes, freezes, overturns, now)
        val ceremonies = arr(c, "ceremonies").mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            runCatching {
                OrgCeremony(str(o, "sha256")!!, str(o, "order")!!, (o["payload"] as? JsonObject) ?: JsonObject(emptyMap()), OrgAuthorityWire.approvals(o["approvals"]))
            }.getOrNull()
        }
        val name = str(a["org"] as? JsonObject, "name") ?: ""
        return OrgSnapshot(name, state, book, freezes, ceremonies, grants, revokes)
    }

    /** The invitation behind a link: the invite, its roles and the offer sealed under the link key. */
    suspend fun inviteOffer(orgId: String, seatId: String): JsonObject = call("GET", "/api/orgs/$orgId/invites/$seatId")

    /** The person's acceptance, signed with their seat member key. */
    suspend fun accept(orgId: String, seatId: String, body: JsonObject) { call("POST", "/api/orgs/$orgId/invites/$seatId/accept", body) }

    /** Acceptances not yet granted: the admin's "compare the code, then admit" list. */
    suspend fun pendingJoins(orgId: String): List<OrgPendingJoin> {
        val s = call("GET", "/api/orgs/$orgId/seats")
        val granted = arr(s, "grants").mapNotNull { str((it as? JsonObject)?.get("grant") as? JsonObject, "seatId") }.toSet()
        val invites = arr(s, "invites").mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            str(o["invite"] as? JsonObject, "seatId")?.let { it to o }
        }.toMap()
        return arr(s, "accepts").mapNotNull { e ->
            val a = e as? JsonObject ?: return@mapNotNull null
            val acc = a["accept"] as? JsonObject ?: return@mapNotNull null
            val seatId = str(acc, "seatId") ?: return@mapNotNull null
            if (seatId in granted) return@mapNotNull null
            val inv = invites[seatId] ?: return@mapNotNull null
            val invite = inv["invite"] as? JsonObject ?: return@mapNotNull null
            val member = runCatching { PqTrust.pqKeyBindingFromWire(a["memberBinding"]) }.getOrNull() ?: return@mapNotNull null
            val admin = (a["adminBinding"] as? JsonObject)?.let { runCatching { PqTrust.pqKeyBindingFromWire(it) }.getOrNull() }
            OrgPendingJoin(seatId, invite, (inv["roles"] as? JsonArray) ?: JsonArray(emptyList()), acc, member, admin)
        }
    }

    /** Key-ring versions and KEM keys (`GET /keys`) and the org's servers (`GET /servers`), verified into a rotation plan. */
    suspend fun rotationPlan(snapshot: OrgSnapshot, now: Long): com.flagshipserver.app.core.pq.OrgRotationPlan {
        val orgId = snapshot.state.orgId
        val keys = call("GET", "/api/orgs/$orgId/keys")
        val servers = call("GET", "/api/orgs/$orgId/servers")
        return com.flagshipserver.app.core.pq.OrgRotation.planFromServed(snapshot.state, snapshot.book, keys, servers, snapshot.revokes, snapshot.grants, now)
    }

    suspend fun postKeyRing(orgId: String, bundle: JsonObject) { call("POST", "/api/orgs/$orgId/keys", bundle) }

    suspend fun postSeatKem(orgId: String, bundle: JsonObject) { call("POST", "/api/orgs/$orgId/seat-kems", bundle) }

    suspend fun grant(orgId: String, body: JsonObject) { call("POST", "/api/orgs/$orgId/seats", body) }

    suspend fun openCeremony(orgId: String, order: String, payload: JsonObject, approval: OrgApproval) {
        call("POST", "/api/orgs/$orgId/ceremonies", buildJsonObject {
            put("order", order); put("payload", payload); put("approvals", buildJsonArray { add(OrgJson.approval(approval)) })
        })
    }

    suspend fun approve(orgId: String, sha256: String, approval: OrgApproval) {
        call("POST", "/api/orgs/$orgId/ceremonies/$sha256/approvals", buildJsonObject { put("approval", OrgJson.approval(approval)) })
    }
}

/** The seat member key from the person's UMK: its hybrid secret and its `org-seat-member` binding. */
fun OrgAuthority.memberKey(umk: ByteArray, orgId: String, seatId: String, issuedAt: Long): Pair<PqTrust.Wire, ByteArray> {
    val (ed, ml) = memberSeeds(umk, orgId)
    val kp = PqHybrid.hybridSigKeygen(ed, ml)
    val st = PqTrust.Statement("org-seat-member", seatSubject(orgId, seatId), PqHex.encode(kp.publicKey.copyOfRange(0, 32)),
        PqHex.encode(kp.publicKey.copyOfRange(32, kp.publicKey.size)), issuedAt)
    val binding = PqTrust.signPqKeyBinding(st) { m -> PqHybrid.hybridSign(kp.secretKey, PqTrust.TAG_PQ_KEY_BINDING, m) }
    return binding to kp.secretKey
}

object OrgJson {
    fun approval(a: OrgApproval): JsonObject = buildJsonObject {
        put("orgId", a.orgId); put("oarVersion", a.oarVersion); put("purposeTag", a.purposeTag); put("orderSha256", a.orderSha256)
        put("seatId", a.seatId); put("adminKeyId", a.adminKeyId); put("notAfter", a.notAfter); put("issuedAt", a.issuedAt); put("signature", a.signature)
    }
}
