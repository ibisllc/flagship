// Runs every case in packages/protocol/test-vectors/service-env-change/vectors.json
// (flagship/service-env-change/v1), read from disk so a drift fails here.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.ServiceEnvChange
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ServiceEnvChangeVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/service-env-change/vectors.json"
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

    private val v: JsonObject by lazy { Json.parseToJsonElement(vectorsFile().readText()).jsonObject }

    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun change(o: JsonObject) = ServiceEnvChange(
        serverId = o["serverId"]!!.jsonPrimitive.content,
        serviceId = o["serviceId"]!!.jsonPrimitive.content,
        op = o["op"]!!.jsonPrimitive.content,
        name = o["name"]!!.jsonPrimitive.content,
        valueSha256 = o["valueSha256"]!!.jsonPrimitive.content,
        issuedAt = o["issuedAt"]!!.jsonPrimitive.long,
        nonce = o["nonce"]!!.jsonPrimitive.content,
    )

    @Test fun reproducesEveryCase() {
        val verify = Ed25519Verify(hex(v["pub"]!!.jsonPrimitive.content))
        val cases = v["cases"]!!.jsonArray
        assertEquals(4, cases.size)
        for (c in cases) {
            val o = c.jsonObject
            val ch = change(o["change"]!!.jsonObject)
            o["value"]?.let { assertEquals(ch.valueSha256, ServiceEnvChange.valueSha256(it.jsonPrimitive.content)) }
            val bytes = ch.canonicalBytes()
            assertEquals(o["canonical"]!!.jsonPrimitive.content, bytes.toString(Charsets.UTF_8))
            verify.verify(hex(o["signature"]!!.jsonPrimitive.content), bytes)
        }
    }

    @Test fun refusesEveryInvalidChange() {
        val invalid = v["invalid"]!!.jsonArray
        assertEquals(12, invalid.size)
        for (i in invalid) {
            assertTrue("$i", runCatching { change(i.jsonObject).canonicalBytes() }.isFailure)
        }
    }

    @Test fun freshChangesCarryTheirOwnNonce() {
        val a = ServiceEnvChange.set("home.a.flagship.services", "a--b", "API_KEY", "s|cret")
        val b = ServiceEnvChange.unset("home.a.flagship.services", "a--b", "API_KEY")
        assertNotEquals(a.nonce, b.nonce)
        assertEquals("", b.valueSha256)
        // A set signs the value's hash, never the value.
        assertFalse(a.canonicalBytes().toString(Charsets.UTF_8).contains("s|cret"))
        b.canonicalBytes()
        assertNotNull(ServiceEnvChange.nameError("my-key"))
        assertNotNull(ServiceEnvChange.nameError("FLAGSHIP_APP_ID"))
        assertNull(ServiceEnvChange.nameError("API_KEY"))
    }
}
