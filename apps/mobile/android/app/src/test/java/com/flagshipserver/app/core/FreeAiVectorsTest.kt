// Runs every case in packages/protocol/test-vectors/llm-promo-issue/vectors.json
// (the free-AI-credits request), read from disk so a drift fails here.

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

class FreeAiVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/llm-promo-issue/vectors.json"
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
    private fun JsonObject.l(k: String): Long = this[k]!!.jsonPrimitive.long

    @Test fun signsEveryCaseWithTheProtocolIrk() {
        val seed = ServerKeys.deriveProtocolIrkSeed(HexUtil.decode(root.s("umkSeedHex"))!!)
        val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
        assertEquals(root.s("pub"), HexUtil.encode(pub))
        val cases = root["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            assertEquals(FreeAiRequest.PROVIDER, c.s("provider"))
            assertEquals(0L, c.l("desiredDailyInputTokenCap"))
            assertEquals(0L, c.l("desiredDailyOutputTokenCap"))
            val canonical = FreeAiRequest.canonicalBytes(c.s("username"), c.s("serverFqdn"), c.l("issuedAt"))
            assertEquals(c.toString(), c.s("canonical"), String(canonical, Charsets.UTF_8))
            val body = FreeAiRequest.sign(Ed25519Sign(seed), c.s("username"), c.s("serverFqdn"), c.l("issuedAt"))
            assertEquals(c.toString(), c.s("signature"), body.signature)
            Ed25519Verify(pub).verify(HexUtil.decode(body.signature)!!, canonical)
            assertEquals(c.s("serverFqdn"), body.request.serverFqdn)
            assertEquals("flagship", body.request.provider)
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesASeparatorInAField() {
        FreeAiRequest.canonicalBytes("har|ry", "", 1)
    }
}
