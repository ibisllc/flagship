// GET /api/screens/updates decoding + the sheet's release grouping, matching
// the daemon's updateReleases.ts output and the iOS UpdateServerSheet.

package com.flagshipserver.app.api

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseCatalogTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val cur = "a".repeat(40)
    private val newest = "b".repeat(40)
    private val newer = "c".repeat(40)
    private val old = "d".repeat(40)

    private fun entry(commit: String, tag: String, relation: String) =
        """{"commit":"$commit","releaseId":"r-$tag","tag":"$tag","endorsedAt":"2026-10-11T12:00:00.000Z","relation":"$relation"}"""

    private val body = """{"checkedAt":1760000000000,"currentCommit":"$cur","latest":${entry(newest, "v3", "newer")},"releases":[${entry(newest, "v3", "newer")},${entry(newer, "v2", "newer")},${entry(cur, "v1", "current")},${entry(old, "v0", "older")}],"futureField":1}"""

    @Test
    fun decodesTheDaemonShape() {
        val c = json.decodeFromString(ReleaseCatalogResponse.serializer(), body)
        assertEquals(newest, c.latest?.commit)
        assertEquals("v3", c.latest?.tag)
        assertEquals(4, c.releases.size)
        assertNull(c.stale)
        assertEquals("v1", c.currentTag)
    }

    @Test
    fun upToDateAndStaleDecode() {
        val c = json.decodeFromString(
            ReleaseCatalogResponse.serializer(),
            """{"checkedAt":1,"currentCommit":null,"latest":null,"releases":[],"stale":true}""",
        )
        assertNull(c.latest)
        assertNull(c.currentCommit)
        assertTrue(c.stale == true)
        assertNull(c.currentTag)
    }

    @Test
    fun groupsReleasesLikeTheSheet() {
        val c = json.decodeFromString(ReleaseCatalogResponse.serializer(), body)
        assertEquals(listOf(newer), c.otherNewer.map { it.commit })
        assertEquals(listOf(old), c.older.map { it.commit })
    }
}
