// GYM Android: the flows from manual tests on Harry's phone (2026-10-16,
// scratchpad manual-tests M3, M6, M9), as no-backend scenarios.
//   M3: cloud recovery set-up with a passkey app that returns its key only on
//       an assertion (Samsung Pass) succeeds the first time and then shows the
//       configured state, worded for any passkey app.
//   M6: Create server starts with the subdomain its preview shows, so Next
//       goes on without "Enter a subdomain.".
//   M9: the create draft survives the activity being recreated.

package com.flagshipserver.app.gym

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymDeviceBugsTest : GymBase() {

    private fun waitForText(text: String, timeoutMs: Long = 10_000) {
        composeRule.waitUntil(timeoutMs) {
            composeRule.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun subdomainField() =
        composeRule.onNode(hasSetTextAction() and hasAnyAncestor(hasTestTag("cs-name-field")))

    @Test
    fun cloudRecoverySetUpSucceedsWhenThePasskeyAppGivesTheKeyOnlyOnAssertion() {
        launch(tab = "settings", adminRoot = true, fakePasskeys = true)
        waitUntilExists("settings-title")
        composeRule.onNodeWithText("Cloud recovery").performScrollTo().performClick()
        waitUntilExists("recovery-setup")
        // Provider-neutral: the passkey may live in Samsung Pass, not Google.
        composeRule.onNodeWithText("Samsung Pass", substring = true).assertExists()
        composeRule.onNodeWithText("Google account that holds", substring = true).assertDoesNotExist()
        gymShot("recovery-not-set-up")

        composeRule.onNodeWithTag("recovery-setup").performClick()
        composeRule.waitForIdle()
        val fields = composeRule.onAllNodes(hasSetTextAction())
        fields[0].performTextInput("correct horse battery")
        fields[1].performTextInput("correct horse battery")
        composeRule.onNodeWithText("Configure").performClick()

        // First attempt, no "Something went wrong": the configured state.
        waitUntilExists("recovery-active", timeoutMs = 30_000)
        composeRule.onNodeWithText("Something went wrong", substring = true).assertDoesNotExist()
        composeRule.onNodeWithTag("recovery-setup").assertDoesNotExist()
        composeRule.onNodeWithTag("recovery-new-device-hint").assertExists()
        gymShot("recovery-active")
    }

    @Test
    fun createServerStartsWithTheSubdomainItsPreviewShows() {
        launch(tab = "home", adminRoot = true)
        addNewServer()
        waitUntilExists("cs-name-field")
        val value = subdomainField().fetchSemanticsNode().config
            .getOrNull(SemanticsProperties.EditableText)?.text
        // The demo account already has a "home" server, so the next free one.
        assertTrue("prefilled subdomain was \"$value\"", value != null && value.startsWith("home"))
        gymShot("create-prefilled")
        composeRule.onNodeWithTag("cs-next-button").performScrollTo().performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Enter a subdomain.").assertDoesNotExist()
        waitForText("Step 2 of 3")
    }

    @Test
    fun theCreateDraftSurvivesTheActivityBeingRecreated() {
        launch(tab = "home", adminRoot = true)
        addNewServer()
        nameServerAndNext("gymbox")
        waitForText("Step 2 of 3")
        gymShot("before-recreate")

        recreateActivity()

        waitForText("Step 2 of 3")
        gymShot("after-recreate")
        // Back to step 1: the subdomain typed before is still there.
        composeRule.onNodeWithText("Back", substring = false).performScrollTo().performClick()
        waitUntilExists("cs-name-field")
        val value = subdomainField().fetchSemanticsNode().config
            .getOrNull(SemanticsProperties.EditableText)?.text
        assertEquals("gymbox", value)
    }

    // M14: the passphrase typed into both fields and the acknowledgement
    // ticked must enable "Create backup file".
    @Test
    fun keyBackupEnablesCreateOnceTypedAndAcknowledged() {
        launch(tab = "settings", adminRoot = true)
        waitUntilExists("settings-title")
        composeRule.onNodeWithText("Back up account key").performScrollTo().performClick()
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodes(androidx.compose.ui.test.hasContentDescription("keyfile-export")).fetchSemanticsNodes().isNotEmpty()
        }
        val create = androidx.compose.ui.test.hasContentDescription("keyfile-export-create")
        composeRule.onNode(create).assertIsNotEnabled()
        val fields = composeRule.onAllNodes(hasSetTextAction())
        fields[0].performTextInput("alllowercase")
        composeRule.onNodeWithText("Too weak.", substring = true).assertExists()
        composeRule.onNodeWithText("mixing at least three of", substring = true).assertExists()
        fields[0].performTextClearance()
        fields[0].performTextInput("Caracal-keyfile-1016x")
        fields[1].performTextInput("Caracal-keyfile-1016x")
        composeRule.onNode(androidx.compose.ui.test.hasContentDescription("keyfile-export-ack-control"))
            .performScrollTo().performClick()
        composeRule.waitForIdle()
        gymShot("key-backup-ready")
        composeRule.onNode(create).performScrollTo().assertIsEnabled()
    }

    // Device report 2026-10-18 (A-2): a pending order beside a ghost row
    // ("server.<apex>", no account part, holding the real order's number)
    // shows only the real order once Home has read the account's orders.
    @Test
    fun aGhostRowWithNoAccountPartNeverStaysOnHome() {
        launch(tab = "home", adminRoot = true, podsVariant = "pending-ghost")
        waitText("Home2", 20_000)
        fun fqdns() = com.flagshipserver.app.core.GymProbe.appState!!.pods.value.map { it.fqdn }
        // The ghost is seeded first; only the reconcile that reads the account's
        // orders can remove it, so waiting for it to go proves the fix.
        composeRule.waitUntil(20_000) { "server.flagship.services" !in fqdns() }
        gymShot("pending-order-no-ghost")
        assertTrue("the real order stays: ${fqdns()}", fqdns().any { it.startsWith("home2.") })
        composeRule.onAllNodes(androidx.compose.ui.test.hasText("server.", substring = true))
            .fetchSemanticsNodes().let { assertTrue("no ghost row", it.isEmpty()) }
    }
}
