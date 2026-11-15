// GYM Android mock tier: "Set up a box from a store" (docs/retail-box-setup.md §4, §7), twin of
// the iOS GymSweepServerTests retail scenarios. A scripted box (MockBoxClaimRadio) speaks the real
// flagship/box-claim/v1 bytes; the gym's `.com` lists the box's key (or another one) and the TLS
// check answers after a short certificate wait. NO BACKEND, no radio.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import com.flagshipserver.app.core.UntrustedServers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymRetailTest : GymBase() {

    private fun exists(tag: String) = tagCount(tag) > 0

    /** Home → Add/Restore → "Set up a box from a store" → the usual wizard → the claim screen. */
    private fun openClaim(retail: String) {
        launch(tab = "home", adminRoot = true, retail = retail)
        tap("home-add-server")
        waitUntilExists("home-retail-box")
        composeRule.onNodeWithTag("home-retail-box").performClick()
        composeRule.waitForIdle()
        nameServerAndNext("shopbox")
        waitUntilExists("cs-next-button")
        composeRule.onNodeWithTag("cs-next-button").performScrollTo().performClick()
        waitUntilExists("cs-backup-policy-none", timeoutMs = 15_000)
        composeRule.onNodeWithTag("cs-backup-policy-none").performScrollTo().performClick()
        composeRule.onNodeWithTag("cs-continue-button").performScrollTo().performClick()
        waitUntilExists("rc-start", timeoutMs = 15_000)
    }

    private fun claimToNetworkStep() {
        gymShot("retail-intro")
        composeRule.onNodeWithTag("rc-start").performScrollTo().performClick()
        waitUntilExists("rc-press-now", timeoutMs = 30_000)
        gymShot("retail-press-now")
        waitUntilExists("rc-cable", timeoutMs = 60_000)
    }

    private fun stopsWith(retail: String, message: String) {
        openClaim(retail)
        composeRule.onNodeWithTag("rc-start").performScrollTo().performClick()
        waitUntilExists("rc-stopped", timeoutMs = 30_000)
        waitText(message)
        gymShot("retail-stopped-$retail")
    }

    @Test
    fun aCableClaimWaitsForTheCertificateThenShowsThePadlock() {
        openClaim("normal")
        claimToNetworkStep()
        gymShot("retail-network")
        composeRule.onNodeWithTag("rc-cable").performScrollTo().performClick()
        waitUntilExists("rc-certificate", timeoutMs = 30_000)
        gymShot("retail-certificate")
        waitUntilExists("rc-done", timeoutMs = 30_000)
        gymShot("retail-done")
    }

    @Test
    fun wifiWarnsBeforeThePasswordLeaves() {
        openClaim("normal")
        claimToNetworkStep()
        composeRule.onNodeWithTag("rc-wifi").performScrollTo().performClick()
        waitUntilExists("rc-net-Home Wi-Fi", timeoutMs = 15_000)
        composeRule.onNodeWithTag("rc-net-Home Wi-Fi").performScrollTo().performClick()
        waitUntilExists("rc-password")
        composeRule.onNode(hasSetTextAction() and hasAnyAncestor(hasTestTag("rc-password"))).performTextInput("correct horse")
        composeRule.onNodeWithTag("rc-password-continue").performScrollTo().performClick()
        waitUntilExists("rc-warning-send")
        gymShot("retail-wifi-warning")
        composeRule.onNodeWithTag("rc-warning-send").performScrollTo().performClick()
        waitUntilExists("rc-done", timeoutMs = 30_000)
    }

    @Test
    fun anEarlyPressStops() = stopsWith("earlyPress", "This box reported a press before you were asked.")

    @Test
    fun aSecondBoxStops() = stopsWith("secondBox", "A second Flagship box appeared during setup.")

    @Test
    fun aBoxAlreadyNearbyStops() = stopsWith("boxAlreadyNearby", "Another Flagship box nearby is waiting to be set up.")

    @Test
    fun contentionStops() = stopsWith("contention", "Another phone tried to set up this box at the same moment.")

    @Test
    fun anotherKeyRaisesTheAlarmAndMarksTheServerUntrusted() {
        openClaim("keyMismatch")
        claimToNetworkStep()
        composeRule.onNodeWithTag("rc-cable").performScrollTo().performClick()
        waitUntilExists("rc-alarm", timeoutMs = 30_000)
        assertTrue(exists("rc-alarm-reset"))
        assertTrue(exists("rc-alarm-delete"))
        gymShot("retail-alarm")
        assertTrue(UntrustedServers.shared.all().any { it.startsWith("shopbox.") })
        composeRule.onNodeWithTag("rc-alarm-close").performScrollTo().performClick()
        waitUntilExists("pod-card-untrusted", timeoutMs = 15_000)
        gymShot("retail-home-untrusted")
    }

    @Test
    fun aSlowCertificateNeverEndsOnDone() {
        openClaim("certSlow")
        claimToNetworkStep()
        composeRule.onNodeWithTag("rc-cable").performScrollTo().performClick()
        waitUntilExists("rc-certificate-again", timeoutMs = 30_000)
        gymShot("retail-certificate-slow")
        assertEquals(0, tagCount("rc-done"))
    }
}
