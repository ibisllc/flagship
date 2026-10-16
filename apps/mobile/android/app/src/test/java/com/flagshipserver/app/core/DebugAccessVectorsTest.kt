// Runs packages/protocol/test-vectors/debug-access/vectors.json read from
// disk, so a drift from the TS reference fails here
// (docs/recipe-delivery-and-remote-install.md "Debug access").

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class DebugAccessVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/debug-access/vectors.json"
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
    private fun JsonObject.o(k: String): JsonObject = this[k]!!.jsonObject
    private fun bytes(h: String): ByteArray = HexUtil.decode(h)!!
    private val adminPub by lazy { bytes(keys.s("adminRootPubHex")) }
    private val irkPub by lazy { bytes(keys.s("irkPubHex")) }
    private val admin by lazy { Ed25519Sign(bytes(keys.s("adminRootSeedHex"))) }

    private fun grant(f: JsonObject) = DebugAccess.Grant(
        serverDomain = f.s("serverDomain"),
        sshPublicKey = f.s("sshPublicKey"),
        issuedAt = f["issuedAt"]!!.jsonPrimitive.long,
        expiresAt = f["expiresAt"]!!.jsonPrimitive.long,
    )

    @Test fun derivesTheAdminRoot() {
        val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(bytes(keys.s("adminRootSeedHex"))).publicKey
        assertEquals(keys.s("adminRootPubHex"), HexUtil.encode(pub))
    }

    @Test fun limits() {
        assertEquals(root.o("limits")["defaultMs"]!!.jsonPrimitive.long, DebugAccess.DEFAULT_MS)
        assertEquals(root.o("limits")["maxMs"]!!.jsonPrimitive.long, DebugAccess.MAX_MS)
    }

    @Test fun normalizesAndFingerprintsKeys() {
        val ssh = root.o("sshKeys")
        for (k in ssh["accept"]!!.jsonArray) {
            val o = k.jsonObject
            assertEquals(o.s("normalized"), DebugAccess.normalizeSshPublicKey(o.s("input")))
            assertEquals(o.s("fingerprint"), DebugAccess.fingerprint(o.s("input")))
        }
        for (r in ssh["reject"]!!.jsonArray) {
            assertNull(r.jsonPrimitive.content, DebugAccess.normalizeSshPublicKey(r.jsonPrimitive.content))
        }
    }

    @Test fun reproducesTheGrant() {
        val v = root.o("grant")
        val g = grant(v.o("fields"))
        assertEquals(v.s("canonical"), String(DebugAccess.canonicalBytes(g)))
        assertEquals(v.s("signatureHex"), DebugAccess.sign(g, admin))
        assertTrue(DebugAccess.verify(g, v.s("signatureHex"), adminPub))
        assertFalse(DebugAccess.verify(g, v.s("signatureHex"), irkPub))
        assertFalse(DebugAccess.verify(g, v.o("reject").s("signatureHex"), adminPub))
        assertFalse(DebugAccess.verify(g.copy(expiresAt = g.expiresAt + 1), v.s("signatureHex"), adminPub))
    }

    @Test fun reproducesTheRevoke() {
        val v = root.o("revoke")
        val f = v.o("fields")
        val r = DebugAccess.Revoke(f.s("serverDomain"), f["issuedAt"]!!.jsonPrimitive.long)
        assertEquals(v.s("canonical"), String(DebugAccess.revokeCanonicalBytes(r)))
        assertEquals(v.s("signatureHex"), DebugAccess.signRevoke(r, admin))
        assertTrue(DebugAccess.verifyRevoke(r, v.s("signatureHex"), adminPub))
        assertFalse(DebugAccess.verifyRevoke(r, v.s("signatureHex"), irkPub))
        assertFalse(DebugAccess.verifyRevoke(r, v.o("reject").s("signatureHex"), adminPub))
    }

    @Test fun wireMatchesTheReference() {
        val v = root.o("grant")
        val g = grant(v.o("fields"))
        assertEquals(v.o("wire"), Json.parseToJsonElement(DebugAccess.envelopeJson(g, v.s("signatureHex"))))
        val rv = root.o("revoke")
        val rf = rv.o("fields")
        val r = DebugAccess.Revoke(rf.s("serverDomain"), rf["issuedAt"]!!.jsonPrimitive.long)
        assertEquals(rv.o("wire"), Json.parseToJsonElement(DebugAccess.revokeJson(r, rv.s("signatureHex"))))
    }

    @Test fun refusesEveryRefuseCase() {
        for (r in root["refuse"]!!.jsonArray) {
            val c = r.jsonObject
            val g = grant(c.o("fields"))
            assertNotNull(c.s("why"), DebugAccess.grantProblem(g))
            assertThrows(c.s("why"), IllegalArgumentException::class.java) { DebugAccess.sign(g, admin) }
        }
    }
}
