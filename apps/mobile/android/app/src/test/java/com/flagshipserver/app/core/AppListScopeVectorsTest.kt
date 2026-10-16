// Runs every case and every refusal in
// packages/protocol/test-vectors/app-list-scope/vectors.json (a separate
// access list on each server, a Pro option; feat/marketplace), read from disk
// so a drift fails here.

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
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class AppListScopeVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/app-list-scope/vectors.json"
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
    private fun JsonObject.order() = AppListScope.Order(s("serviceRef"), s("scope"), this["issuedAt"]!!.jsonPrimitive.long)
    private fun list(name: String) = root[name]!!.jsonArray.map { it.jsonObject }

    @Test fun theSignerSeedMatchesItsPub() {
        val kp = Ed25519Sign.KeyPair.newKeyPairFromSeed(HexUtil.decode(root.s("signerSeedHex"))!!)
        assertEquals(root.s("signerPub"), HexUtil.encode(kp.publicKey))
    }

    @Test fun everyCaseSignsToTheVector() {
        val key = Ed25519Sign(HexUtil.decode(root.s("signerSeedHex"))!!)
        val pub = HexUtil.decode(root.s("signerPub"))!!
        val cases = list("cases")
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val o = c.order()
            assertEquals(c.toString(), c.s("canonical"), String(AppListScope.canonicalBytes(o), Charsets.UTF_8))
            val sig = AppListScope.signHex(key, o)
            assertEquals(c.toString(), c.s("signature"), sig)
            Ed25519Verify(pub).verify(HexUtil.decode(sig)!!, c.s("canonical").toByteArray(Charsets.UTF_8))
        }
    }

    @Test fun everyRejectIsRefused() {
        val rejects = list("rejects")
        assertTrue(rejects.isNotEmpty())
        for (c in rejects) {
            try {
                AppListScope.canonicalBytes(c.order())
                fail("should refuse: ${c.s("why")}")
            } catch (_: IllegalArgumentException) {
            }
        }
    }
}
