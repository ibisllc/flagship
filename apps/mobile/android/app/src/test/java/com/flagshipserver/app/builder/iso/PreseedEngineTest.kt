// Proves the Android (Rhino) preseed/user-data generator is BYTE-IDENTICAL to
// Node + the macOS/iOS JSC builder: it runs the SAME canonical bundle
// (packages/flagship-builder/engine/preseed-engine.js) against the SAME shared
// golden vectors (engine/golden/preseed-vectors.json) and asserts exact equality
// of every preseed.cfg + user-data output.
//
// Plus a drift guard: the shipped asset (assets/preseed-engine.js) must be
// byte-identical to the canonical package bundle, and the test feeds the engine
// the canonical bundle — so a stale asset OR a Rhino divergence fails here.

package com.flagshipserver.app.builder.iso

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class PreseedEngineTest {
    private val json = Json { ignoreUnknownKeys = true }

    // Walk up from the JVM unit-test working dir (apps/mobile/android/app) to the
    // repo root and resolve a path under it — the project's established idiom for
    // shared cross-platform fixtures (see CanonicalBytesVectorsTest).
    private fun repoFile(rel: String): File {
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        try {
            val loc = javaClass.protectionDomain?.codeSource?.location
            if (loc != null) candidates.add(File(loc.toURI()))
        } catch (_: Throwable) {
            // user.dir walk is the primary path
        }
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
        fail("could not locate $rel from " + candidates.joinToString { it.absolutePath })
        error("unreachable")
    }

    private val canonicalBundle by lazy {
        repoFile("packages/flagship-builder/engine/preseed-engine.js")
    }
    private val shippedAsset by lazy {
        repoFile("apps/mobile/android/app/src/main/assets/preseed-engine.js")
    }
    private val goldenVectors by lazy {
        repoFile("packages/flagship-builder/engine/golden/preseed-vectors.json")
    }

    private fun engine(): PreseedEngine =
        PreseedEngine(canonicalBundle.readText(Charsets.UTF_8))

    private fun vectors(): List<JsonObject> {
        val root = json.parseToJsonElement(goldenVectors.readText()).jsonObject
        return root["vectors"]!!.jsonArray.map { it.jsonObject }
    }

    @Test
    fun rhinoMatchesNodeOnEveryGoldenVector() {
        val eng = engine()
        val vs = vectors()
        assertTrue("expected golden vectors, found none", vs.isNotEmpty())
        for (v in vs) {
            val name = v["name"]!!.jsonPrimitive.content
            val recipeJson = v["recipeJson"]!!.jsonPrimitive.content
            val burnOptsJson = v["burnOptsJson"]!!.jsonPrimitive.content
            val expectedPreseed = v["expectedPreseed"]!!.jsonPrimitive.content
            val expectedUserData = v["expectedUserData"]!!.jsonPrimitive.content

            assertEquals(
                "preseed mismatch for vector '$name'",
                expectedPreseed,
                eng.buildPreseedFromRecipe(recipeJson, burnOptsJson),
            )
            assertEquals(
                "user-data mismatch for vector '$name'",
                expectedUserData,
                eng.buildUserDataFromRecipe(recipeJson, burnOptsJson),
            )
        }
    }

    @Test
    fun shippedAssetIsByteIdenticalToCanonicalBundle() {
        val asset = shippedAsset.readBytes()
        val canonical = canonicalBundle.readBytes()
        assertEquals(
            "shipped asset assets/preseed-engine.js drifted from " +
                "packages/flagship-builder/engine/preseed-engine.js — re-copy it " +
                "(npm run bundle:engine, then copy the bundle to the asset)",
            canonical.size,
            asset.size,
        )
        assertTrue(
            "shipped asset bytes differ from the canonical package bundle",
            asset.contentEquals(canonical),
        )
    }
}
