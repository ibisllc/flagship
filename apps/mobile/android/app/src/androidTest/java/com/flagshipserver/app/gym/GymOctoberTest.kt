// GYM Android mock tier — the October 2026 features, twins of iOS
// GymOctoberTests (handles shared where the surfaces name them alike;
// docs/ui-test-gym.md §8): an app's Internet access requests, access control,
// API keys, the Database browser, where an app runs, the update card, and the
// Flagship Inference entry. NO BACKEND: smoke mode seeds DemoFixtures and the
// mock clients; the smoke seam passes the biometric prompts, so signed orders
// reach the mock, which accepts any signature.

package com.flagshipserver.app.gym

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import org.junit.Assert.assertTrue
import org.junit.Test

class GymOctoberTest : GymBase() {

    private fun tagStartsWith(prefix: String) = SemanticsMatcher("testTag starts with $prefix") {
        it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith(prefix) == true
    }

    private fun waitUntilTextExists(text: String, timeoutMs: Long = 10_000) {
        composeRule.waitUntil(timeoutMs) {
            composeRule.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
        }
    }

    /** Services → the demo Plants app's page (opened by its unique summary line). */
    private fun openPlants() {
        launch(tab = "apps")
        waitUntilTextExists("Houseplant watering tracker", timeoutMs = 20_000)
        composeRule.onNodeWithText("Houseplant watering tracker").performClick()
        composeRule.waitForIdle()
    }

    private fun openHomeServerPage() {
        launch(tab = "home")
        waitUntilTextExists("Living-room mini-PC", timeoutMs = 20_000)
        composeRule.onNodeWithText("Living-room mini-PC").performScrollTo().performClick()
        composeRule.waitForIdle()
    }

    // ─── App access list on the service page ─────────────────────────────────

    /** Plants asked for a host at install; Allow signs the edited list and the
     *  request leaves the page. */
    @Test
    fun serviceAccessPendingAllow() {
        openPlants()
        waitUntilExists("service-detail-access-allow", timeoutMs = 20_000)
        val before = composeRule.onAllNodesWithTag("service-detail-access-allow").fetchSemanticsNodes().size
        assertTrue("Plants has a host waiting", before >= 1)
        composeRule.onAllNodesWithTag("service-detail-access-allow").onFirst().performScrollTo()
        gymShot("service-access-pending")
        composeRule.onAllNodesWithTag("service-detail-access-allow").onFirst().performClick()
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodesWithTag("service-detail-access-allow").fetchSemanticsNodes().size == before - 1
        }
        gymShot("service-access-allowed")
    }

    // ─── Access control: Open to all / Members only ──────────────────────────

    @Test
    fun accessControlSwitchesToMembersOnly() {
        openPlants()
        waitUntilExists("service-detail-access-row", timeoutMs = 20_000)
        composeRule.onNodeWithTag("service-detail-access-row").performScrollTo().performClick()
        waitUntilExists("service-access-restrict-toggle", timeoutMs = 15_000)
        waitUntilTextExists("Anyone can open it", timeoutMs = 15_000)
        waitUntilTextExists("MEMBERS (")
        gymShot("access-control-open")
        composeRule.onNodeWithTag("service-access-mode-members").performClick()
        waitUntilExists("service-access-members-only-confirm")
        composeRule.onNodeWithTag("service-access-members-only-confirm").performClick()
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodesWithText("Only members and you can open it", substring = true)
                .fetchSemanticsNodes().isNotEmpty()
        }
        gymShot("access-control-members-only")
    }

    // ─── API keys + Database ─────────────────────────────────────────────────

    @Test
    fun apiKeyCreateShowsTheSecretOnce() {
        openPlants()
        waitUntilExists("service-detail-api-keys", timeoutMs = 20_000)
        composeRule.onNodeWithTag("service-detail-api-keys").performScrollTo()
        waitUntilTextExists("Garden sensor", timeoutMs = 15_000)
        composeRule.onNodeWithTag("service-detail-api-keys-create").performScrollTo().performClick()
        waitUntilExists("api-key-create-label")
        composeRule.onNodeWithTag("api-key-create-label").performTextInput("Gym sensor")
        composeRule.onNodeWithTag("api-key-create-confirm").performClick()
        waitUntilExists("api-key-created-value", timeoutMs = 15_000)
        gymShot("api-key-created")
    }

    @Test
    fun databaseBrowsesATable() {
        openPlants()
        waitUntilExists("service-detail-database", timeoutMs = 20_000)
        composeRule.onNodeWithTag("service-detail-database").performScrollTo().performClick()
        waitUntilExists("db-table-row", timeoutMs = 15_000)
        composeRule.onAllNodesWithTag("db-table-row").onFirst().performClick()
        waitUntilExists("db-range", timeoutMs = 15_000)
        composeRule.onNodeWithTag("db-range").assertTextContains("230", substring = true)
        gymShot("database-grid")
    }

    // ─── Where an app runs ───────────────────────────────────────────────────

    @Test
    fun runsOnListsTheServers() {
        openPlants()
        composeRule.waitUntil(20_000) {
            composeRule.onAllNodes(tagStartsWith("runs-on-toggle-")).fetchSemanticsNodes().isNotEmpty()
        }
        val rows = composeRule.onAllNodes(tagStartsWith("runs-on-toggle-")).fetchSemanticsNodes().size
        assertTrue("Plants lists every online server it can run on (got $rows)", rows >= 2)
        gymShot("runs-on")
    }

    @Test
    fun serverPageListsItsApps() {
        openHomeServerPage()
        waitUntilExists("server-create-app-here", timeoutMs = 20_000)
        composeRule.onNodeWithTag("server-create-app-here").performScrollTo().assertIsDisplayed()
        assertTrue(composeRule.onAllNodes(tagStartsWith("server-app-")).fetchSemanticsNodes().isNotEmpty())
        gymShot("server-apps")
    }

    // ─── Server order: Make leader stays gray until the box confirms ─────────

    @Test
    fun makeLeaderWaitsForTheServerToConfirm() {
        launch(tab = "home", username = "bright-maple")
        waitUntilTextExists("Office tower, work failover", timeoutMs = 20_000)
        composeRule.onNodeWithText("Office tower, work failover").performScrollTo().performClick()
        waitUntilExists("sd-make-leader", timeoutMs = 20_000)
        composeRule.onNodeWithTag("sd-make-leader").performScrollTo()
        gymShot("server-order-card")
        composeRule.onNodeWithTag("sd-make-leader").performClick()
        waitUntilExists("sd-leader-pending", timeoutMs = 15_000)
        composeRule.onNodeWithTag("sd-leader-status").assertTextContains("This server leads")
        gymShot("server-order-pending")
    }

    // ─── Offline server ──────────────────────────────────────────────────────

    /** A server that stopped reporting (Music) doesn't answer: its page says
     *  it's offline, not "Connecting…" or "never came online". */
    @Test
    fun offlineServerPageSaysOffline() {
        launch(tab = "home")
        waitUntilTextExists("Garage rack, music studio", timeoutMs = 20_000)
        composeRule.onNodeWithText("Garage rack, music studio").performScrollTo().performClick()
        waitUntilExists("server-detail-offline", timeoutMs = 20_000)
        waitUntilTextExists("Offline — last seen")
        gymShot("server-offline")
    }

    // ─── Update this server ──────────────────────────────────────────────────

    @Test
    fun updateCardOffersTheNewRelease() {
        openHomeServerPage()
        waitUntilExistsDesc("sd-update-available", timeoutMs = 20_000)
        composeRule.onNodeWithContentDescription("sd-update-available").performScrollTo()
        composeRule.onNodeWithContentDescription("sd-update-last-outcome").assertExists()
        gymShot("update-card")
    }

    // ─── Flagship Inference ──────────────────────────────────────────────────

    /** Settings → AI keys lists the built-in Flagship Inference provider first,
     *  with the credits line. */
    @Test
    fun flagshipInferenceListedInAiKeys() {
        launch(tab = "settings")
        waitUntilExists("settings-ai-keys", timeoutMs = 20_000)
        composeRule.onNodeWithTag("settings-ai-keys").performScrollTo().performClick()
        waitUntilExists("free-ai-card", timeoutMs = 15_000)
        waitUntilTextExists("Flagship Inference")
        waitUntilTextExists("1,840 free credits left · 500 added each week", timeoutMs = 15_000)
        gymShot("flagship-inference-credits")
    }
}
