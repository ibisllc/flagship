// GYM Android button sweep — Activity: the box's activity log merged with the
// account's events (the owner's own writes left out, a co-manager named),
// Refresh, the server filter, Open approvals and Open audit log (Load more).
// NO BACKEND: the mock box serves its log, the mock `.com` the account events.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.onNodeWithTag
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

    private fun openSection(name: String) {
        tap("activity-section-$name", 20_000)
        waitUntilExists("activity-section-$name-body", 10_000)
    }

    /** Each title opens its list in place, one at a time; the box's log and the
     *  account's events are separate sections, a co-manager is named and the
     *  owner's own writes are left out; every row carries date and time. */
    @Test
    fun sectionsOpenOneAtATimeWithDatesAndTimes() {
        open()
        openSection("server")
        waitText("Server updated", 20_000)
        waitText("Backup ready")
        waitText("A shared person signed in by Sam")
        waitText("App installed")
        assertEquals("the owner's own writes stay out", 0, textCount("/api/screens/services"))
        assertEquals("the account's events wait in their own section", 0, textCount("A device joined the account"))
        val time = textOfTag("activity-row-time")
        assertTrue("date and time to the minute, got $time", Regex("^[A-Z][a-z]{2} \\d{1,2}, (\\d{4}, )?\\d{1,2}:\\d{2} [AP]M$").matches(time))
        gymShot("activity-server-open")
        openSection("account")
        waitText("A device joined the account")
        waitGone("activity-section-server-body")
        assertEquals("one open at a time", 0, textCount("Server updated"))
        gymShot("activity-account-open")
        tap("activity-section-account")
        waitGone("activity-section-account-body")
        tapText("Refresh")
        waitUntilExists("activity-section-server", 15_000)
    }

    /** A long log scrolls inside the section and pages in place: Load more
     *  until "That's everything." */
    @Test
    fun longLogsPageInPlace() {
        launch(tab = "activity", username = "bright-maple")
        screensMock.boxActivityFixture = (90 downTo 1).map {
            com.flagshipserver.app.api.BoxActivityEntry(seq = it, ts = 1_790_000_000_000L + it * 60_000L, action = "x", kind = "server.backup.created")
        }
        waitUntilExists("activity-title", 20_000)
        tapText("Refresh")
        openSection("server")
        // 90 rows are three full pages; the page after them comes back short.
        var rows = tagCount("activity-row-time")
        while (tagCount("activity-everything") == 0) {
            // The list scrolls inside the page: press the button by its action, wherever it sits.
            waitUntilExists("activity-load-more-server", 20_000)
            composeRule.onNodeWithTag("activity-load-more-server")
                .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
            val before = rows
            composeRule.waitUntil(20_000) { tagCount("activity-row-time") > before || tagCount("activity-everything") > 0 }
            rows = tagCount("activity-row-time")
        }
        waitUntilExists("activity-everything", 20_000)
        assertEquals(90, tagCount("activity-row-time"))
        gymShot("activity-everything")
    }

    /** "All servers" and one server: the server section names the one picked,
     *  account-wide rows stay either way. */
    @Test
    fun serverFilterKeepsAccountRows() {
        open()
        tap("pod-switcher")
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodes(tagPrefix("pod-switcher-item-demo-office"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onAllNodes(tagPrefix("pod-switcher-item-demo-office"), useUnmergedTree = true).onFirst().performClick()
        waitText("Server · Office", 15_000)
        openSection("account")
        waitText("A device joined the account", 15_000)
        gymShot("activity-office")
    }

    @Test
    fun openApprovals() {
        launch(tab = "activity", username = "bright-maple", podsVariant = "awaiting-unlock")
        waitUntilExists("activity-title", 20_000)
        openSection("approvals")
        tapText("Open approvals", 15_000)
        composeRule.waitUntil(15_000) { textCount("Open approvals") == 0 }
        gymShot("approvals")
    }
}
