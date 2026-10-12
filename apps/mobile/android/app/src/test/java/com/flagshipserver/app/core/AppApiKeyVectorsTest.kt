// Runs every case in packages/protocol/test-vectors/app-api-key/vectors.json
// (docs/app-apis.md §3), read from disk so a drift fails here.

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
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class AppApiKeyVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/app-api-key/vectors.json"
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
            val grant = AppApiKey.Grant(
                serverDomain = c.s("serverDomain"),
                serviceId = c.s("serviceId"),
                keyId = c.s("keyId"),
                scope = c.s("scope"),
                expiresAt = c.l("expiresAt"),
                issuedAt = c.l("issuedAt"),
            )
            val canonical = AppApiKey.canonicalBytes(
                grant.serverDomain, grant.serviceId, grant.keyId, grant.scope, grant.expiresAt, grant.issuedAt,
            )
            assertEquals(c.toString(), c.s("canonical"), String(canonical, Charsets.UTF_8))
            val signed = AppApiKey.sign(Ed25519Sign(seed), grant)
            assertEquals(c.toString(), c.s("signature"), signed.signatureHex)
            Ed25519Verify(pub).verify(HexUtil.decode(signed.signatureHex)!!, c.s("canonical").toByteArray(Charsets.UTF_8))
        }
    }

    @Test fun keyIdsAreSixteenLowercaseHex() {
        repeat(50) { assertTrue(AppApiKey.isValidKeyId(AppApiKey.newKeyId())) }
        assertFalse(AppApiKey.isValidKeyId("0123456789ABCDEF"))
        assertFalse(AppApiKey.isValidKeyId("0123456789abcde"))
        assertFalse(AppApiKey.isValidKeyId("0123456789abcdefa"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesAnUnknownScope() {
        AppApiKey.sign(
            Ed25519Sign(ByteArray(32) { 1 }),
            AppApiKey.Grant("home.harry.flagship.services", "harry-weather", "0123456789abcdef", "admin", 0, 1),
        )
    }
}
