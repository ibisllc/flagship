// Runs every case in packages/protocol/test-vectors/app-access/vectors.json
// (docs/ai-privacy-and-staging.md §3a), read from disk so a drift fails here.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class AppAccessListVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/app-access/vectors.json"
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
    private fun cases(k: String): List<JsonObject> = root[k]!!.jsonArray.map { it.jsonObject }

    @Test fun defaultList() {
        assertEquals(root.s("defaultList"), AppAccessList.DEFAULT_LIST)
        assertTrue(AppAccessList.parse(AppAccessList.DEFAULT_LIST).ok)
        assertEquals(0, AppAccessList.parse(AppAccessList.DEFAULT_LIST).rules.size)
        assertEquals(AppAccessList.DEFAULT_LIST, AppAccessList.normalize(AppAccessList.DEFAULT_LIST))
    }

    @Test fun normalize() {
        val all = cases("normalize")
        assertTrue(all.isNotEmpty())
        for (c in all) assertEquals(c.toString(), c.s("out"), AppAccessList.normalize(c.s("in")))
    }

    @Test fun parse() {
        val all = cases("parse")
        assertTrue(all.isNotEmpty())
        for (c in all) {
            val got = AppAccessList.parse(c.s("list"))
            val errors = (c["errors"] as? JsonArray)?.map {
                val o = it.jsonObject
                AppAccessList.LineError(o["line"]!!.jsonPrimitive.int, o.s("message"))
            } ?: emptyList()
            assertEquals(c.toString(), errors, got.errors)
            (c["rules"] as? JsonArray)?.let { rules ->
                val want = rules.map {
                    val o = it.jsonObject
                    AppAccessList.Rule(o["line"]!!.jsonPrimitive.int, o.s("action"), o.s("target"))
                }
                assertEquals(c.toString(), want, got.rules)
            }
        }
    }

    @Test fun decide() {
        val all = cases("decide")
        assertTrue(all.isNotEmpty())
        for (c in all) {
            val got = AppAccessList.decide(c.s("list"), c.s("host"))
            assertEquals(c.toString(), c.s("result"), got.result)
            val rule = c["rule"]
            val want = if (rule == null || rule is JsonNull) null else rule.jsonPrimitive.int
            assertEquals(c.toString(), want, got.rule)
        }
    }

    @Test fun withRule() {
        val all = cases("withRule")
        assertTrue(all.isNotEmpty())
        for (c in all) {
            assertEquals(c.toString(), c.s("out"), AppAccessList.withRule(c.s("list"), c.s("action"), c.s("host")))
        }
    }

    @Test fun sign() {
        val sign = root["sign"]!!.jsonObject
        val seed = ServerKeys.deriveProtocolIrkSeed(HexUtil.decode(sign.s("umkSeedHex"))!!)
        val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
        assertEquals(sign.s("pub"), HexUtil.encode(pub))
        val all = sign["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(all.isNotEmpty())
        for (c in all) {
            val domain = c.s("serverDomain")
            val service = c.s("serviceId")
            val issuedAt = (c["issuedAt"] as JsonPrimitive).long
            val list = c.s("list")
            assertEquals(c.s("listSha256"), AppAccessList.sha256Hex(list))
            assertEquals(
                c.s("canonical"),
                String(AppAccessList.canonicalBytes(domain, service, c.s("listSha256"), issuedAt), Charsets.UTF_8),
            )
            val signed = AppAccessList.sign(Ed25519Sign(seed), domain, service, list, issuedAt)
            assertEquals(list, signed.list)
            assertEquals(c.s("listSha256"), signed.listSha256)
            assertEquals(c.s("signature"), signed.signatureHex)
            Ed25519Verify(pub).verify(HexUtil.decode(signed.signatureHex)!!, c.s("canonical").toByteArray(Charsets.UTF_8))
        }
    }

    @Test fun tooManyRules() {
        val list = (1..201).joinToString("\n") { "allow h$it.example.com" }
        val parsed = AppAccessList.parse(list)
        assertEquals(200, parsed.rules.size)
        assertEquals(listOf(201), parsed.errors.map { it.line })
    }
}
