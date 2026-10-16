// GYM Android button sweep — Activity: the box's activity log merged with the
// account's events (the owner's own writes left out, a co-manager named),
// Refresh, the server filter, Open approvals and Open audit log (Load more).
// NO BACKEND: the mock box serves its log, the mock `.com` the account events.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.test.espresso.Espresso
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymActivityTest : GymBase() {

    private fun open() {
        launch(tab = "activity", username = "bright-maple")
        waitUntilExists("activity-title", 20_000)
    }

    /** The feed merges the box's log and the account's events, newest first,
     *  names a co-manager, and leaves the owner's own writes out. */
    @Test
    fun feedMergesTheBoxLogAndAccountEvents() {
        open()
        waitText("Server updated", 20_000)
        waitText("Backup ready")
        waitText("A shared person signed in by Sam")
        waitText("App installed")
        waitText("A device joined the account")
        assertEquals("the owner's own writes stay out", 0, textCount("/api/screens/services"))
        gymShot("activity-feed")
        tapText("Refresh")
        waitText("Server updated", 15_000)
    }

    /** "All servers" and one server: account-wide rows stay either way. */
    @Test
    fun serverFilterKeepsAccountRows() {
        open()
        waitText("Server updated", 20_000)
        tap("pod-switcher")
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodes(tagPrefix("pod-switcher-item-demo-office"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onAllNodes(tagPrefix("pod-switcher-item-demo-office"), useUnmergedTree = true).onFirst().performClick()
        waitText("A device joined the account", 15_000)
        gymShot("activity-office")
    }

    @Test
    fun openApprovalsAndTheAuditLog() {
        launch(tab = "activity", username = "bright-maple", podsVariant = "awaiting-unlock")
        waitUntilExists("activity-title", 20_000)
        tapText("Open approvals", 15_000)
        composeRule.waitUntil(15_000) { textCount("Open approvals") == 0 }
        gymShot("approvals")
        Espresso.pressBack()
        tapText("Open audit log", 20_000)
        waitUntilExists("audit-log-list", 15_000)
        waitText("A device left the account", 15_000)
        if (tagCount("audit-log-load-more") > 0) tap("audit-log-load-more")
        gymShot("audit-log")
    }
}
