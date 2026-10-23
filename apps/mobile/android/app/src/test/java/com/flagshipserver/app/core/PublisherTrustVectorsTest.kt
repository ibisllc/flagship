// Runs packages/protocol/test-vectors/publisher-trust/vectors.json (SEC-ADAPTER-001 / 18.11).

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class PublisherTrustVectorsTest {
    private fun vectors() = run {
        val rel = "packages/protocol/test-vectors/publisher-trust/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        var found: File? = null
        var hops = 0
        while (dir != null && hops < 14 && found == null) {
            val f = File(dir, rel)
            if (f.isFile) found = f
            dir = dir.parentFile
            hops += 1
        }
        Json.parseToJsonElement(requireNotNull(found) { "could not locate $rel" }.readText()).jsonObject
    }

    private fun trust(v: kotlinx.serialization.json.JsonObject) =
        Json.decodeFromJsonElement(PublisherTrust.serializer(), v["trust"]!!)

    @Test
    fun canonicalBytesAndSignatureMatchTheVector() {
        val v = vectors()
        val t = trust(v)
        assertEquals(v["canonical"]!!.jsonPrimitive.content, String(t.canonicalBytes(), Charsets.UTF_8))
        val seed = HexUtil.decode(v["ownerSeedHex"]!!.jsonPrimitive.content)!!
        val pub = HexUtil.decode(v["ownerPubHex"]!!.jsonPrimitive.content)!!
        Ed25519Verify(pub).verify(HexUtil.decode(v["signatureHex"]!!.jsonPrimitive.content)!!, t.canonicalBytes())
        val own = t.sign { Ed25519Sign(seed).sign(it) }
        Ed25519Verify(pub).verify(HexUtil.decode(own)!!, t.canonicalBytes())
    }

    @Test
    fun aFieldThatCouldSplitTheBytesIsRefused() {
        val t = trust(vectors())
        assertThrows(IllegalArgumentException::class.java) { t.copy(serviceId = "a|b").canonicalBytes() }
        assertThrows(IllegalArgumentException::class.java) { t.copy(serviceId = "").canonicalBytes() }
    }

    @Test
    fun deadlineWording() {
        assertEquals("", SliverWords.remaining(null))
        assertEquals("5 minutes left", SliverWords.remaining(5 * 60_000L))
        assertEquals("2 days 3 hours left", SliverWords.remaining(2 * 86_400_000L + 3 * 3_600_000L))
        assertEquals("overdue by 2 hours 0 minutes", SliverWords.remaining(-2 * 3_600_000L))
    }

    @Test
    fun theBoxsSliverJsonDecodes() {
        val json = Json { ignoreUnknownKeys = true }
        val body = """{"lines":[{"eventId":"sv1","issueKey":"publisher-key:chess","kind":"publisher-key","severity":"high","target":"chess","state":"active","summary":"x","raisedAt":1,"updatedAt":2,"resolvedAt":null,"deadline":null,"action":"Review","acknowledgedAt":null,"escalatedFrom":null,"remainingMs":null}],"lostHistory":false}"""
        val r = json.decodeFromString(SecuritySliverResponse.serializer(), body)
        assertEquals("chess", r.lines[0].target)
        assertTrue(r.lines[0].isActive)
        assertNull(r.lines[0].remainingMs)
    }
}
