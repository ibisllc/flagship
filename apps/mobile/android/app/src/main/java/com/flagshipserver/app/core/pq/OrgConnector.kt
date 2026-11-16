package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Directory connectors and their proposals (packages/protocol/src/orgConnector.ts; docs/org-directory.md
 * §2-§4), byte for byte, pinned by test-vectors/org-directory. A connector only proposes; an admin opens
 * a proposal's sealed entry with the seat KEM key, carries it out with the usual approvals and records
 * the decision.
 */
data class OrgConnector(
    val orgId: String, val connectorId: String, val kind: String, val serverDomain: String, val connectorKeyId: String,
    val scopes: List<String>, val mappingSha256: String, val status: String, val issuedAt: Long,
)

data class OrgProposal(
    val orgId: String, val proposalId: String, val connectorId: String, val kind: String, val subject: String,
    val rolesHash: String, val sealedSha256: String, val issuedAt: Long,
)

object OrgConnectors {
    const val TAG_CONNECTOR = "flagship/org-connector/v1"
    const val TAG_PROPOSAL = "flagship/org-proposal/v1"
    val SCOPES = listOf("propose-invite", "propose-offboard", "update-entry")
    private val HEX16 = Regex("^[0-9a-f]{32}$")
    private val HEX32 = Regex("^[0-9a-f]{64}$")
    private val DOMAIN = Regex("^[a-z0-9][a-z0-9.-]{0,252}$")
    private val SEAT = Regex("^seat:[0-9a-f]{32}$")

    private fun need(ok: Boolean, code: String, d: String = "") { if (!ok) throw OrgAuthorityException(code, d) }
    private fun join(vararg p: Any): ByteArray = p.joinToString("|").toByteArray(Charsets.UTF_8)
    private fun JsonObject.s(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw OrgAuthorityException("malformed", k)
    private fun JsonObject.n(k: String) = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull() ?: throw OrgAuthorityException("malformed", k)

    fun connector(o: JsonObject) = OrgConnector(o.s("orgId"), o.s("connectorId"), o.s("kind"), o.s("serverDomain"), o.s("connectorKeyId"),
        (o["scopes"] as? JsonArray ?: throw OrgAuthorityException("malformed", "scopes")).map { (it as JsonPrimitive).content }, o.s("mappingSha256"), o.s("status"), o.n("issuedAt"))

    fun proposal(o: JsonObject) = OrgProposal(o.s("orgId"), o.s("proposalId"), o.s("connectorId"), o.s("kind"), o.s("subject"), o.s("rolesHash"), o.s("sealedSha256"), o.n("issuedAt"))

    fun canonical(c: OrgConnector): ByteArray {
        need(HEX16.matches(c.orgId) && HEX16.matches(c.connectorId) && c.kind in listOf("scim", "ldap", "custom") && DOMAIN.matches(c.serverDomain) &&
            HEX32.matches(c.connectorKeyId) && HEX32.matches(c.mappingSha256) && c.status in listOf("active", "paused", "retired") && c.issuedAt >= 0, "malformed", "connector")
        need(c.scopes.isNotEmpty() && c.scopes.all { it in SCOPES } && c.scopes == c.scopes.toSortedSet().toList(), "malformed", "scopes")
        return join(TAG_CONNECTOR, c.orgId, c.connectorId, c.kind, c.serverDomain, c.connectorKeyId, c.scopes.joinToString(","), c.mappingSha256, c.status, c.issuedAt)
    }

    fun connectorKeyId(pub: ByteArray): String {
        need(pub.size == 1984, "malformed", "connector key")
        return OrgAuthority.keyIdHex(PqHex.encode(pub.copyOfRange(0, 32)), PqHex.encode(pub.copyOfRange(32, pub.size)))
    }

    fun scopeOf(kind: String) = when (kind) { "offboard" -> "propose-offboard"; "entry-update" -> "update-entry"; else -> "propose-invite" }

    fun canonical(p: OrgProposal): ByteArray {
        need(HEX16.matches(p.orgId) && HEX16.matches(p.proposalId) && HEX16.matches(p.connectorId) && HEX16.matches(p.subject) &&
            HEX32.matches(p.sealedSha256) && p.issuedAt >= 0, "malformed", "proposal")
        need(p.kind in listOf("invite", "offboard", "role-change", "entry-update"), "malformed", "kind")
        val needsRoles = p.kind == "invite" || p.kind == "role-change"
        need(if (needsRoles) HEX32.matches(p.rolesHash) else p.rolesHash.isEmpty(), "malformed", "rolesHash")
        return join(TAG_PROPOSAL, p.orgId, p.proposalId, p.connectorId, p.kind, p.subject, p.rolesHash, p.sealedSha256, p.issuedAt)
    }

    private fun recipients(b: JsonObject): List<Triple<String, String, String>> =
        (b["recipients"] as? JsonArray ?: throw OrgAuthorityException("malformed", "recipients")).map {
            val o = it as JsonObject
            Triple(o.s("recipient"), o.s("kemKeyId"), o.s("sealedHex"))
        }

    fun recipientsHash(r: List<Triple<String, String, String>>): String {
        need(r.isNotEmpty() && r.size <= 64 && r.map { it.first }.toSet().size == r.size, "malformed", "recipients")
        val lines = r.map { (rec, kem, sealedHex) ->
            need(SEAT.matches(rec) && HEX32.matches(kem), "malformed", "recipient")
            val s = PqHex.decode(sealedHex)
            need(s != null && s.isNotEmpty() && sealedHex.length <= 32768, "malformed", "sealedHex")
            "$rec:$kem:${OrgAuthority.sha256Hex(s!!)}"
        }
        return OrgAuthority.sha256Hex("$TAG_PROPOSAL|recipients|${lines.sorted().joinToString(";")}".toByteArray(Charsets.UTF_8))
    }

    /** Checks a proposal bundle against its connector bundle (both wire JSON); [rolesHash] of the proposal's roles, "" when none. */
    fun verifyProposal(connectorBundle: JsonObject, bundle: JsonObject, rolesHash: String, now: Long): OrgProposal {
        val c = connector(connectorBundle["connector"] as JsonObject)
        val p = proposal(bundle["proposal"] as JsonObject)
        val msg = canonical(p)
        need(p.orgId == c.orgId && p.connectorId == c.connectorId, "wrong-org", "another connector")
        need(c.status == "active", "seat-revoked", "connector ${c.status}")
        need(scopeOf(p.kind) in c.scopes, "scope", p.kind)
        need(p.issuedAt <= now + 5 * 60_000, "future")
        need(p.rolesHash == rolesHash, "order-mismatch", "roles")
        need(recipientsHash(recipients(bundle)) == p.sealedSha256, "order-mismatch", "sealed copies")
        val pub = PqHex.decode(connectorBundle.s("connectorPubHex")) ?: throw OrgAuthorityException("bad-signature")
        val sig = PqHex.decode(bundle.s("signature")) ?: throw OrgAuthorityException("bad-signature")
        need(connectorKeyId(pub) == c.connectorKeyId, "binding", "connector key id")
        try { PqHybrid.hybridVerify(pub, TAG_PROPOSAL, msg, sig) } catch (_: Exception) { throw OrgAuthorityException("bad-signature") }
        return p
    }

    /** Opens this admin's copy (the proposed directory entry body) with the seat KEM secret. */
    fun openProposal(bundle: JsonObject, recipient: String, kemSecret: ByteArray): ByteArray {
        val p = proposal(bundle["proposal"] as JsonObject)
        val mine = recipients(bundle).firstOrNull { it.first == recipient } ?: throw OrgAuthorityException("seat-unknown", "not a recipient")
        val ctx = listOf(p.orgId, p.proposalId, recipient).map { it.toByteArray(Charsets.UTF_8) }
        return PqHybrid.hybridOpen(kemSecret, TAG_PROPOSAL, ctx, PqHex.decode(mine.third)!!).plaintext
    }

    fun canonicalDecision(orgId: String, proposalId: String, decision: String, refSha256: String, issuedAt: Long): ByteArray {
        need(HEX16.matches(orgId) && HEX16.matches(proposalId) && decision in listOf("done", "declined") && HEX32.matches(refSha256) && issuedAt >= 0, "malformed", "decision")
        need((decision == "declined") == (refSha256 == "0".repeat(64)), "malformed", "refSha256")
        return join(TAG_PROPOSAL, "decision", orgId, proposalId, decision, refSha256, issuedAt)
    }
}

/** The admin console's side of connectors: the mapping digest, a new connector and its sealed setup (as iOS). */
object OrgConnectorConsole {
    /** JSON with keys sorted at every level, as `orgConnectorMappingSha256` hashes it. */
    fun canonicalJson(e: kotlinx.serialization.json.JsonElement): String = when (e) {
        is JsonObject -> e.keys.sorted().joinToString(",", "{", "}") { k -> JsonPrimitive(k).toString() + ":" + canonicalJson(e[k]!!) }
        is JsonArray -> e.joinToString(",", "[", "]") { canonicalJson(it) }
        else -> e.toString()
    }

    fun mappingSha256(mapping: JsonObject): String = OrgAuthority.sha256Hex(canonicalJson(mapping).toByteArray(Charsets.UTF_8))

    fun defaultMapping(): JsonObject = kotlinx.serialization.json.buildJsonObject {
        put("attributes", kotlinx.serialization.json.buildJsonObject {
            put("email", JsonPrimitive("userName")); put("displayName", JsonPrimitive("displayName")); put("externalId", JsonPrimitive("externalId"))
        })
        put("groups", JsonObject(emptyMap()))
        put("defaultRoles", JsonArray(listOf(kotlinx.serialization.json.buildJsonObject { put("role", JsonPrimitive("member")) })))
    }

    class Made(val connector: OrgConnector, val pubHex: String, val seedsHex: String)

    fun newConnector(orgId: String, connectorId: String, kind: String, serverDomain: String, mapping: JsonObject, issuedAt: Long): Made {
        val rnd = java.security.SecureRandom()
        val ed = ByteArray(32).also(rnd::nextBytes)
        val ml = ByteArray(32).also(rnd::nextBytes)
        val kp = PqHybrid.hybridSigKeygen(ed, ml)
        val c = OrgConnector(orgId, connectorId, kind, serverDomain, OrgConnectors.connectorKeyId(kp.publicKey), OrgConnectors.SCOPES,
            mappingSha256(mapping), "active", issuedAt)
        OrgConnectors.canonical(c)
        return Made(c, PqHex.encode(kp.publicKey), PqHex.encode(ed + ml))
    }

    fun sealSetup(c: OrgConnector, boxKem: OrgVerifiedKem, setup: JsonObject, issuedAt: Long): JsonObject {
        if (boxKem.recipient != "box:${c.serverDomain}") throw OrgAuthorityException("scope", "not the connector's box")
        val opts = PqHybrid.HybridSealOptions(purpose = OrgConnectors.TAG_CONNECTOR, senderKeyId = ByteArray(32), issuedAt = issuedAt)
        val sealed = PqHybrid.hybridSeal(boxKem.kemPub, opts, listOf(c.orgId, c.connectorId, c.serverDomain).map { it.toByteArray(Charsets.UTF_8) },
            canonicalJson(setup).toByteArray(Charsets.UTF_8))
        return kotlinx.serialization.json.buildJsonObject { put("kemKeyId", JsonPrimitive(boxKem.kemKeyId)); put("sealedHex", JsonPrimitive(PqHex.encode(sealed))) }
    }

    fun json(c: OrgConnector): JsonObject = kotlinx.serialization.json.buildJsonObject {
        put("orgId", JsonPrimitive(c.orgId)); put("connectorId", JsonPrimitive(c.connectorId)); put("kind", JsonPrimitive(c.kind))
        put("serverDomain", JsonPrimitive(c.serverDomain)); put("connectorKeyId", JsonPrimitive(c.connectorKeyId))
        put("scopes", JsonArray(c.scopes.map { JsonPrimitive(it) })); put("mappingSha256", JsonPrimitive(c.mappingSha256))
        put("status", JsonPrimitive(c.status)); put("issuedAt", JsonPrimitive(c.issuedAt))
    }
}

/** A stored connector's standing (packages/protocol/src/orgConnector.ts `orgConnectorStanding`). */
data class OrgConnectorStanding(val state: String, val approvers: List<String>, val leftAt: Long?, val suspendAt: Long?)

object OrgConnectorStandings {
    const val GRACE_MS = 7 * 24 * 3_600_000L

    fun standing(st: OrgAuthorityState, book: OrgSeatBook, connectorBundle: JsonObject, now: Long): OrgConnectorStanding {
        val c = OrgConnectors.connector(connectorBundle["connector"] as JsonObject)
        val approvals = OrgAuthorityWire.approvals(connectorBundle["approvals"])
        val at = approvals.firstOrNull()?.oarVersion ?: -1
        OrgRotation.recordedApprovals(st, book, OrgConnectors.canonical(c), approvals, at, now, null)
        val signers = approvals.map { it.seatId }.distinct()
        val isAdmin = { s: String -> st.current.admins.any { it.seatId == s && it.kind == OrgAdminKind.ADMIN } }
        val departed = signers.filter { !isAdmin(it) }.map { s ->
            st.records.firstOrNull { r -> r.version > at && r.admins.none { it.seatId == s && it.kind == OrgAdminKind.ADMIN } }?.issuedAt ?: st.current.issuedAt
        }
        if (departed.size < signers.size) return OrgConnectorStanding("ok", signers, null, null)
        val left = departed.max()
        return OrgConnectorStanding(if (now < left + GRACE_MS) "needs-reapproval" else "suspended", signers, left, left + GRACE_MS)
    }

    private fun info(orgId: String, connectorId: String, v: Long): ByteArray {
        if (!Regex("^[0-9a-f]{32}$").matches(orgId) || !Regex("^[0-9a-f]{32}$").matches(connectorId) || v < 0) throw OrgAuthorityException("malformed", "mapping")
        return listOf(OrgConnectors.TAG_CONNECTOR, "mapping", orgId, connectorId, v).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    private fun key(directoryKey: ByteArray, info: ByteArray): ByteArray {
        val g = org.bouncycastle.crypto.generators.HKDFBytesGenerator(org.bouncycastle.crypto.digests.SHA256Digest())
        g.init(org.bouncycastle.crypto.params.HKDFParameters(directoryKey, ByteArray(0), info))
        return ByteArray(32).also { g.generateBytes(it, 0, 32) }
    }

    /** The mapping sealed under the org directory key for the admins' editor (`sealOrgConnectorMapping`). */
    fun sealMapping(orgId: String, connectorId: String, directoryKey: ByteArray, keyVersion: Long, mapping: JsonObject, nonce: ByteArray? = null): JsonObject {
        val i = info(orgId, connectorId, keyVersion)
        val n = nonce ?: ByteArray(12).also(java.security.SecureRandom()::nextBytes)
        val c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        c.init(javax.crypto.Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec(key(directoryKey, i), "AES"), javax.crypto.spec.GCMParameterSpec(128, n))
        c.updateAAD(i)
        val ct = c.doFinal(OrgConnectorConsole.canonicalJson(mapping).toByteArray(Charsets.UTF_8))
        return kotlinx.serialization.json.buildJsonObject { put("keyVersion", JsonPrimitive(keyVersion)); put("sealedHex", JsonPrimitive(PqHex.encode(n + ct))) }
    }

    fun openMapping(orgId: String, connectorId: String, directoryKey: ByteArray, sealed: JsonObject): JsonObject {
        val v = (sealed["keyVersion"] as? JsonPrimitive)?.content?.toLongOrNull() ?: throw OrgAuthorityException("malformed", "mapping")
        val b = PqHex.decode((sealed["sealedHex"] as? JsonPrimitive)?.content ?: "") ?: throw OrgAuthorityException("malformed", "mapping")
        val i = info(orgId, connectorId, v)
        return try {
            val c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
            c.init(javax.crypto.Cipher.DECRYPT_MODE, javax.crypto.spec.SecretKeySpec(key(directoryKey, i), "AES"), javax.crypto.spec.GCMParameterSpec(128, b.copyOfRange(0, 12)))
            c.updateAAD(i)
            kotlinx.serialization.json.Json.parseToJsonElement(String(c.doFinal(b, 12, b.size - 12), Charsets.UTF_8)) as JsonObject
        } catch (e: Exception) { throw OrgAuthorityException("malformed", "mapping does not open") }
    }
}
