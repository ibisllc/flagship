package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Planning a key rotation on a phone (packages/protocol/src/orgKeyRing.ts: verifyOrgSeatKem,
 * verifyOrgBoxKem, orgKeyRecipientAllowed, buildOrgKeyRings, orgPendingRotations,
 * planOrgKeyRecipients, rotateOrgKey). `wallet` (the org's voucher wallet) is org-wide like the
 * directory key: org admins only, never a box. Everything `.com` serves is checked here under the chain
 * and seat book this phone verified, so a new key is sealed only to recipients the phone itself
 * accepts and the "who left" list never rests on `.com`'s word.
 */
data class OrgKeyRingBundle(val ring: OrgKeyRing, val recipients: List<OrgKeyRecipient>, val approvals: List<OrgApproval>)

data class OrgPendingRotation(val seatId: String, val leftAt: Long, val keys: List<Pair<OrgKeyKind, String>>)

class OrgVerifiedKem(val recipient: String, val kemPub: ByteArray, val kemKeyId: String, val issuedAt: Long) {
    fun key() = OrgKemKey(recipient, kemPub, kemKeyId)
}

class OrgKeyContext(
    val state: OrgAuthorityState,
    val book: OrgSeatBook,
    val kems: Map<String, OrgVerifiedKem>,
    val servers: Set<String>,
    val now: Long,
)

/** What `.com` served (`GET /keys`, `GET /servers`, `GET /seats`), verified into a plan. */
class OrgRotationPlan(val ctx: OrgKeyContext, val chains: Map<String, List<OrgKeyRingBundle>>, val pending: List<OrgPendingRotation>)

object OrgRotation {
    private fun need(ok: Boolean, code: String, detail: String = "") { if (!ok) throw OrgAuthorityException(code, detail) }
    private fun orgWide(k: OrgKeyKind) = k == OrgKeyKind.CGK || k == OrgKeyKind.DIRECTORY_KEY || k == OrgKeyKind.WALLET
    fun chainId(kind: OrgKeyKind, scope: String) = "${kind.wire}|$scope"

    // ── KEM statements ──────────────────────────────────────────────────

    private fun seatSigningKey(st: OrgAuthorityState, book: OrgSeatBook, seatId: String, now: Long): PqTrust.VerifiedBinding? {
        if (st.current.admins.any { it.seatId == seatId }) return st.binding(st.current.version, seatId)
        if (seatId in book.revoked) return null
        val seat = book.seats[seatId] ?: return null
        return if (seat.grant.expiresAt <= now) null else seat.member
    }

    fun verifySeatKem(st: OrgAuthorityState, book: OrgSeatBook, statement: JsonObject, kemPubHex: String, signatureHex: String, now: Long): OrgVerifiedKem {
        val orgId = statement.s("orgId"); val seatId = statement.s("seatId"); val kemKeyId = statement.s("kemKeyId"); val issuedAt = statement.n("issuedAt")
        val msg = OrgServers.canonicalSeatKem(orgId, seatId, kemKeyId, issuedAt)
        need(orgId == st.orgId, "wrong-org")
        need(issuedAt <= now + OrgAuthority.MAX_SKEW_MS, "future")
        val kemPub = PqHex.decode(kemPubHex) ?: throw OrgAuthorityException("binding", "kem key")
        need(OrgServers.kemKeyIdHex(kemPub) == kemKeyId, "binding", "kem key id")
        val key = seatSigningKey(st, book, seatId, now) ?: throw OrgAuthorityException("seat-unknown", seatId)
        val sig = PqHex.decode(signatureHex)
        need(sig != null && sig.size == PqHybrid.HYBRID_SIG_LEN, "bad-signature")
        try { PqHybrid.hybridVerify(key.hybridPublicKey, OrgServers.TAG_SEAT_KEM, msg, sig!!) } catch (e: Exception) { throw OrgAuthorityException("bad-signature") }
        return OrgVerifiedKem("seat:$seatId", kemPub, kemKeyId, issuedAt)
    }

    fun verifyBoxKem(orgId: String, statement: JsonObject, kemPubHex: String, signatureHex: String, stkPubHex: String, now: Long): OrgVerifiedKem {
        val sOrg = statement.s("orgId"); val domain = statement.s("serverDomain"); val kemKeyId = statement.s("kemKeyId"); val issuedAt = statement.n("issuedAt")
        val msg = OrgServers.canonicalBoxKem(sOrg, domain, kemKeyId, issuedAt)
        need(sOrg == orgId, "wrong-org")
        need(issuedAt <= now + OrgAuthority.MAX_SKEW_MS, "future")
        val kemPub = PqHex.decode(kemPubHex) ?: throw OrgAuthorityException("binding", "kem key")
        need(OrgServers.kemKeyIdHex(kemPub) == kemKeyId, "binding", "kem key id")
        val sig = PqHex.decode(signatureHex)
        val pub = PqHex.decode(stkPubHex)
        need(sig != null && sig.size == 64 && pub != null && pub.size == 32 && PqHybrid.ed25519VerifyStrict(sig, msg, pub), "bad-signature")
        return OrgVerifiedKem("box:$domain", kemPub, kemKeyId, issuedAt)
    }

    // ── who may hold what ───────────────────────────────────────────────

    fun recipientAllowed(ctx: OrgKeyContext, kind: OrgKeyKind, scope: String, recipient: String): Boolean {
        if (recipient.startsWith("box:")) {
            val d = recipient.removePrefix("box:")
            if (d !in ctx.servers) return false
            return when (kind) {
                OrgKeyKind.CGK -> true
                OrgKeyKind.DIRECTORY_KEY, OrgKeyKind.WALLET -> false
                else -> d == scope
            }
        }
        val seatId = recipient.removePrefix("seat:")
        if (ctx.state.current.admins.any { it.seatId == seatId && it.kind == OrgAdminKind.ADMIN }) return true
        if (seatId in ctx.book.revoked) return false
        val seat = ctx.book.seats[seatId] ?: return false
        if (seat.grant.expiresAt <= ctx.now) return false
        if (ctx.book.freezes.any { it.seatId == seatId && it.issuedAt <= ctx.now && ctx.now < it.untilMs }) return false
        if (orgWide(kind)) return false
        return seat.roles.any { r ->
            (r is OrgSeatRole.ServerAdmin && (r.servers == null || scope in r.servers)) ||
                (kind == OrgKeyKind.DISK_KEY && r is OrgSeatRole.Unlock && scope in r.servers)
        }
    }

    private fun departed(st: OrgAuthorityState, book: OrgSeatBook, seatId: String): Boolean {
        if (seatId in book.revoked) return true
        if (st.current.admins.any { it.seatId == seatId }) return false
        return st.records.any { r -> r.admins.any { it.seatId == seatId } }
    }

    /** `verifyOrgRecordedApprovals`: the approvals as of the record they name. */
    internal fun recordedApprovals(st: OrgAuthorityState, book: OrgSeatBook, order: ByteArray, approvals: List<OrgApproval>, oarVersion: Long, now: Long, scoped: OrgAction?) {
        val r = st.record(oarVersion) ?: throw OrgAuthorityException("stale-oar")
        need(approvals.isNotEmpty(), "threshold", "no approvals")
        val frozen = { s: String, t: Long -> book.freezes.any { it.seatId == s && it.issuedAt <= t && t < it.untilMs } }
        val keyOf = { s: String ->
            if (r.admins.any { it.seatId == s }) st.binding(oarVersion, s)
            else if (scoped == null || s in book.revoked) null
            else book.seats[s]?.admin
        }
        val signers = OrgAuthority.checkApprovals(approvals, st.orgId, oarVersion, order, now, keyOf, frozen)
        val admins = signers.filter { s -> r.admins.firstOrNull { it.seatId == s }?.kind == OrgAdminKind.ADMIN }
        if (admins.isNotEmpty() && admins.size == signers.size) return
        need(scoped != null && signers.size == 1, "scope", "one org admin, or one scoped seat alone")
        val seat = book.seats[signers[0]]
        need(seat != null && seat.grant.expiresAt > now && OrgAuthority.covers(seat, scoped!!), "scope", signers[0])
    }

    private fun verifyStored(ctx: OrgKeyContext, b: OrgKeyRingBundle, prev: OrgKeyRing?) {
        val r = b.ring
        val order = OrgServers.canonicalKeyRing(r)
        need(r.orgId == ctx.state.orgId, "wrong-org")
        need(r.issuedAt <= ctx.now + OrgAuthority.MAX_SKEW_MS, "future")
        if (prev != null) {
            need(r.version == prev.version + 1, "version-gap")
            need(r.prevSha256 == OrgServers.keyRingSha256(prev), "prev-hash")
            need(prev.kind == r.kind && prev.scope == r.scope, "malformed", "another key")
            need(r.issuedAt > prev.issuedAt, "not-after-previous")
        } else {
            need(r.version == 1L && r.prevSha256 == "0".repeat(64), "version-gap")
        }
        need(OrgServers.recipientsHash(b.recipients) == r.recipientsHash, "order-mismatch", "recipients")
        need(b.recipients.none { it.recipient.startsWith("seat:") && it.recipient.removePrefix("seat:") in r.retired }, "scope", "a retired seat is a recipient")
        recordedApprovals(ctx.state, ctx.book, order, b.approvals, r.oarVersion, ctx.now, if (r.scope == "*") null else OrgAction.Operate(r.scope))
    }

    /** Every stored version, chain by chain; a version that fails stops its chain. */
    fun buildChains(ctx: OrgKeyContext, bundles: List<OrgKeyRingBundle>): Map<String, List<OrgKeyRingBundle>> {
        val out = mutableMapOf<String, List<OrgKeyRingBundle>>()
        for ((id, list) in bundles.groupBy { chainId(it.ring.kind, it.ring.scope) }) {
            val ok = mutableListOf<OrgKeyRingBundle>()
            for (b in list.sortedBy { it.ring.version }) {
                try { verifyStored(ctx, b, ok.lastOrNull()?.ring); ok += b } catch (_: Exception) { break }
            }
            if (ok.isNotEmpty()) out[id] = ok
        }
        return out
    }

    private fun rotationDone(chains: Map<String, List<OrgKeyRingBundle>>, kind: OrgKeyKind, scope: String, seatId: String, leftAt: Long): Boolean =
        (chains[chainId(kind, if (orgWide(kind)) "*" else scope)] ?: emptyList()).any { b ->
            b.ring.issuedAt >= leftAt && b.recipients.none { it.recipient == "seat:$seatId" }
        }

    /** `orgPendingRotations`: what every departed seat still leaves to rotate. */
    fun pending(st: OrgAuthorityState, book: OrgSeatBook, chains: Map<String, List<OrgKeyRingBundle>>, revokes: List<OrgSeatRevokeBundle>, grants: List<OrgSeatGrantBundle>): List<OrgPendingRotation> {
        val left = mutableMapOf<String, Long>()
        for (r in revokes) if (r.seatId in book.revoked) left[r.seatId] = minOf(left[r.seatId] ?: Long.MAX_VALUE, r.issuedAt)
        val current = st.current.admins.map { it.seatId }.toSet()
        for (i in 1 until st.records.size) {
            val before = st.records[i - 1]; val at = st.records[i]
            for (a in before.admins) {
                if (at.admins.none { it.seatId == a.seatId } && a.seatId !in current && a.seatId !in left) left[a.seatId] = at.issuedAt
            }
        }
        val out = mutableListOf<OrgPendingRotation>()
        for ((seatId, leftAt) in left) {
            val keys = mutableListOf<Pair<OrgKeyKind, String>>()
            for (chain in chains.values) {
                val r = chain[0].ring
                if (chain.none { b -> b.recipients.any { it.recipient == "seat:$seatId" } }) continue
                if (!rotationDone(chains, r.kind, r.scope, seatId, leftAt)) keys += r.kind to r.scope
            }
            val unlock = grants.filter { it.grant.seatId == seatId }.flatMap { g -> g.roles.filterIsInstance<OrgSeatRole.Unlock>().flatMap { it.servers } }.toSet()
            for (s in unlock) {
                if (!rotationDone(chains, OrgKeyKind.DISK_KEY, s, seatId, leftAt) && keys.none { it.first == OrgKeyKind.DISK_KEY && it.second == s }) keys += OrgKeyKind.DISK_KEY to s
            }
            if (keys.isNotEmpty()) out += OrgPendingRotation(seatId, leftAt, keys.sortedBy { it.first.wire + it.second })
        }
        return out.sortedWith(compareBy({ it.leftAt }, { it.seatId }))
    }

    /** The recipients a new version goes to: every verified KEM key allowed to hold it now, minus [retired]. */
    fun planRecipients(ctx: OrgKeyContext, kind: OrgKeyKind, scope: String, retired: List<String>): List<OrgKemKey> =
        ctx.kems.values
            .filter { !(it.recipient.startsWith("seat:") && it.recipient.removePrefix("seat:") in retired) }
            .filter { recipientAllowed(ctx, kind, scope, it.recipient) }
            .sortedBy { it.recipient }
            .map { it.key() }

    /**
     * One rotation ready for `POST /api/orgs/<id>/keys`: a fresh random key sealed to the planned
     * recipients, naming the departed seats it answers. [approve] signs the ring with this phone's
     * seat admin key (one org admin, or one scoped seat for a server's own keys, is enough).
     */
    fun rotate(plan: OrgRotationPlan, kind: OrgKeyKind, scope: String, issuedAt: Long, key: ByteArray, approve: (ByteArray, Long) -> OrgApproval): OrgKeyRingBundle {
        val s = if (orgWide(kind)) "*" else scope
        val prev = plan.chains[chainId(kind, s)]?.lastOrNull()?.ring
        val retired = plan.pending.filter { p -> p.keys.any { it.first == kind && it.second == s } }.map { it.seatId }
        val recipients = planRecipients(plan.ctx, kind, s, retired)
        need(recipients.isNotEmpty(), "seat-unknown", "no recipient may hold this key")
        val oar = plan.ctx.state.current.version
        val (ring, sealed) = OrgServers.buildKeyRing(plan.ctx.state.orgId, kind, s, prev, key, recipients, retired, oar, issuedAt)
        return OrgKeyRingBundle(ring, sealed, listOf(approve(OrgServers.canonicalKeyRing(ring), oar)))
    }

    /** Verifies what `GET /keys`, `GET /servers` and `GET /seats` served into a plan. */
    fun planFromServed(st: OrgAuthorityState, book: OrgSeatBook, keys: JsonObject, servers: JsonObject, revokes: List<OrgSeatRevokeBundle>, grants: List<OrgSeatGrantBundle>, now: Long): OrgRotationPlan {
        val live = (servers["servers"] as? JsonArray ?: JsonArray(emptyList())).mapNotNull { it as? JsonObject }
            .filter { it["revoked"].let { r -> r == null || r is kotlinx.serialization.json.JsonNull || (r is JsonPrimitive && r.content == "false") } }
        val stk = live.mapNotNull { o -> runCatching { o.s("serverDomain") to o.s("identityPubKeyHex") }.getOrNull() }.toMap()
        val found = mutableListOf<OrgVerifiedKem>()
        for (e in (keys["seatKems"] as? JsonArray ?: JsonArray(emptyList()))) {
            runCatching { val o = e as JsonObject; found += verifySeatKem(st, book, o["statement"] as JsonObject, o.s("kemPubHex"), o.s("signature"), now) }
        }
        for (e in (keys["boxKems"] as? JsonArray ?: JsonArray(emptyList()))) {
            runCatching {
                val o = e as JsonObject
                val stmt = o["statement"] as JsonObject
                val pub = stk[stmt.s("serverDomain")] ?: error("no server")
                found += verifyBoxKem(st.orgId, stmt, o.s("kemPubHex"), o.s("signature"), pub, now)
            }
        }
        val newest = mutableMapOf<String, OrgVerifiedKem>()
        for (k in found) { val p = newest[k.recipient]; if (p == null || p.issuedAt < k.issuedAt) newest[k.recipient] = k }
        val ctx = OrgKeyContext(st, book, newest, stk.keys, now)
        val bundles = (keys["rings"] as? JsonArray ?: JsonArray(emptyList())).mapNotNull { runCatching { bundle(it) }.getOrNull() }
        val chains = buildChains(ctx, bundles)
        return OrgRotationPlan(ctx, chains, pending(st, book, chains, revokes, grants))
    }

    // ── wire ────────────────────────────────────────────────────────────

    private fun bad(w: String): Nothing = throw OrgAuthorityException("malformed", w)
    private fun JsonObject.s(k: String): String = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: bad(k)
    private fun JsonObject.n(k: String): Long = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull() ?: bad(k)

    fun bundle(e: JsonElement): OrgKeyRingBundle {
        val o = e as? JsonObject ?: bad("bundle")
        val r = o["ring"] as? JsonObject ?: bad("ring")
        val retired = (r["retired"] as? JsonArray ?: bad("retired")).map { (it as? JsonPrimitive)?.content ?: bad("retired") }
        val ring = OrgKeyRing(r.s("orgId"), OrgKeyKind.of(r.s("kind")), r.s("scope"), r.n("version"), r.s("prevSha256"), r.s("keyCommitment"),
            r.s("recipientsHash"), retired, r.n("oarVersion"), r.n("issuedAt"))
        val recipients = (o["recipients"] as? JsonArray ?: bad("recipients")).map { x ->
            val xo = x as? JsonObject ?: bad("recipient")
            OrgKeyRecipient(xo.s("recipient"), xo.s("kemKeyId"), xo.s("sealedHex"))
        }
        return OrgKeyRingBundle(ring, recipients, OrgAuthorityWire.approvals(o["approvals"]))
    }

    fun bundleJson(b: OrgKeyRingBundle): JsonObject = buildJsonObject {
        put("ring", buildJsonObject {
            val r = b.ring
            put("orgId", r.orgId); put("kind", r.kind.wire); put("scope", r.scope); put("version", r.version); put("prevSha256", r.prevSha256)
            put("keyCommitment", r.keyCommitment); put("recipientsHash", r.recipientsHash)
            put("retired", buildJsonArray { r.retired.forEach { add(JsonPrimitive(it)) } })
            put("oarVersion", r.oarVersion); put("issuedAt", r.issuedAt)
        })
        put("recipients", buildJsonArray {
            b.recipients.forEach { x -> add(buildJsonObject { put("recipient", x.recipient); put("kemKeyId", x.kemKeyId); put("sealedHex", x.sealedHex) }) }
        })
        put("approvals", buildJsonArray { b.approvals.forEach { add(com.flagshipserver.app.core.OrgJson.approval(it)) } })
    }
}
