// Runs every case and every refusal in
// packages/protocol/test-vectors/app-member-role/vectors.json
// (docs/service-access-gating.md, "Open mode + members"), read from disk so a
// drift fails here.

package com.flagshipserver.app.core

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
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class AppMemberRoleVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/app-member-role/vectors.json"
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
    private fun order(c: JsonObject) = AppMemberRoleOrder.Order(
        c.s("serverDomain"), c.s("serviceId"), c.s("target"), c.s("role"), c["issuedAt"]!!.jsonPrimitive.long,
    )

    @Test fun signsEveryCaseWithTheProtocolIrk() {
        val seed = ServerKeys.deriveProtocolIrkSeed(HexUtil.decode(root.s("umkSeedHex"))!!)
        val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
        assertEquals(root.s("pub"), HexUtil.encode(pub))
        val cases = root["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val signed = AppMemberRoleOrder.sign(Ed25519Sign(seed), order(c))
            assertEquals(c.toString(), c.s("canonical"), String(AppMemberRoleOrder.canonicalBytes(signed.order), Charsets.UTF_8))
            // Ed25519 is deterministic: the pinned signature exactly.
            assertEquals(c.toString(), c.s("signature"), signed.signatureHex)
            Ed25519Verify(pub).verify(HexUtil.decode(signed.signatureHex)!!, c.s("canonical").toByteArray(Charsets.UTF_8))
        }
    }

    @Test fun refusesEveryInvalidOrder() {
        val invalid = root["invalid"]!!.jsonArray.map { it.jsonObject }
        assertTrue(invalid.isNotEmpty())
        for (c in invalid) {
            try {
                AppMemberRoleOrder.canonicalBytes(order(c))
                fail("should refuse: ${c.s("why")}")
            } catch (_: IllegalArgumentException) {
            }
        }
    }

    @Test fun rowRolesTargetsAlsoInAndPrunes() {
        val sam = "ab".repeat(32)
        val old = "cd".repeat(32)
        val m = AppMembersResponse(
            serviceId = "a--notes", mode = "open", defaultRole = "member",
            descriptions = mapOf("manager" to "Runs tournaments"),
            members = listOf(
                AppMember(sam, "manager", listOf(AppMemberGrant("sam", "manager"), AppMemberGrant("family", "member"))),
                AppMember(old, "master", emptyList(), direct = "master"),
            ),
            invites = listOf(AppMemberInviteRole("sam", "manager", true), AppMemberInviteRole("family", "member", true)),
        )
        assertEquals(listOf("Member", "Manager", "Master"), AppMemberRole.entries.map { it.label })
        assertEquals(listOf(AppMemberRole.MASTER), AppMemberRole.entries.filter { it.crowned })
        assertEquals("Runs tournaments", m.description("manager"))
        assertEquals(null, m.description("master"))
        assertEquals("manager", m.rowRole("sam", sam))
        assertEquals("invite:sam", m.roleTarget("sam", sam))
        assertEquals("master", m.rowRole("old", old))
        assertEquals("aid:$old", m.roleTarget("old", old))
        assertEquals("member", m.rowRole("new", null))
        val others = m.otherGrants("sam", sam) { if (it == "family") "Family" else null }
        assertEquals("also in Family: Member", AppMembersResponse.alsoInText(others) { AppMemberRole.fromWire(it)!!.label })
        assertEquals(listOf(old, "ef"), m.aidsToPrune("family", listOf(sam, old, "ef")))
        assertEquals(emptyList<String>(), m.aidsToPrune("sam", listOf(sam)))
    }
}
