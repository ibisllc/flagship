// Runs every case in packages/protocol/test-vectors/app-copy/vectors.json
// (docs/app-placement.md §5), read from disk so a drift fails here.

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

class AppCopyVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/app-copy/vectors.json"
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

    @Test fun signsEveryCaseWithTheProtocolIrk() {
        val seed = ServerKeys.deriveProtocolIrkSeed(HexUtil.decode(root.s("umkSeedHex"))!!)
        val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
        assertEquals(root.s("pub"), HexUtil.encode(pub))
        val cases = root["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val signed = AppCopy.sign(
                Ed25519Sign(seed), c.s("sourceServer"), c.s("targetServer"), c.s("serviceId"),
                c["issuedAt"]!!.jsonPrimitive.long,
            )
            assertEquals(c.toString(), c.s("canonical"), String(AppCopy.canonicalBytes(signed.grant), Charsets.UTF_8))
            assertEquals(c.toString(), c.s("signature"), signed.signatureHex)
            Ed25519Verify(pub).verify(HexUtil.decode(signed.signatureHex)!!, c.s("canonical").toByteArray(Charsets.UTF_8))
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesASeparatorInAField() {
        AppCopy.sign(Ed25519Sign(ByteArray(32)), "a.x.flagship.services", "b|x.flagship.services", "me--app", 1)
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesTheSameServerTwice() {
        AppCopy.sign(Ed25519Sign(ByteArray(32)), "a.x.flagship.services", "A.x.flagship.services", "me--app", 1)
    }

    @Test fun uninstallCanonicalMatchesTheProtocol() {
        // packages/protocol/src/serviceLifecycle.ts canonicalUninstallService.
        assertEquals(
            "flagship/uninstall-service/v1|home.x.flagship.services|x|notes-app|1700000000000",
            String(UninstallServiceOrder.canonicalBytes("home.x.flagship.services", "x", "notes-app", 1700000000000), Charsets.UTF_8),
        )
        assertEquals("x" to "notes-app", UninstallServiceOrder.split("x--notes-app"))
        assertEquals(null, UninstallServiceOrder.split("nodelimiter"))
    }
}
