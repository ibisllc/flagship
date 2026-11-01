// Runs every case in packages/protocol/test-vectors/runtime-verification/vectors.json (generated from the
// webapp's lib/runtimeVerification.js), read from disk so a drift fails here.

package com.flagshipserver.app.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class RuntimeVerificationVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/runtime-verification/vectors.json"
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

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    /** Decodes the case's view inside a server-detail answer, the way the app receives it. */
    private fun decode(view: kotlinx.serialization.json.JsonElement?): RuntimeVerificationView? {
        val detail = buildJsonObject {
            put("serverFqdn", "home.harry.flagship.services"); put("username", "harry"); put("daemonVersion", "0.3.0")
            put("startedAt", 1); put("uptimeMs", 2); put("serviceCount", 0); put("pairedSessionCount", 0)
            put("recentInstallEvents", kotlinx.serialization.json.JsonArray(emptyList()))
            if (view != null && view !is JsonNull) put("runtime", view)
        }
        return json.decodeFromJsonElement(ServerDetailResponse.serializer(), detail).runtimeView
    }

    private fun pill(p: RuntimeVerificationView.Pill) = p.tone.name.lowercase() to p.label
    private fun pill(o: JsonObject) = o["tone"]!!.jsonPrimitive.content to o["label"]!!.jsonPrimitive.content

    @Test fun everyCaseMatchesTheWebapp() {
        val cases = Json.parseToJsonElement(vectorsFile().readText()).jsonObject["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.size >= 10)
        for (c in cases) {
            val name = c["name"]!!.jsonPrimitive.content
            val expect = c["expect"]!!.jsonObject
            val v = decode(c["view"])
            assertEquals(name, expect["present"]!!.jsonPrimitive.boolean, v != null)
            if (v == null) continue
            assertEquals(name, expect["platform"]!!.jsonPrimitive.content, v.platform)
            assertEquals(name, pill(expect["flagship"]!!.jsonObject), pill(v.flagshipStatus))
            assertEquals(name, pill(expect["upstream"]!!.jsonObject), pill(v.upstreamStatus))
            assertEquals(name, pill(expect["local"]!!.jsonObject), pill(v.localStatus))
            assertEquals(
                name,
                expect["notes"]!!.jsonArray.map { it.jsonObject.let { n -> n["tone"]!!.jsonPrimitive.content to n["text"]!!.jsonPrimitive.content } },
                v.notes.map { it.tone.name.lowercase() to it.text },
            )
            assertEquals(
                name,
                expect["commands"]!!.jsonArray.map { it.jsonObject.let { n -> n["title"]!!.jsonPrimitive.content to n["text"]!!.jsonPrimitive.content } },
                v.commands.map { it.title to it.text },
            )
        }
    }

    @Test fun aMalformedSectionStillLetsThePageLoad() {
        assertNull(decode(buildJsonObject { put("version", 3); put("flagship", buildJsonObject { put("status", 1) }) }))
        assertNull(decode(buildJsonObject { put("version", "24.0.0") }))
    }
}
