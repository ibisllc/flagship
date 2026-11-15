package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

// The Kotlin half of packages/protocol/test-vectors/org-directory/vectors.json (tools/org-directory-vectors.ts):
// bodies, entry keys, sealing with a fixed nonce, the write form, refusals and the newest-entry rule.
class OrgDirectoryVectorsTest {
    private val v = PqVectors.load("packages/protocol/test-vectors/org-directory/vectors.json")
    private val orgId = v["orgId"]!!.jsonPrimitive.content

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun JsonObject.l(k: String) = this[k]!!.jsonPrimitive.long
    private fun entry(o: JsonObject) = OrgDirectoryEntry(o.s("seatId"), o.s("pendingId"), o.s("pseudonym"), o.s("displayName"), o.s("email"),
        o.s("externalId"), o.s("source"), o["groups"]!!.jsonArray.map { it.jsonPrimitive.content }, o.l("updatedAt"))
    private fun sealed(o: JsonObject) = OrgDirectorySealed(o.s("orgId"), o.s("entryId"), o.l("keyVersion"), o["sizeBucket"]!!.jsonPrimitive.int, o.s("sealedHex"), o.l("issuedAt"))
    private fun bytes(h: String) = PqHex.decode(h)!!
    private fun utf8(b: ByteArray) = String(b, Charsets.UTF_8)

    @Test fun entries() {
        for (c in v["entries"]!!.jsonArray.map { it.jsonObject }) {
            val name = c.s("name")
            val e = entry(c["entry"]!!.jsonObject)
            val s = sealed(c["sealed"]!!.jsonObject)
            val key = bytes(c.s("directoryKeyHex"))
            assertEquals(name, c.s("body"), utf8(OrgDirectory.canonicalBody(e)))
            assertEquals(name, c.s("entryKeyHex"), PqHex.encode(OrgDirectory.entryKey(key, orgId, c.s("entryId"), c.l("keyVersion"))))
            assertEquals(name, s, OrgDirectory.seal(orgId, c.s("entryId"), c.l("keyVersion"), key, e, s.issuedAt, bytes(s.sealedHex).copyOfRange(0, 12)))
            assertEquals(name, c.s("write"), utf8(OrgDirectory.canonicalWrite(s)))
            assertEquals(name, e, OrgDirectory.open(s, key))
            assertEquals(name, e, OrgDirectory.parseBody(c.s("body").toByteArray()))
        }
    }

    @Test fun refusals() {
        for (c in v["opens"]!!.jsonArray.map { it.jsonObject }) {
            try { OrgDirectory.open(sealed(c["sealed"]!!.jsonObject), bytes(c.s("directoryKeyHex"))); fail(c.s("name")) } catch (_: OrgAuthorityException) {}
        }
        for (c in v["badBodies"]!!.jsonArray.map { it.jsonObject }) {
            try { OrgDirectory.parseBody(c.s("body").toByteArray()); fail(c.s("name")) } catch (_: OrgAuthorityException) {}
        }
        val e = entry(v["entries"]!!.jsonArray[0].jsonObject["entry"]!!.jsonObject)
        try { OrgDirectory.canonicalBody(e.copy(pseudonym = "é")); fail("non-NFC") } catch (_: OrgAuthorityException) {}
        assertEquals(11, utf8(OrgDirectory.canonicalBody(e.copy(pseudonym = "a|b", groups = listOf("x|y")))).split("|").size)
    }

    @Test fun newest() {
        val n = v["newest"]!!.jsonObject
        val keys = n["keys"]!!.jsonObject.entries.associate { it.key.toLong() to bytes(it.value.jsonPrimitive.content) }
        val list = n["sealed"]!!.jsonArray.map { sealed(it.jsonObject) }
        val expect = n["expect"]!!.jsonObject
        for (order in listOf(list, list.reversed())) {
            assertEquals(expect.s("pseudonym"), OrgDirectory.openAll(orgId, order, keys).first[expect.s("seat")]?.entry?.pseudonym)
        }
    }

    @Test fun connectorsAndProposals() {
        val c = v["connectors"]!!.jsonObject
        val cb = c["connector"]!!.jsonObject
        val conn = OrgConnectors.connector(cb["connector"]!!.jsonObject)
        assertEquals(c.s("connectorBytes"), utf8(OrgConnectors.canonical(conn)))
        assertEquals(conn.connectorKeyId, OrgConnectors.connectorKeyId(bytes(cb.s("connectorPubHex"))))
        val now = c.l("now")
        for (p in c["proposals"]!!.jsonArray.map { it.jsonObject }) {
            val b = p["bundle"]!!.jsonObject
            val prop = OrgConnectors.verifyProposal(cb, b, p.s("rolesHash"), now)
            assertEquals(p.s("bytes"), utf8(OrgConnectors.canonical(prop)))
            for (a in c["admins"]!!.jsonArray.map { it.jsonObject }) {
                val kp = PqHybrid.hybridSealKeygen(bytes(a.s("kemSeedHex")))
                assertEquals(p.s("payload"), utf8(OrgConnectors.openProposal(b, a.s("recipient"), kp.secretKey)))
            }
            val moved = JsonObject(b + ("proposal" to JsonObject(b["proposal"]!!.jsonObject + ("subject" to kotlinx.serialization.json.JsonPrimitive("ee".repeat(16))))))
            try { OrgConnectors.verifyProposal(cb, moved, p.s("rolesHash"), now); fail("moved") } catch (_: OrgAuthorityException) {}
        }
        val d = c["decision"]!!.jsonObject
        val s = d["statement"]!!.jsonObject
        assertEquals(d.s("bytes"), utf8(OrgConnectors.canonicalDecision(s.s("orgId"), s.s("proposalId"), s.s("decision"), s.s("refSha256"), s.l("issuedAt"))))
    }
}
