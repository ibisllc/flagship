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

    /** The same with extra request headers (the invite-key read proof). */
    suspend fun call(method: String, path: String, body: JsonObject?, headers: Map<String, String>): Pair<Int, JsonObject> = call(method, path, body)
}

class LiveOrgHttp(private val transport: JsonHttpTransport, private val base: () -> String = { Endpoints.controlBaseUrl }) : OrgHttp {
    override suspend fun call(method: String, path: String, body: JsonObject?): Pair<Int, JsonObject> = call(method, path, body, emptyMap())

    override suspend fun call(method: String, path: String, body: JsonObject?, headers: Map<String, String>): Pair<Int, JsonObject> {
        val res = transport.execute(
            method, base().trimEnd('/') + path,
            body = body?.toString()?.toByteArray(Charsets.UTF_8),
            contentType = if (body != null) "application/json" else null,
            extraHeaders = headers,
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

class OrgClient(
    private val http: OrgHttp,
    private val readTokens: OrgReadTokens = OrgReadTokens.shared,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    /** Every org GET but the plan and the invite offer carries the org read token; a 401 mints it again once. */
    private suspend fun exchange(method: String, path: String, body: JsonObject?, headers: Map<String, String>): Pair<Int, JsonObject> {
        val orgId = if (method == "GET") OrgReadToken.gatedOrg(path) else null
        val mint: suspend (String, JsonObject) -> Pair<Int, JsonObject> = { p, b -> http.call("POST", p, b) }
        suspend fun send(token: String?): Pair<Int, JsonObject> {
            val h = if (token != null) headers + ("authorization" to "Bearer $token") else headers
            return if (h.isEmpty()) http.call(method, path, body) else http.call(method, path, body, h)
        }
        val token = orgId?.let { readTokens.token(it, false, now(), mint) }
        val first = send(token)
        if (orgId == null || token == null || first.first != 401) return first
        val again = readTokens.token(orgId, true, now(), mint) ?: return first
        return send(again)
    }

    private suspend fun call(method: String, path: String, body: JsonObject? = null, headers: Map<String, String> = emptyMap()): JsonObject {
        val (status, json) = exchange(method, path, body, headers)
        if (status !in 200..299) throw OrgClientException(status, str(json, "code") ?: str(json, "error") ?: "")
        return json
    }

    private fun arr(o: JsonObject, k: String): List<JsonElement> = (o[k] as? JsonArray)?.toList() ?: emptyList()

    /** The chain as `GET /authority` (or the invite offer's `authority`) serves it, verified from [genesisHash]. */
    fun verifyServedChain(a: JsonObject, genesisHash: String, now: Long): OrgAuthorityState =
        OrgAuthority.verifyChain(
            arr(a, "entries").map { OrgAuthorityWire.entry(it) }, genesisHash, now,
            arr(a, "freezes").map { OrgAuthorityWire.freeze(it) }, arr(a, "overturns").map { OrgAuthorityWire.overturn(it) },
            arr(a, "vetoes").map { OrgAuthorityWire.veto(it) },
        )

    /** Fetches and verifies the org from the genesis hash this phone pinned when it joined. */
    suspend fun snapshot(orgId: String, genesisHash: String, now: Long): OrgSnapshot {
        val a = call("GET", "/api/orgs/$orgId/authority")
        val s = call("GET", "/api/orgs/$orgId/seats")
        val c = call("GET", "/api/orgs/$orgId/ceremonies")
        val freezes = arr(a, "freezes").map { OrgAuthorityWire.freeze(it) }
        val overturns = arr(a, "overturns").map { OrgAuthorityWire.overturn(it) }
        val state = verifyServedChain(a, genesisHash, now)
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

    /**
     * The invitation behind a link: the invite, its roles and the offer sealed under the offer key. `.com` serves it only
     * with a fresh invite-key signature ([inviteSecret] comes from the link key); without one it reads as no invite.
     */
    suspend fun inviteOffer(orgId: String, seatId: String, inviteSecret: ByteArray, now: Long): JsonObject =
        call("GET", "/api/orgs/$orgId/invites/$seatId", null, mapOf(
            "x-flagship-issued-at" to now.toString(),
            "x-flagship-signature" to OrgAuthority.inviteReadSignature(inviteSecret, orgId, seatId, now),
        ))

    /** Withdraws an invitation nobody was admitted on (one org admin's approval of the withdraw order). */
    suspend fun withdrawInvite(orgId: String, seatId: String, oarVersion: Long, issuedAt: Long, approval: OrgApproval) {
        call("POST", "/api/orgs/$orgId/invites/$seatId/withdraw", buildJsonObject {
            put("withdraw", buildJsonObject { put("orgId", orgId); put("seatId", seatId); put("oarVersion", oarVersion); put("issuedAt", issuedAt) })
            put("approvals", buildJsonArray { add(OrgJson.approval(approval)) })
        })
    }

    /** Invitations nobody has accepted yet (an admin may withdraw them): seat ids. */
    suspend fun pendingInvites(orgId: String): List<String> {
        val s = call("GET", "/api/orgs/$orgId/seats")
        val granted = arr(s, "grants").mapNotNull { str((it as? JsonObject)?.get("grant") as? JsonObject, "seatId") }.toSet()
        val accepted = arr(s, "accepts").mapNotNull { str((it as? JsonObject)?.get("accept") as? JsonObject, "seatId") }.toSet()
        return arr(s, "invites").mapNotNull { str((it as? JsonObject)?.get("invite") as? JsonObject, "seatId") }.filter { it !in granted && it !in accepted }
    }

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
            // Only an accept the invite key signed is offered: whoever accepted held the invitation link.
            if (!OrgAuthority.verifyInviteAccept(invite, acc, str(a, "inviteSignature"))) return@mapNotNull null
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

    /** Creates an org from its genesis (this phone the founder and only admin). */
    suspend fun create(name: String, genesis: com.flagshipserver.app.core.pq.OrgAuthorityEntry) {
        call("POST", "/api/orgs", buildJsonObject { put("name", name); put("entry", OrgJson.entry(genesis)) })
    }

    suspend fun freeze(orgId: String, f: com.flagshipserver.app.core.pq.OrgSigned<com.flagshipserver.app.core.pq.OrgSeatFreeze>) {
        call("POST", "/api/orgs/$orgId/freezes", OrgJson.freeze(f))
    }

    suspend fun createInvite(orgId: String, body: JsonObject) { call("POST", "/api/orgs/$orgId/invites", body) }

    /** The org's sealed directory entries (docs/org-directory.md §2); only the directory key opens them. */
    suspend fun directory(orgId: String): List<com.flagshipserver.app.core.pq.OrgDirectorySealed> =
        arr(call("GET", "/api/orgs/$orgId/directory"), "entries").mapNotNull { e -> runCatching { OrgJson.sealed(e as JsonObject) }.getOrNull() }

    /** Directory connectors (newest record each) and their proposals with any decision. */
    suspend fun connectors(orgId: String): List<JsonObject> = arr(call("GET", "/api/orgs/$orgId/connectors"), "connectors").mapNotNull { it as? JsonObject }

    suspend fun postConnector(orgId: String, body: JsonObject) { call("POST", "/api/orgs/$orgId/connectors", body) }

    suspend fun proposals(orgId: String): List<JsonObject> = arr(call("GET", "/api/orgs/$orgId/proposals"), "proposals").mapNotNull { it as? JsonObject }

    suspend fun decideProposal(orgId: String, decision: JsonObject, approval: OrgApproval) {
        call("POST", "/api/orgs/$orgId/proposals/decisions", buildJsonObject { put("decision", decision); put("approvals", buildJsonArray { add(OrgJson.approval(approval)) }) })
    }

    /** Members' sealed slices of the directory, each with the org admin's approval. */
    suspend fun directorySlices(orgId: String): List<JsonObject> = arr(call("GET", "/api/orgs/$orgId/directory/slices"), "slices").mapNotNull { it as? JsonObject }

    suspend fun putDirectorySlice(orgId: String, slice: com.flagshipserver.app.core.pq.OrgDirectorySlice, approval: OrgApproval) {
        call("POST", "/api/orgs/$orgId/directory/slices", buildJsonObject {
            put("slice", com.flagshipserver.app.core.pq.OrgDirectorySlices.json(slice)); put("approvals", buildJsonArray { add(OrgJson.approval(approval)) })
        })
    }

    suspend fun revoke(orgId: String, body: JsonObject) { call("POST", "/api/orgs/$orgId/revokes", body) }

    /** The Business plan as `.com` serves it (public; docs/plans-and-backup-offer.md §3). */
    suspend fun plan(orgId: String): com.flagshipserver.app.core.payments.OrgPlanServed? =
        com.flagshipserver.app.core.payments.OrgPlanServed.parse(call("GET", "/api/orgs/$orgId/plan"))

    /** The org's sealed voucher wallet, or null before the first write. */
    suspend fun voucherWallet(orgId: String): JsonObject? {
        val (status, json) = exchange("GET", "/api/orgs/$orgId/voucher-wallet", null, emptyMap())
        if (status == 404) return null
        if (status !in 200..299) throw OrgClientException(status, str(json, "code") ?: "")
        return json
    }

    /** Stores the next version under one org admin's approval; a version conflict answers the stored blob to merge. */
    suspend fun putVoucherWallet(orgId: String, blob: JsonObject, write: JsonObject, approval: OrgApproval): com.flagshipserver.app.core.payments.OrgWalletPut {
        val (status, json) = http.call("PUT", "/api/orgs/$orgId/voucher-wallet", buildJsonObject {
            put("blob", blob); put("write", write); put("approvals", buildJsonArray { add(OrgJson.approval(approval)) })
        })
        if (status in 200..299) return com.flagshipserver.app.core.payments.OrgWalletPut.Stored(num(json, "version") ?: 0)
        if (status == 409 && str(json, "code") == "version-conflict") return com.flagshipserver.app.core.payments.OrgWalletPut.Conflict(json["wallet"] as? JsonObject)
        throw OrgClientException(status, str(json, "code") ?: "")
    }

    /** Stores one sealed entry, approved by this org admin over its write form. */
    suspend fun putDirectory(orgId: String, entry: com.flagshipserver.app.core.pq.OrgDirectorySealed, approval: OrgApproval) {
        call("POST", "/api/orgs/$orgId/directory", buildJsonObject { put("entry", OrgJson.sealed(entry)); put("approvals", buildJsonArray { add(OrgJson.approval(approval)) }) })
    }
}

/** A one-admin org's genesis: the founder alone, thresholds at their floor, the bylaws' set = every admin by majority (as iOS). */
fun OrgAuthority.genesis(orgId: String, founderSeatId: String, founderBinding: PqTrust.Wire, issuedAt: Long) =
    com.flagshipserver.app.core.pq.OrgAuthorityRecord(
        orgId, 0, "0".repeat(64),
        listOf(com.flagshipserver.app.core.pq.OrgAdminEntry(founderSeatId, com.flagshipserver.app.core.pq.OrgAdminKind.ADMIN, founderBinding)),
        com.flagshipserver.app.core.pq.OrgBylaws(null, 0, 1), founderSeatId, 1, 1, 1, 1, issuedAt,
    )

/** A random 16-byte id, hex. */
fun OrgAuthority.randomId(): String = PqHex.encode(ByteArray(16).also(java.security.SecureRandom()::nextBytes))

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

    fun record(r: com.flagshipserver.app.core.pq.OrgAuthorityRecord): JsonObject = buildJsonObject {
        put("orgId", r.orgId); put("version", r.version); put("prevHash", r.prevHash)
        put("admins", buildJsonArray {
            r.admins.forEach { a ->
                add(buildJsonObject {
                    put("seatId", a.seatId); put("kind", a.kind.wire); put("binding", a.binding.toJson())
                    if (a.custody == com.flagshipserver.app.core.pq.OrgCustody.BROWSER) put("custody", "browser")
                })
            }
        })
        put("bylaws", buildJsonObject {
            val seats = r.bylaws.overturnSeats
            if (seats == null) put("overturnSeats", "*") else put("overturnSeats", buildJsonArray { seats.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
            put("overturnK", r.bylaws.overturnK); put("vetoK", r.bylaws.vetoK)
            if (r.bylaws.hardwareAdmins) put("adminCustody", "hardware")
            if (!r.bylaws.quorumHardware) put("quorumHardware", false)
        })
        put("founderSeatId", r.founderSeatId); put("kGov", r.kGov); put("kGrant", r.kGrant); put("kDestroy", r.kDestroy); put("kSite", r.kSite)
        put("issuedAt", r.issuedAt)
    }

    /** A genesis or plain entry (no notice; delayed changes are not made on Android yet). */
    fun entry(e: com.flagshipserver.app.core.pq.OrgAuthorityEntry): JsonObject = buildJsonObject {
        put("record", record(e.record)); put("via", e.via); put("approvals", buildJsonArray { e.approvals.forEach { add(approval(it)) } })
        e.overturnOf?.let { put("overturnOf", it) }
    }

    fun freeze(f: com.flagshipserver.app.core.pq.OrgSigned<com.flagshipserver.app.core.pq.OrgSeatFreeze>): JsonObject = buildJsonObject {
        put("body", buildJsonObject {
            put("orgId", f.body.orgId); put("seatId", f.body.seatId); put("untilMs", f.body.untilMs); put("oarVersion", f.body.oarVersion); put("issuedAt", f.body.issuedAt)
        })
        put("approvals", buildJsonArray { f.approvals.forEach { add(approval(it)) } })
    }

    fun roles(roles: List<com.flagshipserver.app.core.pq.OrgSeatRole>): JsonArray = buildJsonArray {
        fun strs(l: List<String>) = buildJsonArray { l.forEach { add(JsonPrimitive(it)) } }
        roles.forEach { r ->
            add(buildJsonObject {
                when (r) {
                    com.flagshipserver.app.core.pq.OrgSeatRole.Member -> put("role", "member")
                    com.flagshipserver.app.core.pq.OrgSeatRole.ServersAdd -> put("role", "servers-add")
                    is com.flagshipserver.app.core.pq.OrgSeatRole.ServerAdmin -> { put("role", "server-admin"); r.servers?.let { put("servers", strs(it)) } ?: put("servers", "*") }
                    is com.flagshipserver.app.core.pq.OrgSeatRole.ServiceAdmin -> { put("role", "service-admin"); put("apps", strs(r.apps)) }
                    is com.flagshipserver.app.core.pq.OrgSeatRole.Unlock -> { put("role", "unlock"); put("servers", strs(r.servers)) }
                }
            })
        }
    }

    fun sealed(s: com.flagshipserver.app.core.pq.OrgDirectorySealed): JsonObject = buildJsonObject {
        put("orgId", s.orgId); put("entryId", s.entryId); put("keyVersion", s.keyVersion); put("sizeBucket", s.sizeBucket); put("sealedHex", s.sealedHex); put("issuedAt", s.issuedAt)
    }

    fun sealed(o: JsonObject) = com.flagshipserver.app.core.pq.OrgDirectorySealed(
        str(o, "orgId")!!, str(o, "entryId")!!, num(o, "keyVersion")!!, num(o, "sizeBucket")!!.toInt(), str(o, "sealedHex")!!, num(o, "issuedAt")!!,
    )
}
