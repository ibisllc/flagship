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

    private fun addEnabled() = composeRule.onAllNodes(hasTestTag("home-add-server") and androidx.compose.ui.test.isEnabled())
        .fetchSemanticsNodes().isNotEmpty()

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

    // Device report 2026-10-18 (A-3): Cancel order told a person with a healthy
    // connection to check it. The reason shows in plain words (no status line,
    // no "error code: 1102"), the order stays, and the button runs it again.
    @Test
    fun cancelOrderSaysWhyItFailedAndTheSameButtonTriesAgain() {
        launch(tab = "home", adminRoot = true, podsVariant = "pending-ghost")
        waitText("Home2", 20_000)
        val flagship = com.flagshipserver.app.core.GymProbe.flagship!!
        flagship.failure = com.flagshipserver.app.core.HttpException(503, "error code: 1102")
        tapText("Home2")
        waitUntilExists("pending-cancel-order-button")
        tap("pending-cancel-order-button")
        waitUntilExists("pending-cancel-error", timeoutMs = 20_000)
        val shown = textOfTag("pending-cancel-error")
        gymShot("cancel-order-failed")
        assertTrue(shown, shown.contains("temporary problem"))
        assertTrue(shown, !shown.contains("1102") && !shown.contains("HTTP"))
        assertTrue("the order stays", com.flagshipserver.app.core.GymProbe.appState!!.pods.value.any { it.fqdn.startsWith("home2.") })

        flagship.failure = null
        tap("pending-cancel-order-button")
        eventually(20_000, "the order is cancelled") {
            com.flagshipserver.app.core.GymProbe.appState!!.pods.value.none { it.fqdn.startsWith("home2.") }
        }
        assertEquals(1, flagship.releasedServerNames.size)
    }

    // Device report 2026-10-18 (A-4): "Failed: Setup stopped while Expanding the
    // disk to 68 GB (line 66)" leaked a shell line number, and "Run in
    // background" was the only button. The text loses the line number and the
    // screen offers to start again (cancel the order) or to contact us.
    @Test
    fun aStoppedInstallShowsNoShellLineAndOffersWhatToDoNext() {
        launch(tab = "home", adminRoot = true, podsVariant = "pending-ghost")
        waitText("Home2", 20_000)
        val flagship = com.flagshipserver.app.core.GymProbe.flagship!!
        val serial = com.flagshipserver.app.core.DemoFixtures.GHOST_ORDER_SERIAL
        flagship.provisionStatuses[serial] = com.flagshipserver.app.api.ProvisionStatusRecord(
            serial = serial,
            phase = "error",
            detail = "Setup stopped while Expanding the disk to 68 GB (line 66)",
            updatedAt = System.currentTimeMillis(),
            history = listOf(
                com.flagshipserver.app.api.ProvisionStatusEntry("installing", null, System.currentTimeMillis() - 1000),
                com.flagshipserver.app.api.ProvisionStatusEntry("error", "Setup stopped while Expanding the disk to 68 GB (line 66)", System.currentTimeMillis()),
            ),
        )
        tapText("Home2")
        waitUntilExists("setup-stopped", timeoutMs = 20_000)
        gymShot("setup-stopped")
        waitText("Expanding the disk to 68 GB")
        assertEquals(0, textCount("line 66"))
        assertEquals(0, textCount("(line"))
        assertEquals(1, tagCount("setup-stopped-contact"))
        tap("setup-stopped-start-again")
        eventually(20_000, "the order is cancelled") {
            com.flagshipserver.app.core.GymProbe.appState!!.pods.value.none { it.fqdn.startsWith("home2.") }
        }
        assertEquals(1, flagship.releasedServerNames.size)
    }

    // Device report 2026-10-18 (A-7): Trusted devices showed "HTTP 503: error
    // code: 1102". Plain sentence, and Try again loads the list.
    @Test
    fun trustedDevicesShowAPlainSentenceAndTryAgainLoadsTheList() {
        launch(tab = "settings", adminRoot = true)
        waitUntilExists("settings-title")
        val flagship = com.flagshipserver.app.core.GymProbe.flagship!!
        flagship.failure = com.flagshipserver.app.core.HttpException(503, "error code: 1102")
        tap("settings-trusted-devices")
        waitUntilExists("trusted-devices-error", timeoutMs = 20_000)
        gymShot("trusted-devices-error")
        assertEquals(0, textCount("1102"))
        assertEquals(0, textCount("HTTP"))
        waitText("temporary problem")
        flagship.failure = null
        tap("trusted-devices-retry")
        waitGone("trusted-devices-error", 20_000)
    }

    // A-5/A-6: "connection closed" under Peer-backup (and the Services tab).
    @Test
    fun peerBackupSaysTheConnectionDroppedInPlainWordsAndRetries() {
        launch(tab = "settings", adminRoot = true)
        waitUntilExists("settings-title")
        val screens = com.flagshipserver.app.api.MockScreensClient.smokeInstance!!
        screens.failure = java.io.IOException("connection closed")
        tap("settings-peer-backup")
        waitText("The connection dropped", 20_000)
        gymShot("peer-backup-dropped")
        assertEquals(0, textCount("connection closed"))
        screens.failure = null
        tapText("Try again")
        waitUntilExists("peer-backup", timeoutMs = 20_000)
        waitTextGone("The connection dropped", 20_000)
    }

    // Device report 2026-10-18 (#6): Home's header said "Elated Iris > Pixel" and
    // then just "elated-iris". It follows the names as they are learned (the
    // header didn't recompose) and keeps them across a relaunch (the unit test
    // PresentationNameStoreTest; a scenario's launch wipes saved settings).
    @Test
    fun homeShowsTheAccountAndDeviceNamesAsSoonAsTheyAreKnown() {
        launch(tab = "home", adminRoot = true)
        waitUntilExists("home-title")
        composeRule.runOnUiThread {
            com.flagshipserver.app.core.GymProbe.appState!!.cachePresentationNames("Elated Iris", "Pixel")
        }
        waitText("Elated Iris > Pixel")
        gymShot("home-header-names")
    }
    // Device report 2026-10-18 (A-9): Add/Restore server sat where the card above
    // it had been, so a tap right after the card went landed on something else.
    // It waits for the layout to settle after the card appears or goes.
    @Test
    fun addServerWaitsForTheLayoutToSettleWhenTheCardAboveItGoes() {
        launch(tab = "home", adminRoot = true)
        waitUntilExists("home-add-server")
        val app = com.flagshipserver.app.core.GymProbe.appState!!
        // Let the first layout settle, then show the card above it and take it away.
        eventually(5_000, "Add/Restore enabled once Home settled") { addEnabled() }
        composeRule.runOnUiThread { app.setHasCloudRecovery(false) }
        waitUntilExists("recovery-backup-banner")
        eventually(5_000, "Add/Restore enabled again") { addEnabled() }
        // The layout just moved: for a moment a tap would land where the card was.
        composeRule.mainClock.autoAdvance = false
        try {
            composeRule.runOnUiThread { app.setHasCloudRecovery(true) }
            composeRule.mainClock.advanceTimeByFrame()
            composeRule.mainClock.advanceTimeBy(100)
            assertTrue("Add/Restore takes no tap while the layout moves", !addEnabled())
            composeRule.mainClock.advanceTimeBy(com.flagshipserver.app.ui.screens.ADD_SETTLE_MS + 100)
            assertTrue("and works again once it settled", addEnabled())
        } finally {
            composeRule.mainClock.autoAdvance = true
        }
        gymShot("add-server-settled")
    }
}
