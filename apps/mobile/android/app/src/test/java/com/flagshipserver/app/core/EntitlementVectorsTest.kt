// Pins the phone's RootEntitlement (the boot-approval carrier it signs) to
// packages/protocol/test-vectors/entitlements/vectors.json. Only the `root` cases reach a phone: service
// entitlements, revocation lists, tunnel hellos and service grants are box and relay records.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class EntitlementVectorsTest {
    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/entitlements/vectors.json"
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

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    @Test fun rootEntitlement() {
        val all = Json.parseToJsonElement(vectorsFile().readText()).jsonObject["cases"]!!.jsonArray.map { it.jsonObject }
        val roots = all.filter { it.s("kind") == "root" }
        assertTrue(roots.size >= 5)
        for (c in roots) {
            val name = c.s("name")
            val i = c["input"]!!.jsonObject
            val user = i.s("username")
            val pod = i.s("podPubKeyHex")
            val canonicalName = i.s("podCanonical")
            val at = i["issuedAt"]!!.jsonPrimitive.long
            val canonical = c["canonical"]?.jsonPrimitive?.takeIf { it.isString }?.content
            if (canonical == null) {
                assertTrue(name, runCatching { RootEntitlement.sign(Ed25519Sign(ByteArray(32) { 1 }), user, pod, canonicalName, at) }.isFailure)
                continue
            }
            val bytes = RootEntitlement.canonicalBytes(user, pod, canonicalName, at)
            assertEquals(name, canonical, String(bytes, Charsets.UTF_8))
            assertEquals(name, c.s("certId"), HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(bytes)))
            val verifies = c["verifies"]!!.jsonPrimitive.boolean
            assertEquals(name, verifies, RootEntitlement.verify(HexUtil.decode(c.s("signatureHex"))!!, HexUtil.decode(c.s("signerPubHex"))!!, user, pod, canonicalName, at))
        }
    }
}
