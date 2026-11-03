// The phone's USB burn refuses a recipe from an app older than 0.3 the same way the
// three Studios do: the shared vm-core-vectors.json "olderAppRecipe" cases.

package com.flagshipserver.app.builder.iso

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class OlderAppRecipeTest {
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
            .jsonObject.getValue("olderAppRecipe").jsonObject
    }

    @Test
    fun ruleMatchesTheStudios() {
        val cases = section.getValue("cases").jsonArray
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val o = c.jsonObject
            val ref = o.getValue("installerGitRef").let { if (it is JsonNull) null else it.jsonPrimitive.content }
            assertEquals(o.getValue("name").jsonPrimitive.content, o.getValue("olderApp").jsonPrimitive.boolean, OlderAppRecipe.isFromOlderApp(ref))
        }
    }

    @Test
    fun refusesWithThePhoneSentence() {
        val phone = section.getValue("messages").jsonObject.getValue("phone").jsonPrimitive.content
        assertEquals(phone, OlderAppRecipe.message())
        assertEquals(phone, OlderAppRecipe.refusal(recipe("main")))
        assertNull(OlderAppRecipe.refusal(recipe("386e29c84899283c167c9ce983d2dc2acbaa4f11")))
    }

    private fun recipe(ref: String?) = ParsedRecipe(
        serial = "01TESTAPPROV", serverName = "home", serverDomain = "home.alice.flagship.services",
        username = "alice", blobSignatureHex = "00", expiresAt = null, installerGitRef = ref,
    )
}
