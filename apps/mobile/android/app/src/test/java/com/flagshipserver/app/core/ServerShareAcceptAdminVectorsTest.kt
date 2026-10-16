// Runs every case in packages/protocol/test-vectors/server-share-accept-admin/vectors.json
// (docs/share-a-server.md §4, §5.1): envelope #12, only an admin device of the
// joining account accepts a share. Read from disk so a drift fails here.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ServerShareAcceptAdminVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/server-share-accept-admin/vectors.json"
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        var hops = 0
        while (dir != null && hops < 14) {
            val f = File(dir, rel)
            if (f.isFile) return f
            dir = dir.parentFile
            hops += 1
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    private val root: JsonObject by lazy { Json.parseToJsonElement(vectorsFile().readText()).jsonObject }
    private val keys: JsonObject by lazy { root["keys"]!!.jsonObject }
    private fun JsonObject.s(k: String): String = this[k]!!.jsonPrimitive.content
    private fun cases(k: String): List<JsonObject> = root[k]!!.jsonArray.map { it.jsonObject }
    private fun bytes(h: String): ByteArray = HexUtil.decode(h)!!

    private val memberUmk by lazy { bytes(keys.s("memberUmkSeedHex")) }
    private val adminSeed by lazy { bytes(keys.s("adminRootSeedHex")) }

    private fun signer(name: String): Ed25519Sign = when (name) {
        "adminRoot" -> Ed25519Sign(adminSeed)
        "irk" -> ServerKeys.deriveProtocolIrk(memberUmk)
        "member" -> ServerShare.deriveShareMemberKey(memberUmk, keys.s("shareId"))
        else -> error("unknown signer $name")
    }

    private fun pub(name: String): ByteArray = when (name) {
        "adminRoot" -> bytes(keys.s("adminRootPubHex"))
        "irk" -> ServerKeys.deriveProtocolIrkPub(memberUmk)
        "member" -> ServerShare.deriveShareMemberPub(memberUmk, keys.s("shareId"))
        else -> error("unknown pub $name")
    }

    private fun admit(f: JsonObject) = ServerShare.AcceptAdmin(
        f.s("serverDomain"), f.s("shareId"), f.s("memberPubHex"), f["acceptedAt"]!!.jsonPrimitive.long, f.s("keyKind"), f.s("keyPubHex"),
    )

    @Test fun keys() {
        assertEquals(keys.s("adminRootPubHex"), HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(adminSeed).publicKey))
        assertEquals(keys.s("irkPubHex"), HexUtil.encode(pub("irk")))
        assertEquals(keys.s("memberPubHex"), HexUtil.encode(pub("member")))
    }

    @Test fun envelopes() {
        val all = cases("envelopes")
        assertEquals(2, all.size)
        for (c in all) {
            val f = c["fields"]!!.jsonObject
            val env = admit(f)
            assertEquals(c.toString(), c.s("canonical"), String(env.canonicalBytes(), Charsets.UTF_8))
            val sig = ServerShare.signHex(env, signer(c.s("signer")))
            assertEquals(c.toString(), c.s("signature"), sig)
            assertTrue(ServerShare.verify(env, bytes(sig), pub(c.s("signer"))))
            assertFalse(ServerShare.verify(env, bytes(sig), pub("member")))
            assertEquals(env, ServerShare.parseServerShareAcceptAdmin(f))
        }
    }

    @Test fun refuse() {
        val all = cases("refuse")
        assertTrue(all.isNotEmpty())
        for (c in all) {
            val f = c["fields"]!!.jsonObject
            val built = runCatching { admit(f).canonicalBytes() }
            assertTrue("built a refused envelope: ${c.s("why")}", built.isFailure)
            assertNull(c.s("why"), ServerShare.parseServerShareAcceptAdmin(f))
        }
    }

    @Test fun reject() {
        for (c in cases("reject")) {
            val env = admit(c["fields"]!!.jsonObject)
            assertFalse(c.s("why"), ServerShare.verify(env, bytes(c.s("signature")), pub(c.s("pub"))))
        }
    }

    @Test fun payloadKeepsTheAdminProof() {
        val payload = root["payload"]!!.jsonObject
        val p = ServerShare.parseShareAcceptancePayload(payload)
        assertNotNull(p?.admin)
        assertEquals(keys.s("adminRootPubHex"), p!!.admin!!.admit.keyPubHex)
        assertEquals(keys.s("adminRootPubHex"), p.admin!!.attestation.keyPubHex)
        assertEquals("AccountKeyAttestation", p.admin!!.attestation.kind)
        // Written back as the app seals it, it parses to the same thing.
        val again = ServerShare.parseShareAcceptancePayload(Json.parseToJsonElement(p.toJson()))
        assertEquals(p, again)
        // Without a proof (an older app) it still parses; a broken proof doesn't.
        val bare = JsonObject(payload.filterKeys { it != "admin" })
        assertNull(ServerShare.parseShareAcceptancePayload(bare)!!.admin)
        val broken = JsonObject(payload + ("admin" to buildJsonObject { put("signature", "ab") }))
        assertNull(ServerShare.parseShareAcceptancePayload(broken))
        assertEquals(
            root["attestation"]!!.jsonObject["attestation"]!!.jsonObject.s("signature"),
            ServerShare.parseAccountKeyAttestation(root["attestation"]!!.jsonObject["attestation"])!!.signature,
        )
    }
}
