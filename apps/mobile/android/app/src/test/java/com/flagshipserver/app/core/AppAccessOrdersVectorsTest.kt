// Runs every case and every refusal in
// packages/protocol/test-vectors/app-access-orders/vectors.json
// (docs/service-access-gating.md, "Account members, ranks and who may change
// them"), read from disk so a drift fails here.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AppAccountMember
import com.flagshipserver.app.api.AppMember
import com.flagshipserver.app.api.AppMemberGrant
import com.flagshipserver.app.api.AppMemberInviteRole
import com.flagshipserver.app.api.AppMembersResponse
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class AppAccessOrdersVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/app-access-orders/vectors.json"
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        runCatching { javaClass.protectionDomain?.codeSource?.location?.toURI()?.let { candidates.add(File(it)) } }
        for (start in candidates) {
            var dir: File? = start.absoluteFile
            var hops = 0
            while (dir != null && hops < 14) {
                val f = File(dir, rel)
                if (f.isFile) return f
                dir = dir.parentFile
                hops += 1
            }
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    private val root: JsonObject by lazy { Json.parseToJsonElement(vectorsFile().readText()).jsonObject }
    private fun JsonObject.s(k: String): String = this[k]!!.jsonPrimitive.content
    private fun JsonObject.at(): Long = this["issuedAt"]!!.jsonPrimitive.long
    private fun section(name: String, part: String) = root[name]!!.jsonObject[part]!!.jsonArray.map { it.jsonObject }

    private val key by lazy { Ed25519Sign(HexUtil.decode(root.s("signerSeedHex"))!!) }
    private val pub by lazy { HexUtil.decode(root.s("signerPub"))!! }

    @Test fun theSignerSeedMatchesItsPub() {
        assertEquals(root.s("signerPub"), HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(HexUtil.decode(root.s("signerSeedHex"))!!).publicKey))
    }

    private fun check(c: JsonObject, bytes: ByteArray, sigHex: String) {
        assertEquals(c.toString(), c.s("canonical"), String(bytes, Charsets.UTF_8))
        assertEquals(c.toString(), c.s("signature"), sigHex)
        Ed25519Verify(pub).verify(HexUtil.decode(sigHex)!!, c.s("canonical").toByteArray(Charsets.UTF_8))
    }

    private fun refuses(c: JsonObject, build: () -> Unit) {
        try {
            build()
            fail("should refuse: ${c.s("why")}")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test fun rankOrders() {
        val cases = section("rank", "cases")
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val o = AppAccessOrders.Rank(c.s("serviceRef"), c.s("target"), c.s("rank"), c.at())
            check(c, AppAccessOrders.canonicalBytes(o), AppAccessOrders.signHex(key, o))
        }
        val invalid = section("rank", "invalid")
        assertTrue(invalid.isNotEmpty())
        for (c in invalid) refuses(c) { AppAccessOrders.canonicalBytes(AppAccessOrders.Rank(c.s("serviceRef"), c.s("target"), c.s("rank"), c.at())) }
    }

    @Test fun modeOrders() {
        val cases = section("mode", "cases")
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val o = AppAccessOrders.Mode(c.s("serviceRef"), c.s("mode"), c.at())
            check(c, AppAccessOrders.canonicalBytes(o), AppAccessOrders.signHex(key, o))
        }
        val invalid = section("mode", "invalid")
        assertTrue(invalid.isNotEmpty())
        for (c in invalid) refuses(c) { AppAccessOrders.canonicalBytes(AppAccessOrders.Mode(c.s("serviceRef"), c.s("mode"), c.at())) }
    }

    @Test fun removeOrders() {
        val cases = section("remove", "cases")
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val o = AppAccessOrders.Remove(c.s("serviceRef"), c.s("aid"), c.at())
            check(c, AppAccessOrders.canonicalBytes(o), AppAccessOrders.signHex(key, o))
        }
        val invalid = section("remove", "invalid")
        assertTrue(invalid.isNotEmpty())
        for (c in invalid) refuses(c) { AppAccessOrders.canonicalBytes(AppAccessOrders.Remove(c.s("serviceRef"), c.s("aid"), c.at())) }
    }

    @Test fun ranksAreThreeAndALegacyOwnerReadsAsMaster() {
        assertEquals(listOf("member", "manager", "master"), AppMemberRole.entries.map { it.wire })
        assertEquals(listOf("Member", "Manager", "Master"), AppMemberRole.entries.map { it.label })
        assertEquals(listOf(AppMemberRole.MASTER), AppMemberRole.entries.filter { it.crowned })
        assertEquals(AppMemberRole.MASTER, AppMemberRole.fromWire("owner"))
        assertNull(AppMemberRole.fromWire("refused"))
        assertEquals(listOf(false, true, true), AppMemberRole.entries.map { it.managerClass })
    }

    @Test fun rowRolesTargetsAndAccountMembers() {
        val sam = "ab".repeat(32)
        val old = "cd".repeat(32)
        val me = "a1".repeat(32)
        val m = AppMembersResponse(
            serviceId = "a--notes", mode = "open", defaultRole = "member",
            descriptions = mapOf("manager" to "Runs tournaments"),
            accountMembers = listOf(
                AppAccountMember(kind = "device", deviceId = "0".repeat(32), devicePub = me, tier = "member", rank = "manager"),
                AppAccountMember(kind = "device", deviceId = "1".repeat(32), devicePub = "b2".repeat(32), tier = "member", rank = null, set = true, refused = true),
                AppAccountMember(kind = "co-manager", shareId = "0f1e2d3c4b5a69788796a5b4c3d2e1f0", label = "Sam's family", rank = "master"),
            ),
            members = listOf(
                AppMember(sam, "manager", listOf(AppMemberGrant("sam", "manager"), AppMemberGrant("family", "member"))),
                AppMember(old, "master", emptyList(), direct = "master"),
            ),
            invites = listOf(AppMemberInviteRole("sam", "manager", true), AppMemberInviteRole("family", "member", true, creatorPub = me)),
        )
        assertEquals("Runs tournaments", m.description("manager"))
        assertEquals(null, m.description("master"))
        assertEquals("manager", m.rowRole("sam", sam))
        assertEquals("invite:sam", m.roleTarget("sam", sam))
        assertEquals("master", m.rowRole("old", old))
        assertEquals("aid:$old", m.roleTarget("old", old))
        assertEquals("member", m.rowRole("new", null))
        val others = m.otherGrants("sam", sam) { if (it == "family") "Family" else null }
        assertEquals("also in Family: Member", AppMembersResponse.alsoInText(others) { AppMemberRole.fromWire(it)!!.label })

        assertEquals(AppMemberRole.MANAGER, m.self(me.uppercase())!!.appRank)
        assertNull(m.self("ff".repeat(32)))
        assertEquals("device:$me", m.accountMembers[0].rankTarget)
        assertTrue(m.accountMembers[1].isRefused)
        assertNull(m.accountMembers[1].appRank)
        assertEquals("share:0f1e2d3c4b5a69788796a5b4c3d2e1f0", m.accountMembers[2].rankTarget)
        assertEquals(me, m.invite("family")!!.creatorPub)
    }

    @Test fun membersJsonFromTheBoxDecodes() {
        val json = Json { ignoreUnknownKeys = true }
        val r = json.decodeFromString(
            AppMembersResponse.serializer(),
            """{"serviceId":"a--notes","mode":"open","roles":["member","manager","master"],"defaultRole":"member","descriptions":{},
               "accountMembers":[
                 {"kind":"device","deviceId":"${"0".repeat(32)}","devicePub":"${"a1".repeat(32)}","tier":"admin","rank":"master","set":false,"refused":false},
                 {"kind":"co-manager","shareId":"0f1e2d3c4b5a69788796a5b4c3d2e1f0","label":"Sam","rank":null,"set":true,"refused":true}],
               "members":[],
               "invites":[{"inviteId":"i1","role":"member","set":false,"tier":"member","creatorPub":"${"a1".repeat(32)}","creatorDeviceId":"${"0".repeat(32)}"},
                          {"inviteId":"i2","role":"member","set":false,"tier":"admin","creatorPub":null,"creatorDeviceId":null}]}""",
        )
        assertEquals(2, r.accountMembers.size)
        assertEquals("admin", r.accountMembers[0].tier)
        assertTrue(r.accountMembers[1].isRefused)
        assertEquals("0".repeat(32), r.invite("i1")!!.creatorDeviceId)
        assertNull(r.invite("i2")!!.creatorPub)
    }
}
