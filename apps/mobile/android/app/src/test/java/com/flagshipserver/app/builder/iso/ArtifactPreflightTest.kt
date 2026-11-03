// The phone's USB burn checks the box release the same way the three Studios do:
// the shared vm-core-vectors.json "artifactPreflight" URL and verdict cases.

package com.flagshipserver.app.builder.iso

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ArtifactPreflightTest {
    private fun repoFile(rel: String): File {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        var hops = 0
        while (dir != null && hops < 14) {
            val f = File(dir, rel)
            if (f.isFile) return f
            dir = dir.parentFile
            hops += 1
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    private val section by lazy {
        Json.parseToJsonElement(repoFile("apps/desktop-shared/golden/vm-core-vectors.json").readText())
            .jsonObject.getValue("artifactPreflight").jsonObject
    }

    @Test
    fun urlsMatchTheStudios() {
        val cases = section.getValue("urlCases").jsonArray
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val o = c.jsonObject
            val want = o.getValue("url").let { if (it is JsonNull) null else it.jsonPrimitive.content }
            val got = ArtifactPreflight.manifestUrl(
                "https://" + o.getValue("controlHost").jsonPrimitive.content,
                o.getValue("commit").jsonPrimitive.content,
                o.getValue("arch").jsonPrimitive.content,
            )
            assertEquals(o.getValue("name").jsonPrimitive.content, want, got)
        }
    }

    @Test
    fun verdictsMatchTheStudios() {
        assertEquals(section.getValue("timeoutSeconds").jsonPrimitive.int.toLong(), ArtifactPreflight.TIMEOUT_SECONDS)
        for (c in section.getValue("verdictCases").jsonArray) {
            val o = c.jsonObject
            val status = o.getValue("status").let { if (it is JsonNull) null else it.jsonPrimitive.int }
            assertEquals(status.toString(), o.getValue("verdict").jsonPrimitive.content, ArtifactPreflight.verdictFor(status).name.lowercase())
        }
    }

    @Test
    fun checkAsksOnceAndNeverForANonCommit() = runTest {
        val commit = "386e29c84899283c167c9ce983d2dc2acbaa4f11"
        val seen = mutableListOf<String>()
        val verdict = ArtifactPreflight.check("https://flagshipserver.com", commit, "amd64") { url -> seen.add(url); 404 }
        assertEquals(ArtifactPreflight.Verdict.MISSING, verdict)
        assertEquals(listOf("https://flagshipserver.com/build/iso/flagship-box-386e29c84899-amd64.manifest.json"), seen)
        assertEquals(ArtifactPreflight.Verdict.UNREACHABLE, ArtifactPreflight.check("https://flagshipserver.com", commit, "amd64") { null })
        assertEquals(ArtifactPreflight.Verdict.PUBLISHED, ArtifactPreflight.check("https://flagshipserver.com", commit, "amd64") { 200 })
        assertEquals(ArtifactPreflight.Verdict.MISSING, ArtifactPreflight.check("https://flagshipserver.com", "main", "amd64") { fail("no request"); 200 })
    }
}
