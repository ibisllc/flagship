// Runs packages/protocol/test-vectors/voici-name/vectors.json (docs/named-links.md),
// read from disk so a drift fails here: the signed order the phone posts when an
// admin sets or clears a service's custom voi.ci name, and the grammar it checks first.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class VoiciNameVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/voici-name/vectors.json"
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
    private val pub by lazy { bytes(keys.s("pubHex")) }

    private fun canonical(f: JsonObject): ByteArray =
        VoiciName.canonicalBytes(f.s("user"), f.s("serviceId"), f.s("name"), f.s("op"), f.s("issuedAt").toLong(), f.s("nonce"))

    private fun verifies(canonical: ByteArray, sigHex: String): Boolean =
        runCatching { Ed25519Verify(pub).verify(bytes(sigHex), canonical) }.isSuccess

    @Test fun theSeedIsTheKeyTheVectorsNameBecauseTheSigningHereReproducesThem() {
        val pair = Ed25519Sign.KeyPair.newKeyPairFromSeed(bytes(keys.s("seedHex")))
        assertEquals(keys.s("pubHex"), HexUtil.encode(pair.publicKey))
    }

    @Test fun setAndClearReproduceTheCanonicalBytesAndSignatures() {
        val seed = bytes(keys.s("seedHex"))
        for (name in listOf("set", "clear")) {
            val v = root.o(name)
            val c = canonical(v.o("fields"))
            assertEquals("$name canonical", v.s("canonical"), String(c))
            assertEquals("$name signature", v.s("signatureHex"), HexUtil.encode(Ed25519Sign(seed).sign(c)))
            assertTrue("$name verifies", verifies(c, v.s("signatureHex")))
        }
    }

    @Test fun anEditedOrderDoesNotVerify() {
        for (r in root["reject"]!!.jsonArray.map { it.jsonObject }) {
            assertFalse(r.s("why"), verifies(canonical(r.o("order")), r.s("signatureHex")))
        }
    }

    @Test fun theNameRulesMatchTheReference() {
        for (n in root["names"]!!.jsonArray.map { it.jsonObject }) {
            val typed = n.s("typed")
            val problem = when (VoiciName.problem(typed)) {
                null -> null
                VoiciName.Problem.TooShort -> "too-short"
                VoiciName.Problem.TooLong -> "too-long"
                VoiciName.Problem.Characters -> "characters"
            }
            val want = n["problem"]
            assertEquals("problem for '$typed'", if (want is JsonNull) null else (want as JsonPrimitive).content, problem)
            if (problem == null) assertEquals("key for '$typed'", n.s("key"), VoiciName.key(typed))
        }
    }

    @Test fun refusesFieldsThatCouldForgeAnotherOrder() {
        assertThrows(IllegalArgumentException::class.java) {
            VoiciName.canonicalBytes("u", "u--app", "a|b", "set", 1L, "00")
        }
        assertThrows(IllegalArgumentException::class.java) {
            VoiciName.canonicalBytes("u", "u--app\n", "abcd", "set", 1L, "00")
        }
        assertNull(VoiciName.problem("halloween-party"))
    }
}
