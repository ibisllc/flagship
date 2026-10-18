// GYM Android: a real (live) account with no server. The shell runs on the LIVE
// clients, pointed at an unreachable backend so nothing leaves the device, and
// no mock fixture (the demo box's Plants / Wiki / Scratchpad on bright-maple /
// trent) may show anywhere: every tab and every Settings page shows its own
// empty state instead (device bug 2026-10-16: the live client fell back to
// MockScreensClient whenever there was no server session).

package com.flagshipserver.app.gym

import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.espresso.Espresso
import org.junit.Assert.assertTrue
import org.junit.Test

class GymLiveAccountTest : GymBase() {

    private val fixtureWords = listOf("Plants", "Wiki", "Scratchpad", "bright-maple", "trent")

    private fun assertNoFixtures(where: String) {
        composeRule.waitForIdle()
        for (w in fixtureWords) {
            val hits = composeRule.onAllNodesWithText(w, substring = true, useUnmergedTree = true).fetchSemanticsNodes()
            assertTrue("$where shows the mock fixture \"$w\"", hits.isEmpty())
        }
    }

    private fun launchLive(tab: String) = launch(
        tab = tab,
        podsVariant = "none",
        adminRoot = true,
        username = "nimble-caracal",
        live = true,
        apexHost = "flagship.invalid",
    )

    @Test
    fun newLiveAccountWithNoServerShowsNoFixtures() {
        launchLive("home")
        waitUntilExists("home-empty-state")
        assertNoFixtures("Home")
        gymShot("home")

        composeRule.onNodeWithTag("tab-apps").performClick()
        waitUntilExists("services-no-server")
        assertNoFixtures("Services")
        gymShot("services")

        composeRule.onNodeWithTag("tab-activity").performClick()
        waitUntilExists("activity-title")
        // The account's events only; the feed settles (no endless skeleton).
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodesWithText("Loading…").fetchSemanticsNodes().isEmpty()
        }
        assertNoFixtures("Activity")
        gymShot("activity")

        composeRule.onNodeWithTag("tab-settings").performClick()
        waitUntilExists("settings-title")
        assertNoFixtures("Settings")
        gymShot("settings")
    }

    /** Every Settings page opens and settles without a server: no crash, no
     *  fixtures. */
    @Test
    fun settingsPagesWorkWithNoServer() {
        val rows = listOf(
            "Account security", "AI keys", "Cloud recovery", "Profiles",
            "Trusted devices", "Browser sessions", "Remote", "Peer-backup", "Privacy",
        )
        for (row in rows) {
            launchLive("settings")
            waitUntilExists("settings-title")
            composeRule.onNodeWithText(row).performScrollTo().performClick()
            composeRule.waitForIdle()
            Thread.sleep(1_500)
            assertNoFixtures("Settings, $row")
            gymShot("settings-" + row.lowercase().replace(' ', '-'))
            Espresso.pressBackUnconditionally()
        }
    }

    private val rawWords = listOf("HTTP", "error code", "Unable to resolve", "unable to resolve", "connection closed", "Exception", "timeout", "UnknownHost")

    /** Device report 2026-10-18 (A-5..A-7): with the backend unreachable the
     *  pages that load from it say so in plain words and offer Try again. */
    @Test
    fun unreachableBackendShowsPlainSentencesWithARetry() {
        launchLive("settings")
        waitUntilExists("settings-title")
        tap("settings-trusted-devices")
        waitUntilExists("trusted-devices-error", timeoutMs = 30_000)
        gymShot("trusted-devices-unreachable")
        for (w in rawWords) assertTrue("Trusted devices shows \"$w\"", textCount(w) == 0)
        assertTrue(tagCount("trusted-devices-retry") == 1)
        Espresso.pressBackUnconditionally()

        launchLive("settings")
        waitUntilExists("settings-title")
        tap("settings-peer-backup")
        composeRule.waitForIdle()
        Thread.sleep(1_500)
        for (w in rawWords) assertTrue("Peer-backup shows \"$w\"", textCount(w) == 0)
    }

    /** Device report 2026-10-18 (A-8): a build with no live pairing relay says
     *  so plainly instead of failing with the in-memory relay's error. */
    @Test
    fun addADeviceSaysItIsNotAvailableYetWithoutALiveRelay() {
        launchLive("settings")
        waitUntilExists("settings-title")
        tap("settings-trusted-devices")
        waitUntilExistsDesc("trusted-devices-add", timeoutMs = 30_000)
        tapDesc("trusted-devices-add")
        waitUntilExistsDesc("device-pairing-unavailable")
        waitText("Adding a device from this phone isn't available yet. Use the web app or iOS.")
        assertTrue(textCount("MockDevicePairingRelay") == 0)
        gymShot("add-device-unavailable")
    }
}
