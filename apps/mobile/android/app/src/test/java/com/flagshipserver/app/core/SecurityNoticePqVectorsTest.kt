package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

// The Kotlin PQ half of security notices against
// packages/protocol/test-vectors/security-notice/pq-vectors.json.
class SecurityNoticePqVectorsTest {
    private fun repo(): File {
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        while (dir != null && !File(dir, "packages/protocol").isDirectory) dir = dir.parentFile
        return dir ?: error("repo root not found")
    }

    @Test
    fun everyCaseUnderBothPins() {
        val v = Json.parseToJsonElement(File(repo(), "packages/protocol/test-vectors/security-notice/pq-vectors.json").readText()).jsonObject
        val auth = v["authorityKeys"]!!.jsonArray.map { it.jsonPrimitive.content }
        val pinned = v["pinnedKeyIds"]!!.jsonArray.map { it.jsonPrimitive.content }
        for (c in v["cases"]!!.jsonArray.map { it.jsonObject }) {
            val expect = c["expect"] as JsonObject
            fun verdict(pin: List<String>): String {
                val n = SecurityNoticeProtocol.parse(c["notice"]) ?: return "malformed"
                return SecurityNoticeProtocol.verify(n, auth, pin) ?: "ok"
            }
            val name = c["name"]!!.jsonPrimitive.content
            assertEquals("$name empty pin", expect["emptyPin"]!!.jsonPrimitive.content, verdict(emptyList()))
            assertEquals("$name pinned", expect["pinned"]!!.jsonPrimitive.content, verdict(pinned))
        }
    }

    @Test
    fun theBakedPinMatchesTheProtocolPin() {
        val src = File(repo(), "packages/protocol/src/releasePqPin.ts").readText()
        val ids = Regex("keyIds: Object\\.freeze\\(\\[([^\\]]*)\\]\\)").find(src)!!.groupValues[1]
            .split("\"").filterIndexed { i, _ -> i % 2 == 1 }
        assertEquals(ids, SecurityNoticeProtocol.RELEASE_PQ_KEY_IDS)
    }
}
