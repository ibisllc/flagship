// B7 — marketplace install UX parity with the webapp + iOS:
//   1. an app that needs an LLM key resolves the env-var name to prefill in
//      "Configure environment" (never dead-ends at installed-but-broken);
//   2. the scan-grade pill maps A/B→OK, C/D→WARN, F→ERR, NULL→UNGRADED — the
//      same buckets the webapp's `scanGradePill` + iOS `ScanGradeBucket` use.
//
// Pins the SHARED pure logic (MarketplaceLlmKey, ScanGradeBucket) + the
// listing's new fields, so the daemon BFF wire shape and all three clients
// stay aligned.

package com.flagshipserver.app.api

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MarketplaceListingUxTest {

    private fun listing(
        requiresLlmKey: Boolean = false,
        llmKeyEnvVar: String? = null,
        scanGrade: String? = null,
    ) = MarketplaceListing(
        creator = "a", slug = "b", title = "T", summary = "S",
        screenshots = emptyList(), installCount = 1,
        requiresLlmKey = requiresLlmKey, llmKeyEnvVar = llmKeyEnvVar,
        scanGrade = scanGrade, alreadyInstalled = false,
    )

    // ---- Fix 1: LLM-key env-var resolution ----

    @Test fun llmKeyDefaultMatchesContract() {
        assertEquals("OPENAI_API_KEY", MarketplaceLlmKey.DEFAULT_ENV_VAR)
    }

    @Test fun llmKeyUsesListingDeclaredName() {
        assertEquals(
            "ANTHROPIC_API_KEY",
            MarketplaceLlmKey.envVar(listing(requiresLlmKey = true, llmKeyEnvVar = "ANTHROPIC_API_KEY")),
        )
    }

    @Test fun llmKeyFallsBackToDefaultWhenAbsentOrEmpty() {
        assertEquals("OPENAI_API_KEY", MarketplaceLlmKey.envVar(listing(requiresLlmKey = true)))
        assertEquals(
            "OPENAI_API_KEY",
            MarketplaceLlmKey.envVar(listing(requiresLlmKey = true, llmKeyEnvVar = "")),
        )
    }

    // ---- Fix 2: scan-grade buckets (incl. NULL → ungraded) ----

    @Test fun scanGradeBuckets() {
        assertEquals(ScanGradeBucket.OK, ScanGradeBucket.from("A"))
        assertEquals(ScanGradeBucket.OK, ScanGradeBucket.from("b")) // case-insensitive
        assertEquals(ScanGradeBucket.WARN, ScanGradeBucket.from("C"))
        assertEquals(ScanGradeBucket.WARN, ScanGradeBucket.from("D"))
        assertEquals(ScanGradeBucket.ERR, ScanGradeBucket.from("F"))
        // Consistent NULL/unknown treatment across all three surfaces.
        assertEquals(ScanGradeBucket.UNGRADED, ScanGradeBucket.from(null))
        assertEquals(ScanGradeBucket.UNGRADED, ScanGradeBucket.from(""))
        assertEquals(ScanGradeBucket.UNGRADED, ScanGradeBucket.from("Z"))
    }

    @Test fun scanGradePillLabels() {
        assertEquals("scan A", ScanGradeBucket.pillLabel("a"))
        assertEquals("scan F", ScanGradeBucket.pillLabel("F"))
        assertEquals("ungraded", ScanGradeBucket.pillLabel(null))
        assertEquals("ungraded", ScanGradeBucket.pillLabel("?"))
    }

    // ---- Wire shape: new fields decode + tolerate absence ----

    private val json = Json { ignoreUnknownKeys = true }

    @Test fun listingDecodesScanGradeAndLlmKeyEnvVar() {
        val l = json.decodeFromString(
            MarketplaceListing.serializer(),
            """{"creator":"bob","slug":"game","title":"Game","summary":"y",
               "screenshots":[],"installCount":2,"requiresLlmKey":true,
               "llmKeyEnvVar":"OPENAI_API_KEY","scanGrade":"B","alreadyInstalled":false}""",
        )
        assertEquals("B", l.scanGrade)
        assertEquals("OPENAI_API_KEY", l.llmKeyEnvVar)
        assertTrue(l.requiresLlmKey)
    }

    @Test fun listingDecodesWhenOptionalFieldsAbsent() {
        // The BFF omits scanGrade / llmKeyEnvVar when .com doesn't supply them.
        val l = json.decodeFromString(
            MarketplaceListing.serializer(),
            """{"creator":"alice","slug":"habits","title":"Habits","summary":"x",
               "screenshots":[],"installCount":5,"requiresLlmKey":false,
               "alreadyInstalled":true}""",
        )
        assertNull(l.scanGrade)
        assertNull(l.llmKeyEnvVar)
        assertEquals(ScanGradeBucket.UNGRADED, ScanGradeBucket.from(l.scanGrade))
    }

    // ---- The mock exercises both fixes (drives the live-shape UI in tests) ----

    @Test fun mockListingsCarryGradeAndLlmKey() = runTest {
        val listings = MockScreensClient(simulatedLatencyMs = 0).marketplaceBrowse().listings
        val feed = listings.first { it.slug == "feed-reader" }
        assertTrue(feed.requiresLlmKey)
        assertEquals("OPENAI_API_KEY", MarketplaceLlmKey.envVar(feed))
        assertEquals(ScanGradeBucket.WARN, ScanGradeBucket.from(feed.scanGrade)) // "C"
        val wishlist = listings.first { it.slug == "wishlist" }
        assertEquals(ScanGradeBucket.UNGRADED, ScanGradeBucket.from(wishlist.scanGrade)) // null
    }
}
