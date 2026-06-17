// GYM Android every-merge specs (§10 Phase-5) — the curated, fast,
// DETERMINISTIC, NO-BACKEND Tier-1 subset the gym drives on Android: "does the
// app still launch, render its core screens, and navigate without a broken
// edge." Mirror of iOS GymEveryMergeTests (the cold-launch→Home smoke is in
// GymSmokeTest; this class adds the breadth).
//
// NO BACKEND by construction: every test launches in smoke mode, which seeds
// DemoFixtures against the MOCK client (see SmokeMode / MainActivity). Each test
// method is a SEPARATE gym scenario; the harness selects one via
// -Pandroid.testInstrumentationRunnerArguments.class=…#method.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import org.junit.Test

class GymEveryMergeTest : GymBase() {

    // ─── Per-tab render (the seeded paired shell) ────────────────────────────

    /** The Home tab renders its large-title landmark in smoke mode. */
    @Test
    fun homeTabRenders() {
        launch(tab = "home")
        gymShot("cold-launch")
        composeRule.onNodeWithTag("home-title").assertIsDisplayed()
        gymShot("home-ready")
    }

    /** The Services tab renders its shell (the "Services" large title). */
    @Test
    fun servicesTabRenders() {
        launch(tab = "apps")
        gymShot("cold-launch")
        composeRule.onNodeWithTag("services-title").assertIsDisplayed()
        gymShot("services-ready")
    }

    /** The Activity tab renders its shell (the "Activity" large title). */
    @Test
    fun activityTabRenders() {
        launch(tab = "activity")
        gymShot("cold-launch")
        composeRule.onNodeWithTag("activity-title").assertIsDisplayed()
        gymShot("activity-ready")
    }

    /** The Settings tab renders its shell + the load-bearing rows
     *  (account-security row + the tier-2 lock-with-passkey). Mirror of iOS
     *  test_settingsTabRenders. */
    @Test
    fun settingsTabRenders() {
        launch(tab = "settings")
        gymShot("cold-launch")
        composeRule.onNodeWithTag("settings-title").assertIsDisplayed()
        composeRule.onNodeWithTag("settings-open-account-security").assertIsDisplayed()
        composeRule.onNodeWithTag("settings-sign-out-btn").assertIsDisplayed()
        gymShot("settings-ready")
    }

    /** The four bottom-bar tabs are all reachable from a single launch: tap each
     *  nav item and assert its content landmark renders. Proves the shell's
     *  nav graph is intact (no broken edge). */
    @Test
    fun fourTabsReachableFromBottomBar() {
        launch(tab = "home")
        composeRule.onNodeWithTag("home-title").assertIsDisplayed()
        gymShot("tab-home")

        composeRule.onNodeWithTag("tab-apps").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag("services-title").assertIsDisplayed()
        gymShot("tab-apps")

        composeRule.onNodeWithTag("tab-activity").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag("activity-title").assertIsDisplayed()
        gymShot("tab-activity")

        composeRule.onNodeWithTag("tab-settings").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag("settings-title").assertIsDisplayed()
        gymShot("tab-settings")
    }

    // ─── Navigation: Home → create-server form ───────────────────────────────

    /** From the seeded Home, the add-server affordance opens the chooser; the
     *  Provision card opens the create-server form, which carries the name
     *  field + the disk-encryption control (the A4 create-server controls).
     *  Mirror of iOS test_createServerFormReachable (Android's create-server is
     *  a single-step form, so the name + encrypt control are on one screen). */
    @Test
    fun createServerFormReachable() {
        launch(tab = "home")
        composeRule.onNodeWithTag("home-add-server").assertIsDisplayed()
        gymShot("home-ready")
        composeRule.onNodeWithTag("home-add-server").performClick()
        composeRule.waitForIdle()

        // Add-server (in-app) opens the chooser; Provision opens create-server.
        composeRule.onNodeWithTag("chooser-provision").assertIsDisplayed()
        gymShot("add-server-chooser")
        composeRule.onNodeWithTag("chooser-provision").performClick()
        composeRule.waitForIdle()

        composeRule.onNodeWithTag("cs-name-field").assertIsDisplayed()
        composeRule.onNodeWithTag("cs-encrypt-disk-toggle").assertIsDisplayed()
        gymShot("create-server-form")
    }

    // ─── The global active-operations sliver ─────────────────────────────────

    /** With the ops seed, the global operations sliver (`global-operations-bar`)
     *  renders (WhatsApp-style teal strip). Without the seed it correctly stays
     *  hidden, so this proves the sliver surfaces a live operation. Mirror of
     *  iOS test_activeOperationsSliverRenders. */
    @Test
    fun activeOperationsSliverRenders() {
        launch(tab = "home", ops = true)
        composeRule.onNodeWithTag("global-operations-bar").assertIsDisplayed()
        gymShot("operations-sliver")
    }
}
