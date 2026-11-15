package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test

// The Kotlin half of packages/protocol/test-vectors/org-authority/vectors.json: canonical forms,
// SAS, member seeds, every chain, seat-book and predicate case.
class OrgAuthorityVectorsTest {
    private val v = PqVectors.load("packages/protocol/test-vectors/org-authority/vectors.json")

    private fun resolve(e: JsonElement?): JsonElement? = when (e) {
        is JsonArray -> JsonArray(e.map { resolve(it)!! })
        is JsonObject -> when {
            e["\$key"] != null -> v["keys"]!!.jsonObject[e["\$key"]!!.jsonPrimitive.content]!!.jsonObject["binding"]
            e["\$approval"] != null -> v["approvals"]!!.jsonArray[e["\$approval"]!!.jsonPrimitive.int]
            else -> JsonObject(e.mapValues { resolve(it.value)!! })
        }
        else -> e
    }

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun code(f: () -> Unit): String = try { f(); "ok" } catch (e: OrgAuthorityException) { e.code }
    private fun expected(c: JsonObject): String {
        val e = c["expect"]!!.jsonObject
        return if (e["ok"]!!.jsonPrimitive.boolean) "ok" else e.s("code")
    }
    private fun list(c: JsonObject, k: String) = (c[k] as? JsonArray) ?: JsonArray(emptyList())

    private fun chain(c: JsonObject, upTo: Int? = null): OrgAuthorityState {
        val entries = c["entries"]!!.jsonArray.map { OrgAuthorityWire.entry(it) }.let { if (upTo != null) it.take(upTo) else it }
        return OrgAuthority.verifyChain(
            entries, (c["genesisHash"] as? JsonPrimitive)?.content ?: v.s("genesisHash"), c["now"]!!.jsonPrimitive.long,
            list(c, "freezes").map { OrgAuthorityWire.freeze(it) }, list(c, "overturns").map { OrgAuthorityWire.overturn(it) },
            list(c, "vetoes").map { OrgAuthorityWire.veto(it) },
        )
    }

    private fun base() = chain(resolve(v["chains"]!!.jsonArray[0])!!.jsonObject, 2)
    private val chainNow get() = v["chains"]!!.jsonArray[0].jsonObject["now"]!!.jsonPrimitive.long

    private fun book(raw: JsonElement, st: OrgAuthorityState): OrgSeatBook {
        val c = resolve(raw)!!.jsonObject
        return OrgAuthority.buildSeatBook(st, c["grants"]!!.jsonArray.map { OrgAuthorityWire.grantBundle(it) },
            c["revokes"]!!.jsonArray.map { OrgAuthorityWire.revokeBundle(it) }, now = chainNow)
    }

    @Test
    fun canonicalSasAndSeeds() {
        for (c in v["canonical"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(c.s("name"), c.s("sha256"), OrgAuthority.sha256Hex(c.s("bytes").toByteArray(Charsets.UTF_8)))
        }
        val s = v["sas"]!!.jsonObject
        assertEquals(s.s("code"), OrgAuthority.seatSas(s.s("inviteSha256"), s.s("memberKeyId"), s.s("adminKeyId")))
        val m = v["memberSeeds"]!!.jsonObject
        val (ed, ml) = OrgAuthority.memberSeeds(PqHex.decode(m.s("umkHex"))!!, m.s("orgId"))
        assertEquals(m.s("edSeedHex"), PqHex.encode(ed))
        assertEquals(m.s("mldsaSeedHex"), PqHex.encode(ml))
        val scoped = v["canonical"]!!.jsonArray.map { it.jsonObject }.first { it.s("name") == "roles scoped" }
        val roles = listOf(OrgSeatRole.ServerAdmin(listOf("home.acme.flagship.services")), OrgSeatRole.ServiceAdmin(listOf("acme--wiki")))
        assertEquals(scoped.s("bytes"), String(OrgAuthority.canonicalRoles(roles), Charsets.UTF_8))
    }

    /** Browser custody (docs/webapp-key-custody.md items 1 and 3): the forms this port writes match the vectors. */
    @Test
    fun custodyCanonicalForms() {
        val canon = v["canonical"]!!.jsonArray.associate { it.jsonObject.s("name") to it.jsonObject.s("bytes") }
        val joined = resolve(v["chains"]!!.jsonArray.first { it.jsonObject.s("name").startsWith("two browser admins join") })!!.jsonObject
        val rec = OrgAuthorityWire.entry(joined["entries"]!!.jsonArray[1]).record
        assertEquals(2, rec.admins.count { it.custody == OrgCustody.BROWSER })
        assertEquals(canon["admins with browser custody"], String(OrgAuthority.canonicalAdmins(rec.admins), Charsets.UTF_8))
        val by = rec.bylaws.copy(hardwareAdmins = true, quorumHardware = false)
        assertEquals(canon["bylaws hardware admins, browser quorums"], String(OrgAuthority.canonicalBylaws(by), Charsets.UTF_8))
        val book = v["seatBooks"]!!.jsonArray.first { it.jsonObject.s("name").contains("browser key") }.jsonObject
        val g = OrgAuthorityWire.grantBundle(resolve(book["grants"]!!.jsonArray[0]))
        assertEquals(OrgCustody.BROWSER, g.grant.custody)
        assertEquals(canon["grant browser"], String(OrgAuthority.canonical(g.grant), Charsets.UTF_8))
    }

    @Test
    fun chains() {
        for (raw in v["chains"]!!.jsonArray) {
            val c = resolve(raw)!!.jsonObject
            var st: OrgAuthorityState? = null
            val got = code { st = chain(c) }
            assertEquals(c.s("name"), expected(c), got)
            if (got == "ok") assertEquals(c.s("name"), c["currentVersion"]!!.jsonPrimitive.long, st!!.current.version)
        }
    }

    @Test
    fun seatBooks() {
        val st = base()
        for (raw in v["seatBooks"]!!.jsonArray) {
            val c = raw.jsonObject
            val b = book(raw, st)
            assertEquals(c.s("name"), c["expectSeats"]!!.jsonArray.map { it.jsonPrimitive.content }.sorted(), b.seats.keys.sorted())
            val refused = c["expectRefused"]!!.jsonArray.map { "${it.jsonObject.s("seatId")}:${it.jsonObject.s("code")}" }
            assertEquals(c.s("name"), refused, b.refused.map { "${it.first}:${it.second}" })
        }
    }

    @Test
    fun authorize() {
        val st = base()
        val b = book(v["seatBooks"]!!.jsonArray[0], st)
        for (raw in v["authorize"]!!.jsonArray) {
            val c = resolve(raw)!!.jsonObject
            var scoped: String? = "unset"
            val got = code {
                scoped = OrgAuthority.authorize(st, b, OrgAuthorityWire.action(c["action"]), c.s("order").toByteArray(Charsets.UTF_8),
                    OrgAuthorityWire.approvals(c["approvals"]), c["now"]!!.jsonPrimitive.long).second
            }
            assertEquals(c.s("name"), expected(c), got)
            if (got == "ok") assertEquals(c.s("name"), (c["expect"]!!.jsonObject["scopedSeat"] as? JsonPrimitive)?.takeIf { it.isString }?.content, scoped)
        }
    }
}
