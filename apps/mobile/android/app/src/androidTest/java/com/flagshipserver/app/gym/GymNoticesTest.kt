// GYM Android: security notices (docs/security-notices.md section 6.6), the same
// five scenarios as the webapp's tools/gym/src/suites/webNotices.ts. A throwaway
// authority (NoticeGymAuthority) stands in for the maintainers' YubiKey and the
// mock `.com` answers the poll; the app's own poller keeps the baked pin unless
// a scenario stands the throwaway one in, so a forged lock is refused here as it
// is in production. NO BACKEND.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.espresso.Espresso
import com.flagshipserver.app.core.GymSeams
import com.flagshipserver.app.core.NoticeFetch
import com.flagshipserver.app.core.NoticeFetcher
import com.flagshipserver.app.core.NoticeGymAuthority
import com.flagshipserver.app.core.NoticeOutcome
import com.flagshipserver.app.core.SecurityNoticeCenter
import com.flagshipserver.app.core.SecurityNoticeCopy
import com.flagshipserver.app.core.UpdateLock
import com.flagshipserver.app.core.UpdateRequiredException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class GymNoticesTest : GymBase() {
    private val day = 86_400_000L
    private val now = System.currentTimeMillis()
    private val authority = NoticeGymAuthority(now = now)
    private val center get() = SecurityNoticeCenter.shared!!

    /** The mock `.com` answers the next poll with [notice] (signed by [auth]), and the app polls. */
    private fun serve(notice: JsonElement, auth: NoticeGymAuthority = authority) {
        GymSeams.noticeFetcher = NoticeFetcher { NoticeFetch.Document(auth.response(notice)) }
        runBlocking { center.refresh() }
    }

    /** Stand the throwaway authority in for the baked pin, as the webapp gym does. */
    private fun trustThrowawayAuthority() {
        GymSeams.noticePin = authority.pin
    }

    private fun lock(seq: Long = 3, lockFrom: Long = now - 1_000, auth: NoticeGymAuthority = authority) = auth.notice(
        seq = seq, kind = "update-required", validFrom = now - day, validUntil = now + 10 * day,
        eventAt = now + 2 * day, lockFrom = lockFrom,
        platforms = mapOf("android" to (9L to 1L), "ios" to (12L to 1L), "web" to (150L to 1L)),
        advisoryId = "FSA-2026-001", reason = "A flaw in how a signed message is checked lets an attacker act as you.",
        message = "You must update Flagship by {date}. Older versions will stop working.",
    )

    private fun reevaluate() = runBlocking { center.evaluate() }

    @Test
    fun aMaintenanceNoticeShowsADismissibleBannerWithTheDate() {
        launch(tab = "home")
        waitUntilExists("home-title", 20_000)
        trustThrowawayAuthority()
        val event = now + 3 * day
        serve(
            authority.notice(
                seq = 1, kind = "maintenance", validFrom = now - day, validUntil = now + 10 * day, eventAt = event,
                message = "We will update on {date}. Your servers keep running, but flagshipserver.com may be briefly unavailable.",
            ),
        )
        waitUntilExists("notice-banner", 15_000)
        val text = textOfTag("notice-banner-text")
        assertTrue(text, text.contains("may be briefly unavailable."))
        assertTrue("the date is filled in the person's own format: $text", text.contains(SecurityNoticeCopy.formatDate(event)))
        assertFalse(text.contains("{date}"))
        assertEquals("no lock", 0, tagCount("update-lock"))
        assertEquals("no Update button on a maintenance banner", 0, tagCount("notice-banner-update"))
        gymShot("notice-banner")
        tap("notice-banner-dismiss")
        waitGone("notice-banner")
        assertEquals(1, tagCount("home-title"))
    }

    @Test
    fun aVerifiedUpdateRequiredNoticeLocksTheAppUntilItIsUpdated() {
        launch(tab = "home", adminRoot = true)
        waitUntilExists("home-title", 20_000)
        // A menu is open when the lock arrives: it must close, not stay operable above the lock.
        tap("home-add-server")
        waitUntilExists("home-restore-backup")
        trustThrowawayAuthority()
        serve(lock())
        waitUntilExists("update-lock", 15_000)
        composeRule.waitUntil(10_000) { tagCount("home-add-sheet") == 0 }
        assertEquals(0, tagCount("home-restore-backup"))
        assertEquals("the app behind the lock is inaccessible", 0, tagCount("home-title"))
        assertTrue(UpdateLock.isLocked)

        assertEquals("Update required", textOfTag("update-lock-title"))
        assertTrue(textOfTag("update-lock-kicker").equals("Security update", ignoreCase = true))
        assertTrue(textOfTag("update-lock-body").startsWith("You must update Flagship by "))
        assertEquals("Why: A flaw in how a signed message is checked lets an attacker act as you.", textOfTag("update-lock-why"))
        assertEquals(
            "Your accounts and servers are unchanged and nothing has been deleted. Flagship is paused on this device until you update.",
            textOfTag("update-lock-reassure"),
        )
        assertTrue(composeRule.onAllNodes(hasText("Update Flagship")).fetchSemanticsNodes().isNotEmpty())
        assertEquals("Back up my account key", textOfTag("update-lock-backup"))
        assertEquals("Sign out", textOfTag("update-lock-signout"))
        assertEquals("Advisory FSA-2026-001 · Signed by the Flagship maintainers", textOfTag("update-lock-meta"))
        gymShot("update-lock")

        // Nothing is sent: a write to .com and any call to a box are refused before they leave the phone.
        val http = com.flagshipserver.app.core.HttpClientFactory.build()
        for (url in listOf("https://home.me.flagship.services/api/screens/x", "https://recovery.flagshipserver.com/x")) {
            try {
                http.newCall(okhttp3.Request.Builder().url(url).get().build()).execute().close()
                fail("a request to $url left the app while locked")
            } catch (_: UpdateRequiredException) {
            }
        }
        try {
            http.newCall(
                okhttp3.Request.Builder().url("https://flagshipserver.com/api/anything")
                    .post(okhttp3.RequestBody.create(null, "{}")).build(),
            ).execute().close()
            fail("a write to .com left the app while locked")
        } catch (_: UpdateRequiredException) {
        }

        // The update opens the app's own store listing.
        tap("update-lock-update")
        eventually(what = "the store listing opened") {
            startedIntents.any { it.action == android.content.Intent.ACTION_VIEW && it.dataString == SecurityNoticeCopy.STORE_URL }
        }

        // The account key backup is reachable above the lock, and Back returns to it.
        tap("update-lock-backup")
        waitUntilExistsDesc("keyfile-export", 15_000)
        gymShot("backup-above-lock")
        Espresso.pressBack()
        waitUntilExists("update-lock-title")
        assertEquals(0, tagCount("home-title"))

        // Sign out asks first; Cancel keeps the lock.
        tap("update-lock-signout")
        waitText("Sign out?")
        tapText("Cancel")
        waitTextGone("Sign out?")
        assertEquals(1, tagCount("update-lock-title"))
    }

    @Test
    fun theLockLiftsWhenTheNoticeEndsAndAnOlderNoticeCannotBringItBack() {
        launch(tab = "home")
        waitUntilExists("home-title", 20_000)
        trustThrowawayAuthority()
        serve(lock(seq = 5))
        waitUntilExists("update-lock", 15_000)

        // Past validUntil a lock is never shown, however stale the cache.
        GymSeams.noticeClockOffsetMs = 11 * day
        reevaluate()
        waitGone("update-lock")
        waitUntilExists("home-title")
        GymSeams.noticeClockOffsetMs = 0
        reevaluate()
        waitUntilExists("update-lock")

        // A signed all clear with a higher seq supersedes it.
        serve(authority.notice(seq = 6, kind = "none", validFrom = now - day, validUntil = now + 10 * day, message = ""))
        waitGone("update-lock")
        waitUntilExists("home-title")
        gymShot("notice-lock-lifted")

        // Replaying the older lock (seq 5) is refused as a rollback.
        serve(lock(seq = 5))
        assertEquals(0, tagCount("update-lock"))
        assertTrue(center.outcome.value is NoticeOutcome.None)
        assertFalse(UpdateLock.isLocked)
        assertEquals(6L, center.load().highestSeq)
    }

    @Test
    fun failsOpenAForgedLockAnUnreachableEndpointAndJunkLockNothing() {
        launch(tab = "home")
        waitUntilExists("home-title", 20_000)
        // The app keeps its baked pin: a lock signed by any other chain is refused.
        GymSeams.noticePin = null
        serve(lock())
        assertEquals(0, tagCount("update-lock"))
        assertEquals(0, tagCount("notice-banner"))
        GymSeams.noticeFetcher = NoticeFetcher { NoticeFetch.Failed }
        runBlocking { center.refresh() }
        GymSeams.noticeFetcher = NoticeFetcher { NoticeFetch.Document("<html>502 bad gateway</html>") }
        runBlocking { center.refresh() }
        GymSeams.noticeFetcher = NoticeFetcher { NoticeFetch.Document("""{"version":1,"notice":{"type":"SecurityNotice"},"mandates":[]}""") }
        runBlocking { center.refresh() }
        // A window over 30 days is unsignable, so it cannot even be built; a trusted authority's
        // notice past its window still locks nothing.
        trustThrowawayAuthority()
        serve(
            authority.notice(
                seq = 9, kind = "update-required", validFrom = now - 20 * day, validUntil = now - 1 * day, eventAt = 0,
                lockFrom = now - 10 * day, platforms = mapOf("android" to (9L to 1L)),
                advisoryId = "FSA-2026-002", reason = "Expired.", message = "You must update Flagship.",
            ),
        )
        assertEquals(0, tagCount("update-lock"))
        assertFalse(UpdateLock.isLocked)
        assertEquals(1, tagCount("home-title"))
        gymShot("notice-forged-ignored")
    }

    @Test
    fun anUpdateRequiredNoticeNagsUntilItsLockDateThenLocks() {
        launch(tab = "home")
        waitUntilExists("home-title", 20_000)
        trustThrowawayAuthority()
        serve(lock(seq = 4, lockFrom = now + 2 * day))
        waitUntilExists("notice-banner", 15_000)
        waitUntilExists("notice-banner-update")
        assertTrue(textOfTag("notice-banner-text").startsWith("You must update Flagship by "))
        assertEquals("Update", textOfTag("notice-banner-update"))
        assertEquals("Dismiss", textOfTag("notice-banner-dismiss"))
        assertEquals(0, tagCount("update-lock"))
        assertEquals(1, tagCount("home-title"))
        gymShot("notice-grace-nag")

        // The lock date passes: the banner gives way to the lock.
        GymSeams.noticeClockOffsetMs = 3 * day
        reevaluate()
        waitUntilExists("update-lock", 15_000)
        waitGone("notice-banner")
        assertEquals(0, tagCount("home-title"))
    }
}
