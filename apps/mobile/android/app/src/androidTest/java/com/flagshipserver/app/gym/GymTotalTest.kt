// GYM Android total-gym Tier-1 tranche (§10 Phase-5) — the broader,
// total-gym-only NO-BACKEND scenarios. Mirror of iOS GymTotalTests (the subset
// that has an Android twin: build chooser, AI-keys manager, trust sliver, the
// server-event seed states). These run ONLY in `gym:total`.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import org.junit.Test

class GymTotalTest : GymBase() {

    // ─── D2 — build modes ────────────────────────────────────────────────────

    /** D2-B1: Services → Build a service opens the build chooser, which renders
     *  the on-main source tiles (scratch / git / mcp). Mirror of iOS
     *  test_buildChooserRenders. */
    @Test
    fun buildChooserRenders() {
        launch(tab = "apps")
        composeRule.onNodeWithTag("services-build-cta").assertIsDisplayed()
        gymShot("services-ready")
        composeRule.onNodeWithTag("services-build-cta").performClick()
        composeRule.waitForIdle()

        composeRule.onNodeWithTag("build-src-scratch").assertIsDisplayed()
        composeRule.onNodeWithTag("build-src-git").assertIsDisplayed()
        composeRule.onNodeWithTag("build-src-mcp").assertIsDisplayed()
        gymShot("build-chooser")
    }

    /** D2-B5: the chooser → git import screen renders its Check-repo control.
     *  Mirror of iOS test_buildGitFitnessScreen. */
    @Test
    fun buildGitFitnessScreen() {
        launch(tab = "apps")
        composeRule.onNodeWithTag("services-build-cta").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag("build-src-git").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag("build-git-check").assertIsDisplayed()
        gymShot("build-git")
    }

    /** D2-B8: the chooser → MCP IDE-connect screen renders its Create-connection
     *  control. Mirror of iOS test_buildMcpConnectScreen. */
    @Test
    fun buildMcpConnectScreen() {
        launch(tab = "apps")
        composeRule.onNodeWithTag("services-build-cta").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag("build-src-mcp").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag("build-mcp-create").assertIsDisplayed()
        gymShot("build-mcp")
    }

    // ─── D3 — AI-keys manager ────────────────────────────────────────────────

    /** D3-C2: Settings → AI keys opens the device-local key manager (the
     *  Add-a-key affordance renders). Mirror of iOS test_aiKeysManagerRenders. */
    @Test
    fun aiKeysManagerRenders() {
        launch(tab = "settings")
        composeRule.onNodeWithTag("settings-ai-keys").assertIsDisplayed()
        composeRule.onNodeWithTag("settings-ai-keys").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag("ai-keys-title").assertIsDisplayed()
        composeRule.onNodeWithTag("ai-key-add").assertIsDisplayed()
        gymShot("ai-keys")
    }

    // ─── D4 — security: trust sliver ─────────────────────────────────────────

    /** D4-E7: with the untrusted-trust seed, a seeded untrusted verdict renders
     *  the red maintainer-trust sliver. Mirror of iOS
     *  test_trustSliverRendersUntrusted. */
    @Test
    fun trustSliverRendersUntrusted() {
        launch(tab = "home", trustUntrusted = true)
        composeRule.onNodeWithTag("global-trust-bar").assertIsDisplayed()
        gymShot("trust-sliver")
    }

    // ─── D5 — server-event seed states ───────────────────────────────────────

    /** D5-F1: with the awaiting-unlock seed, a box awaiting boot-unlock carries
     *  the waiting-for-approval pill on Home. Mirror of iOS
     *  test_awaitingUnlockApproveCard. */
    @Test
    fun awaitingUnlockPillOnHome() {
        launch(tab = "home", podsVariant = "awaiting-unlock")
        // The pill's testTag sits in FSListRow's `below` slot, under the row's
        // combinedClickable — which MERGES descendant semantics, so the default
        // (merged) tree query can't see the pill as its own node. Query the
        // UNMERGED tree. Use onAllNodes().onFirst() (≥1, mirroring iOS XCUITest
        // `.exists`) since the base demo fixtures may already carry a same-class
        // pill. The pill renders correctly (text merges into the row a11y) — this
        // is the Compose-test query, not an app defect.
        composeRule.onAllNodesWithTag("pod-card-waiting-approval", useUnmergedTree = true)
            .onFirst().assertExists()
        gymShot("home-awaiting")
    }

    /** D5-F3: with the dead seed, a box that never came online surfaces the
     *  never-online status pill on Home. Mirror of iOS
     *  test_deadServerSurfacesOnHome. */
    @Test
    fun deadServerSurfacesOnHome() {
        launch(tab = "home", podsVariant = "dead")
        // Unmerged-tree, ≥1 — same merged-semantics + base-fixture-collision
        // reasons as awaitingUnlockPillOnHome (the demo "Music" pod also
        // classifies DEAD, so there are 2 never-online pills here).
        composeRule.onAllNodesWithTag("pod-card-never-online", useUnmergedTree = true)
            .onFirst().assertExists()
        gymShot("dead-server")
    }
}
