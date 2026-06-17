// GYM Android smoke (§10 Phase-5 / every-merge) — the deterministic Tier-1
// smoke the gym drives on the Android surface: cold-launch in smoke mode
// (seeded DemoFixtures, no backend) → the paired Home shell renders. Mirror of
// iOS GymSmokeTests.test_gymColdLaunchRendersHome.
//
// The verdict is the assertion (Layer 1). The bitmap is captured at the
// screenshot points for the advisory judge only.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import org.junit.Test

class GymSmokeTest : GymBase() {

    /** Cold launch in smoke mode lands on Home with sample pods seeded; the
     *  "Add a server" affordance (`home-add-server`) renders once pods exist
     *  (DemoFixtures seeds three), so its presence proves the seeded paired
     *  shell drew + fixtures applied — the same handle iOS asserts. */
    @Test
    fun gymColdLaunchRendersHome() {
        launch(tab = "home")
        gymShot("cold-launch")
        composeRule.onNodeWithTag("home-add-server").assertIsDisplayed()
        gymShot("home-ready")
    }
}
