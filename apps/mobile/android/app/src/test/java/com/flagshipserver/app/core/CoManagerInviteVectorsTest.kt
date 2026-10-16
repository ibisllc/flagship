// Runs packages/protocol/test-vectors/co-manager-invite/vectors.json (docs/
// service-access-gating.md "Co-manager invites"), read from disk so a drift
// fails here: the member and bundle keys, the sealed names, the create and
// revoke canonical strings and signatures, and the reject cases.

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class CoManagerInviteVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/co-manager-invite/vectors.json"
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
    private val keys: JsonObject by lazy { root["keys"]!!.jsonObject }
    private fun JsonObject.s(k: String): String = this[k]!!.jsonPrimitive.content
    private fun bytes(h: String): ByteArray = HexUtil.decode(h)!!
    private val memberUmk by lazy { bytes(keys.s("memberUmkSeedHex")) }
    private val memberPub by lazy { bytes(keys.s("memberPubHex")) }

    private fun request(f: JsonObject) = ShareInviteCreateRequest(
        inviteId = f.s("inviteId"),
        authorAID = f.s("authorAID"),
        serviceRef = f.s("serviceRef"),
        secretHash = f.s("secretHash"),
        encryptedBundle = f.s("encryptedBundle"),
        issuedAt = f["issuedAt"]!!.jsonPrimitive.long,
        maxRedemptions = f["maxRedemptions"]?.jsonPrimitive?.intOrNull,
        expiresAt = f["expiresAt"]?.jsonPrimitive?.longOrNull,
    )

    @Test fun keys() {
        assertEquals(keys.s("memberPubHex"), HexUtil.encode(ServerShare.deriveShareMemberPub(memberUmk, keys.s("shareId"))))
        assertEquals(keys.s("otherMemberPubHex"), HexUtil.encode(ServerShare.deriveShareMemberPub(memberUmk, keys.s("otherShareId"))))
        assertEquals(keys.s("bundleKeyHex"), HexUtil.encode(ServerShare.deriveShareInviteBundleKey(memberUmk, keys.s("shareId"))))
        assertEquals(keys.s("bundleKeyInfo"), "${ServerShare.INFO_INVITE_BUNDLE}|${keys.s("shareId")}")
    }

    @Test fun bundlesSealAndOpen() {
        val key = bytes(keys.s("bundleKeyHex"))
        val bundles = root["bundles"]!!.jsonArray.map { it.jsonObject }
        assertEquals(2, bundles.size)
        for (b in bundles) {
            val inviteId = b.s("inviteId")
            val name = Json.parseToJsonElement(b.s("plaintext")).jsonObject.s("name")
            val sealed = ServiceInvite.sealBundle(ServiceInvite.Bundle(name), key, inviteId, bytes(b.s("nonceHex")))
            assertEquals(b.s("sealedHex"), sealed)
            assertEquals(name, ServiceInvite.openBundle(sealed, key, inviteId).name)
            assertTrue(runCatching { ServiceInvite.openBundle(sealed, key, "0".repeat(64)) }.isFailure)
        }
    }

    @Test fun createsCanonicalAndSignature() {
        val creates = root["creates"]!!.jsonArray.map { it.jsonObject }
        assertEquals(2, creates.size)
        for (c in creates) {
            val bytes = request(c["fields"]!!.jsonObject).canonicalBytes()
            assertEquals(c.s("canonical"), String(bytes, Charsets.UTF_8))
            assertTrue(ServiceInvite.verify(bytes(c.s("signatureHex")), bytes, memberPub))
        }
    }

    @Test fun revokeCanonicalAndSignature() {
        val r = root["revoke"]!!.jsonObject
        val f = r["fields"]!!.jsonObject
        val bytes = ShareInviteRevoke(f.s("inviteId"), f["issuedAt"]!!.jsonPrimitive.long).canonicalBytes()
        assertEquals(r.s("canonical"), String(bytes, Charsets.UTF_8))
        assertTrue(ServiceInvite.verify(bytes(r.s("signatureHex")), bytes, memberPub))
    }

    @Test fun ourSignatureVerifiesUnderTheMemberKey() {
        val c = root["creates"]!!.jsonArray.first().jsonObject
        val bytes = request(c["fields"]!!.jsonObject).canonicalBytes()
        val sig = ServerShare.deriveShareMemberKey(memberUmk, keys.s("shareId")).sign(bytes)
        assertTrue(ServiceInvite.verify(sig, bytes, memberPub))
    }

    @Test fun rejectsFail() {
        val rejects = root["reject"]!!.jsonArray.map { it.jsonObject }.filter { it.s("envelope") == "create" }
        assertEquals(2, rejects.size)
        for (r in rejects) {
            val bytes = request(r["fields"]!!.jsonObject).canonicalBytes()
            assertFalse(r.s("why"), ServiceInvite.verify(bytes(r.s("signatureHex")), bytes, memberPub))
        }
    }

    @Test fun relayCanonicalUnderTheStk() {
        val r = root["relay"]!!.jsonObject
        val f = r["fields"]!!.jsonObject
        val canonical = (listOf("flagship/service-invite-co-manager/v1") +
            listOf("username", "serverDomain", "inviteId", "serviceRef", "creatorPubHex", "createSigHex").map { f.s(it) } +
            listOf(f["issuedAt"]!!.jsonPrimitive.long.toString())).joinToString("|")
        assertEquals(r.s("canonical"), canonical)
        val stk = bytes(keys.s("stkPubHex"))
        assertTrue(ServiceInvite.verify(bytes(r.s("signatureHex")), canonical.toByteArray(Charsets.UTF_8), stk))
        val bad = root["reject"]!!.jsonArray.map { it.jsonObject }.first { it.s("envelope") == "relay" }
        assertFalse(ServiceInvite.verify(bytes(bad.s("signatureHex")), canonical.toByteArray(Charsets.UTF_8), stk))
    }
}
