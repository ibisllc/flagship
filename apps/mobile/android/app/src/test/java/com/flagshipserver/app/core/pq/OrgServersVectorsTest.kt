package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.fail
import org.junit.Test

// The Kotlin half of packages/protocol/test-vectors/org-servers/vectors.json (tools/org-servers-vectors.ts):
// canonical forms, server codes, the org recipe, the seat KEM seed, opening key-ring copies, the audit
// log chain. Built on test-vectors/org-authority.
class OrgServersVectorsTest {
    private val a = PqVectors.load("packages/protocol/test-vectors/org-authority/vectors.json")
    private val v = PqVectors.load("packages/protocol/test-vectors/org-servers/vectors.json")

    private fun resolve(e: JsonElement?): JsonElement? = when (e) {
        is JsonArray -> JsonArray(e.map { resolve(it)!! })
        is JsonObject -> when {
            e["\$key"] != null -> a["keys"]!!.jsonObject[e["\$key"]!!.jsonPrimitive.content]!!.jsonObject["binding"]
            e["\$approval"] != null -> a["approvals"]!!.jsonArray[e["\$approval"]!!.jsonPrimitive.int]
            else -> JsonObject(e.mapValues { resolve(it.value)!! })
        }
        else -> e
    }

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun JsonObject.l(k: String) = this[k]!!.jsonPrimitive.long
    private fun canonical(name: String) = v["canonical"]!!.jsonArray.map { it.jsonObject }.first { it.s("name") == name }.s("bytes")
    private fun utf8(b: ByteArray) = String(b, Charsets.UTF_8)

    private fun code(o: JsonObject) = OrgServerCode(o.s("orgId"), o.s("genesisHash"), o.s("serial"), o.s("serverName"), o.s("serverDomain"),
        o.s("delegatedPubKeyHex"), o.l("issuedAt"), o.l("expiresAt"))

    private fun ring(o: JsonObject) = OrgKeyRing(o.s("orgId"), OrgKeyKind.of(o.s("kind")), o.s("scope"), o.l("version"), o.s("prevSha256"),
        o.s("keyCommitment"), o.s("recipientsHash"), o["retired"]!!.jsonArray.map { it.jsonPrimitive.content }, o.l("oarVersion"), o.l("issuedAt"))

    private fun blob(b: JsonObject) = OrgServers.canonicalInstallBlob(b.s("orgId"), b.s("genesisHash"), b.s("orgName"), b.s("serverName"), b.s("serverDomain"),
        b.s("registrationUrl"), b.s("installerGitRef"), b.s("phoneDelegatedPubKey"), code(b["code"]!!.jsonObject), b.s("bootUnlockMode"), b.s("diskEncryption"))

    private fun ctx(now: Long): Pair<OrgAuthorityState, OrgSeatBook> {
        val chain = resolve(a["chains"]!!.jsonArray[0])!!.jsonObject
        val entries = chain["entries"]!!.jsonArray.take(2).map { OrgAuthorityWire.entry(it) }
        val st = OrgAuthority.verifyChain(entries, a.s("genesisHash"), now, emptyList(), emptyList(), emptyList())
        val book = resolve(a["seatBooks"]!!.jsonArray[0])!!.jsonObject
        return st to OrgAuthority.buildSeatBook(st, book["grants"]!!.jsonArray.map { OrgAuthorityWire.grantBundle(it) }, emptyList(), now = now)
    }

    @Test
    fun canonicalForms() {
        for (c in v["canonical"]!!.jsonArray.map { it.jsonObject }) assertEquals(c.s("name"), c.s("sha256"), OrgAuthority.sha256Hex(c.s("bytes").toByteArray(Charsets.UTF_8)))
        assertEquals(canonical("server code"), utf8(OrgServers.canonicalServerCode(code(v["serverCodes"]!!.jsonArray[0].jsonObject["code"]!!.jsonObject))))
        val r = v["register"]!!.jsonObject["request"]!!.jsonObject
        assertEquals(canonical("server register"), utf8(OrgServers.canonicalServerRegister(r.s("orgId"), r.s("serial"), r.s("serverDomain"), r.s("codeSha256"),
            r.s("serverIdentityPubKeyHex"), r.l("issuedAt"), r.s("nonceHex"))))
        val k = v["kems"]!!.jsonObject["seat"]!!.jsonArray[0].jsonObject["statement"]!!.jsonObject
        assertEquals(canonical("seat kem"), utf8(OrgServers.canonicalSeatKem(k.s("orgId"), k.s("seatId"), k.s("kemKeyId"), k.l("issuedAt"))))
        val b = v["kems"]!!.jsonObject["box"]!!.jsonArray[0].jsonObject["statement"]!!.jsonObject
        assertEquals(canonical("box kem"), utf8(OrgServers.canonicalBoxKem(b.s("orgId"), b.s("serverDomain"), b.s("kemKeyId"), b.l("issuedAt"))))
        assertEquals(canonical("key ring v2"), utf8(OrgServers.canonicalKeyRing(ring(v["opens"]!!.jsonArray[0].jsonObject["ring"]!!.jsonObject["ring"]!!.jsonObject))))
        assertEquals(canonical("install blob"), utf8(blob(v["installBlobs"]!!.jsonArray[0].jsonObject["blob"]!!.jsonObject)))
        val s = v["audit"]!!.jsonObject["export"]!!.jsonObject["statement"]!!.jsonObject
        assertEquals(canonical("audit export"), utf8(OrgServers.canonicalAuditExport(s.s("orgId"), s.l("oarVersion"), s.s("oarHash"), s.l("logSeq"), s.s("logHeadHash"), s.l("issuedAt"))))
    }

    @Test
    fun serverCodes() {
        for (c in v["serverCodes"]!!.jsonArray.map { it.jsonObject }) {
            val now = c.l("now")
            val (st, book) = ctx(now)
            val e = c["expect"]!!.jsonObject
            val want = if (e["ok"]!!.jsonPrimitive.boolean) "ok" else e.s("code")
            val got = try {
                OrgServers.verifyServerCode(st, book, code(c["code"]!!.jsonObject), c["approvals"]!!.jsonArray.map { OrgAuthorityWire.approval(it) }, now); "ok"
            } catch (x: OrgAuthorityException) { x.code }
            assertEquals(c.s("name"), want, got)
        }
    }

    @Test
    fun recipeRefusals() {
        val blobs = v["installBlobs"]!!.jsonArray.map { it.jsonObject["blob"]!!.jsonObject }
        try { blob(blobs[3]); fail("a recipe whose code names another server") } catch (_: OrgAuthorityException) {}
        assertNotEquals(utf8(blob(blobs[0])), utf8(blob(blobs[1])))
    }

    @Test
    fun seatKemSeedAndOpens() {
        val s = v["seatKemSeed"]!!.jsonObject
        val seed = OrgServers.seatKemSeed(PqHex.decode(s.s("umkHex"))!!, v.s("orgId"))
        assertEquals(s.s("seedHex"), PqHex.encode(seed))
        assertEquals(s.s("kemKeyId"), OrgServers.kemKeyIdHex(PqHybrid.hybridSealKeygen(seed).publicKey))
        for (o in v["opens"]!!.jsonArray.map { it.jsonObject }) {
            val bundle = o["ring"]!!.jsonObject
            val r = ring(bundle["ring"]!!.jsonObject)
            val recipients = bundle["recipients"]!!.jsonArray.map { val x = it.jsonObject; OrgKeyRecipient(x.s("recipient"), x.s("kemKeyId"), x.s("sealedHex")) }
            assertEquals(o.s("name"), r.recipientsHash, OrgServers.recipientsHash(recipients))
            val secret = PqHybrid.hybridSealKeygen(PqHex.decode(o.s("kemSeedHex"))!!).secretKey
            if (o["error"] != null) {
                val got = try { OrgServers.openKeyRing(r, recipients, o.s("recipient"), secret); "ok" } catch (x: OrgAuthorityException) { x.code }
                assertEquals(o.s("name"), o.s("error"), got)
            } else {
                assertEquals(o.s("name"), o.s("keyHex"), PqHex.encode(OrgServers.openKeyRing(r, recipients, o.s("recipient"), secret)))
            }
        }
    }

    @Test
    fun auditLogChain() {
        val x = v["audit"]!!.jsonObject["export"]!!.jsonObject
        var prev = "0".repeat(64)
        for (e in x["log"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(prev, e.s("prevHash"))
            val h = OrgServers.logEntryHash(x.s("orgId"), e.l("seq"), prev, e.s("kind"), e.s("refSha256"), e.l("at"))
            assertEquals(e.s("entryHash"), h)
            prev = h
        }
        assertEquals(x["statement"]!!.jsonObject.s("logHeadHash"), prev)
    }
}
