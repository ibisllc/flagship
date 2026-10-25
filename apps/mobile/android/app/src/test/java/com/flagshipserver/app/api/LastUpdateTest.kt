// The box's verdict on the last update order (server-detail `lastUpdate`):
// an older daemon omits it, and the card copy matches web and iOS.

package com.flagshipserver.app.api

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LastUpdateTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val a = "a".repeat(40)
    private val b = "b".repeat(40)
    private val base = """"serverFqdn":"home.harry.flagship.services","username":"harry","daemonVersion":"0.1.0","startedAt":1,"uptimeMs":2,"serviceCount":0,"pairedSessionCount":0,"recentInstallEvents":[]"""

    @Test
    fun olderDaemonWithoutTheFieldStillDecodes() {
        val d = json.decodeFromString(ServerDetailResponse.serializer(), "{$base}")
        assertNull(d.lastUpdate)
    }

    @Test
    fun rollbackNamesBothCommits() {
        val d = json.decodeFromString(
            ServerDetailResponse.serializer(),
            """{$base,"lastUpdate":{"outcome":"rolled-back","at":5,"previousCommit":"$a","targetCommit":"$b","bootAttempts":3}}""",
        )
        assertEquals(
            "The last update to bbbbbbbb didn't start cleanly, so the server went back to aaaaaaaa on its own.",
            d.lastUpdate?.summary,
        )
    }

    @Test
    fun refusalsExplainKnownReasonsOnly() {
        assertEquals(
            "The server refused the last update: Flagship's maintainers haven't endorsed that release.",
            LastUpdate(outcome = "refused", at = 1, reason = "unendorsed").summary,
        )
        assertEquals("The server refused the last update.", LastUpdate(outcome = "refused", at = 1, reason = "new").summary)
        assertNull(LastUpdate(outcome = "exploded", at = 1).summary)
    }

    @Test
    fun everyRefusalReasonIsItsOwnWholeSentence() {
        val expected = mapOf(
            "unendorsed" to "The server refused the last update: Flagship's maintainers haven't endorsed that release.",
            "from-commit-mismatch" to "The server refused the last update: the server was no longer on the version the update was made for. Send it again.",
            "apply-failed" to "The server refused the last update: it couldn't download or build the new version. Nothing changed.",
            "rejected" to "The server refused the last update: the request wasn't signed by this account's admin key.",
            "stale" to "The server refused the last update: the request was too old. Send it again.",
            "wrong-domain" to "The server refused the last update: the request was for a different server.",
        )
        for ((reason, sentence) in expected) {
            assertEquals(reason, sentence, LastUpdate(outcome = "refused", at = 1, reason = reason).summary)
        }
        assertTrue(LastUpdate(outcome = "refused", at = 1).needsAttention)
    }

    @Test
    fun rollbackSentencesAreWhole() {
        assertEquals(
            "The last update to bbbbbbbb didn't start cleanly, so the server went back on its own.",
            LastUpdate(outcome = "rolled-back", at = 1, targetCommit = b).summary,
        )
        assertEquals(
            "The last update didn't start cleanly, so the server went back to aaaaaaaa on its own.",
            LastUpdate(outcome = "rolled-back", at = 1, previousCommit = a).summary,
        )
        assertEquals(
            "The last update didn't start cleanly, so the server went back on its own.",
            LastUpdate(outcome = "rolled-back", at = 1).summary,
        )
        assertFalse(LastUpdate(outcome = "rolled-back", at = 1, targetCommit = b).needsAttention)
    }

    @Test
    fun aRollbackTheFloorRefusedReadsAsKeptInRecovery() {
        val d = json.decodeFromString(
            ServerDetailResponse.serializer(),
            """{$base,"lastUpdate":{"outcome":"rolled-back","at":5,"previousCommit":"$a","targetCommit":"$b","bootAttempts":3,"rollbackRefused":true}}""",
        )
        val stuck = d.lastUpdate!!
        assertTrue(stuck.keptInRecovery)
        assertTrue(stuck.needsAttention)
        assertEquals(
            "The update to bbbbbbbb didn't start cleanly, and the version before it is too old to go back to safely. The server stays on bbbbbbbb in recovery mode until a fixed update arrives: install it from this card when it's offered. Your apps and data are kept.",
            stuck.summary,
        )
        assertFalse(stuck.summary!!.contains("on its own"))
        assertEquals(
            "The last update didn't start cleanly, and the version before it is too old to go back to safely. The server stays on the new version in recovery mode until a fixed update arrives: install it from this card when it's offered. Your apps and data are kept.",
            LastUpdate(outcome = "rolled-back", at = 1, rollbackRefused = true).summary,
        )
    }

    @Test
    fun updateReportsSettingDecodesTheBoxAnswer() {
        assertEquals(
            UpdateReportsSetting(share = true, source = "owner"),
            json.decodeFromString(UpdateReportsSetting.serializer(), """{"share":true,"source":"owner","sends":["release"]}"""),
        )
        assertEquals(UpdateReportsSetting(share = false), json.decodeFromString(UpdateReportsSetting.serializer(), """{"share":false}"""))
    }
}
