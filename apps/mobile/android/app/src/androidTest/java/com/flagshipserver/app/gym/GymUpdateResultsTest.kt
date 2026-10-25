// GYM Android: the update card's last verdict and "Share update results"
// (docs/support/update-rollback.md §5, docs/runbooks/canary.md §8).
//   A failed update the security floor kept in recovery (`rollbackRefused`) reads as stuck on the
//   new release until a fixed one arrives, never "went back on its own"; a refusal is one whole
//   sentence; the switch reads the box's /api/update-reports and sends { share } on and off.
// NO BACKEND: the mock box answers /api/update-reports like the real owner-only route.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollTo
import com.flagshipserver.app.api.LastUpdate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GymUpdateResultsTest : GymBase() {

    private val target = "9f2c1ab3de4567890abcdef1234567890abcdef1"
    private val previous = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b"

    private fun openHomeServer() {
        openServerFromHome("Living-room mini-PC")
        waitUntilExistsDesc("sd-update-last-outcome", timeoutMs = 20_000)
        composeRule.onNodeWithContentDescription("sd-update-last-outcome").performScrollTo()
    }

    @Test
    fun aRollbackKeptInRecoveryReadsAsStuckAndTheSwitchSendsTheChoice() {
        launch(tab = "home", adminRoot = true)
        screensMock.lastUpdateFixture = LastUpdate(
            outcome = "rolled-back", at = System.currentTimeMillis() - 60_000,
            targetCommit = target, previousCommit = previous, bootAttempts = 3, rollbackRefused = true,
        )
        screensMock.updateReportsShare = false
        openHomeServer()
        waitText("in recovery mode until a fixed update arrives", 10_000)
        // Only the verdict: the Boot unlock card above may say the server reboots on its own.
        val outcome = hasContentDescription("sd-update-last-outcome") and hasText("on its own", substring = true)
        assertEquals(0, composeRule.onAllNodes(outcome).fetchSemanticsNodes().size)
        waitUntilExists("sd-update-reports", 20_000)
        composeRule.onNodeWithTag("sd-update-reports").performScrollTo()
        waitText("Share update results")
        waitText("Never your server's name, your account or anything about your apps.")
        gymShot("update-results")
        tap("sd-update-reports")
        eventually(10_000, "the box was told to share") { screensMock.updateReportsWrites == listOf(true) }
        tap("sd-update-reports")
        eventually(10_000, "the box was told to stop") { screensMock.updateReportsWrites == listOf(true, false) }
        assertFalse(screensMock.updateReportsShare!!)
    }

    @Test
    fun aRefusalIsOneSentenceAndARefusedSessionShowsNoSwitch() {
        launch(tab = "home", adminRoot = true)
        screensMock.lastUpdateFixture = LastUpdate(outcome = "refused", at = System.currentTimeMillis() - 60_000, reason = "stale")
        screensMock.updateReportsShare = null
        openHomeServer()
        waitText("The server refused the last update: the request was too old. Send it again.", 10_000, substring = false)
        Thread.sleep(1_500)
        assertEquals(0, tagCount("sd-update-reports"))
        gymShot("update-refusal")
        assertTrue(screensMock.updateReportsWrites.isEmpty())
    }
}
