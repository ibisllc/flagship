// GYM Android: adding a device is admin-only (owner rule 2026-10-16,
// packages/protocol/test-vectors/device-pairing). A non-admin device sees
// Add device disabled with the sentence; an admin device opens the pairing code.
// Mirror of the webapp's gym-misc "non-admin device" scenario.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.flagshipserver.app.core.AddServerGate
import org.junit.Test

class GymAddDeviceTest : GymBase() {

    private fun openTrustedDevices(adminRoot: Boolean) {
        launch(tab = "settings", adminRoot = adminRoot)
        waitUntilTextExists("Trusted devices")
        composeRule.onNodeWithText("Trusted devices").performScrollTo().performClick()
        waitUntilExistsDesc("trusted-devices-add")
    }

    private fun waitUntilTextExists(text: String, timeoutMs: Long = 15_000) {
        composeRule.waitUntil(timeoutMs) {
            composeRule.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun nonAdminDeviceCannotAddADevice() {
        openTrustedDevices(adminRoot = false)
        composeRule.onNodeWithContentDescription("trusted-devices-add").assertIsNotEnabled()
        composeRule.onNodeWithText(AddServerGate.ADD_DEVICE_ADMIN_ONLY).assertIsDisplayed()
        gymShot("add-device-non-admin")
    }

    @Test
    fun adminDeviceOpensThePairingCode() {
        openTrustedDevices(adminRoot = true)
        composeRule.onNodeWithContentDescription("trusted-devices-add").assertIsEnabled().performClick()
        waitUntilExistsDesc("add-device")
        gymShot("add-device-admin")
    }
}
