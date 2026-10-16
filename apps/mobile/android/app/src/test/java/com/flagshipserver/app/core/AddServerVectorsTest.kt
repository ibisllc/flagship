// Runs packages/protocol/test-vectors/add-server/vectors.json, read from disk
// so a drift fails here: adding a server is admin-only (owner rule
// 2026-10-16), so `.com` takes an AuthCode only with the admin root's approval
// (`flagship/auth-code-admin/v1`) and an admin-pinned box takes a restore order
// only from that root.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class AddServerVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/add-server/vectors.json"
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

    private fun code(f: JsonObject) = AuthCode(
        version = f["version"]!!.jsonPrimitive.content.toInt(),
        serial = f.s("serial"),
        username = f.s("username"),
        serverName = f.s("serverName"),
        serverDomain = f.s("serverDomain"),
        delegatedPubKey = bytes(f.s("delegatedPubKey")),
        userPubKey = bytes(f.s("userPubKey")),
        issuedAt = f["issuedAt"]!!.jsonPrimitive.long,
        expiresAt = f["expiresAt"]!!.jsonPrimitive.long,
        adminRootPubKey = f["adminRootPubKey"]?.jsonPrimitive?.content?.let { bytes(it) },
    )

    private fun verifies(pubName: String, sigHex: String, msg: ByteArray): Boolean =
        runCatching { Ed25519Verify(bytes(keys.s(pubName))).verify(bytes(sigHex), msg) }.isSuccess

    @Test fun reproducesBothCanonicalStringsAndTheSignatures() {
        val a = root.o("authCode")
        val c = code(a.o("fields"))
        assertEquals(a.s("canonical"), String(c.canonicalBytes()))
        assertEquals(a.s("adminCanonical"), String(c.adminCanonicalBytes()))
        assertTrue(verifies("irkPubHex", a.s("irkSignatureHex"), c.canonicalBytes()))
        assertTrue(verifies("adminRootPubHex", a.s("adminSignatureHex"), c.adminCanonicalBytes()))
        // Tink's Ed25519 is deterministic (RFC 8032): ours is byte-identical.
        val admin = Ed25519Sign(bytes(keys.s("adminRootSeedHex")))
        assertEquals(a.s("adminSignatureHex"), HexUtil.encode(admin.sign(c.adminCanonicalBytes())))
    }

    @Test fun refusesEveryRejectAsTheAdminApproval() {
        val c = code(root.o("authCode").o("fields"))
        for (r in root["reject"]!!.jsonArray) {
            assertFalse(r.jsonObject.s("why"), verifies("adminRootPubHex", r.jsonObject.s("signatureHex"), c.adminCanonicalBytes()))
        }
    }

    @Test fun aCodePinningAnotherRootVerifiesOnlyUnderThatRoot() {
        val w = root.o("wrongRoot")
        val c = code(w.o("fields"))
        assertEquals(w.s("adminCanonical"), String(c.adminCanonicalBytes()))
        assertTrue(verifies("otherRootPubHex", w.s("adminSignatureHex"), c.adminCanonicalBytes()))
        assertFalse(verifies("adminRootPubHex", w.s("adminSignatureHex"), c.adminCanonicalBytes()))
    }

    @Test fun anAuthCodeWithNoAdminRootHasNoAdminForm() {
        for (r in root["refuse"]!!.jsonArray) {
            assertThrows(r.jsonObject.s("why"), IllegalArgumentException::class.java) {
                code(r.jsonObject.o("fields")).adminCanonicalBytes()
            }
        }
    }

    @Test fun theRestoreOrderVerifiesOnlyUnderTheAdminRoot() {
        val r = root.o("restore")
        val o = r.o("order")
        val order = ServerBackupFormat.RestoreOrder(
            serverDomain = o.s("serverDomain"),
            archiveId = o.s("archiveId"),
            bytes = o["bytes"]!!.jsonPrimitive.long,
            sha256 = o.s("sha256"),
            issuedAt = o["issuedAt"]!!.jsonPrimitive.long,
        )
        assertEquals(r.s("canonical"), String(order.canonicalBytes()))
        assertTrue(verifies("adminRootPubHex", r.s("adminSignatureHex"), order.canonicalBytes()))
        for (x in r["reject"]!!.jsonArray) {
            assertFalse(x.jsonObject.s("why"), verifies("adminRootPubHex", x.jsonObject.s("signatureHex"), order.canonicalBytes()))
        }
    }
}
