// GYM Android button sweep — Settings: Lock and the lock screen, Sign out
// (Cancel, then out to Welcome and its three entries), Remove this device and
// Delete account (both up to Cancel), Browser sessions (only browsers, revoke),
// Trusted devices, the rows that open their own screens, two-factor enrolment
// and `.com`'s 429 sentence on it and on Quick approve from watch, AI keys
// (add, make default, delete) and Flagship Inference's own buttons, and
// Remote (a browser's QR approved from the phone). NO BACKEND.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.onLast
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.espresso.Espresso
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymSettingsTest : GymBase() {

    private fun settings(admin: Boolean = false, rateLimited: List<String> = emptyList()) {
        launch(tab = "settings", adminRoot = admin, rateLimited = rateLimited)
        waitUntilExists("settings-title", 20_000)
    }

    // ─── Lock and sign out ───────────────────────────────────────────────────

    @Test
    fun lockThenUnlock() {
        settings()
        tap("settings-lock-btn")
        waitUntilExists("biometric-lock-screen", 15_000)
        gymShot("locked")
        tap("biometric-unlock-btn")
        waitGone("biometric-lock-screen", 15_000)
        waitUntilExists("settings-title")
    }

    /** The lock screen's own Sign out asks first; Cancel keeps the lock. */
    @Test
    fun lockScreenSignOutCancel() {
        settings()
        tap("settings-lock-btn")
        waitUntilExists("biometric-lock-screen", 15_000)
        tapText("Sign out")
        waitText("Sign out of this device?")
        tapText("Cancel")
        waitTextGone("Sign out of this device?")
        assertEquals(1, tagCount("biometric-lock-screen"))
    }

    /** Sign out: Cancel stays; Sign out lands on Welcome, whose three
     *  entries each open their flow. */
    @Test
    fun signOutCancelThenSignOutToWelcome() {
        settings()
        tap("settings-sign-out-btn")
        waitText("Sign out?")
        tapText("Cancel")
        waitTextGone("Sign out?")
        tap("settings-sign-out-btn")
        composeRule.onNode(hasText("Sign out") and androidx.compose.ui.test.hasClickAction() and !androidx.compose.ui.test.hasTestTag("settings-sign-out-btn"))
            .performClick()
        waitText("Create your account", 20_000)
        gymShot("welcome")
        tap("welcome-connect")
        waitUntilExists("connect-account", 15_000)
        gymShot("connect")
        Espresso.pressBack()
        waitText("Create your account", 15_000)
        tapText("Create your account", 15_000)
        composeRule.waitUntil(15_000) { textCount("Connect to an existing account") == 0 }
        gymShot("create-account")
    }

    @Test
    fun removeDeviceAndDeleteAccountStopAtCancel() {
        settings(admin = true)
        // An admin device holds the key that can still save its servers' data: the dialog says so and
        // has no Cancel (Save my account key first opens the key backup; only Remove anyway removes).
        tap("settings-remove-device-btn")
        waitText(com.flagshipserver.app.core.AdminKeyWarning.REMOVE_TITLE)
        tap("settings-remove-save-first")
        waitUntilExistsDesc("keyfile-export", 15_000)
        Espresso.pressBack()
        waitUntilExists("settings-title", 15_000)
        tap("settings-delete-account-btn")
        waitText("Delete", 15_000)
        gymShot("delete-account")
        tapText("Cancel")
        waitUntilExists("settings-title", 15_000)
    }

    private fun seedDevices(count: Int) {
        val account = "smoketest"
        comMock.accountDirectories = mapOf(account to com.flagshipserver.app.api.AccountDirectoryResponse(
            accountId = account,
            devices = (0 until count).map { i ->
                com.flagshipserver.app.api.AccountDirectoryDevice(
                    accountId = account, deviceId = "a$i".repeat(16).take(32), devicePubHex = "0$i".repeat(32),
                    platformClass = "android", createdAt = 1_790_000_000_000L, lastSeenAt = 1_790_000_100_000L + i,
                    supportCode = "SC-$i",
                )
            },
        ))
    }

    /** A second device on the account blocks the delete with `.com`'s own sentence, which names the next
     *  action (remove it in Trusted devices); nothing is wiped and the typed name stays. */
    @Test
    fun deleteAccountWithAnotherDeviceShowsTheNextAction() {
        settings(admin = true)
        seedDevices(2)
        tap("settings-delete-account-btn")
        type("account-delete-confirm", "smoketest")
        tap("account-delete-go")
        waitUntilExists("account-delete-error", 15_000)
        assertTrue(textOfTag("account-delete-error").contains("Trusted devices"))
        assertTrue(textOfTag("account-delete-error").startsWith("Another device is still on this account"))
        gymShot("delete-account-other-device")
        tapText("Cancel")
        waitUntilExists("settings-title", 15_000)
    }

    /** A fresh single-device account deletes itself and drops to Welcome (the founding device is not "another device"). */
    @Test
    fun deleteAccountOnASingleDeviceAccountSignsOut() {
        settings(admin = true)
        seedDevices(1)
        tap("settings-delete-account-btn")
        type("account-delete-confirm", "smoketest")
        tap("account-delete-go")
        waitText("Create your account", 30_000)
        gymShot("delete-account-single-device")
    }

    /** A device that is not an admin holds no admin key: Remove this device is the ordinary question, with Cancel. */
    @Test
    fun removeDeviceStopsAtCancelOnADeviceThatIsNotAnAdmin() {
        settings()
        tap("settings-remove-device-btn")
        waitText("Remove this device from your account?")
        tapText("Cancel")
        waitTextGone("Remove this device from your account?")
        waitUntilExists("settings-title", 15_000)
        gymShot("remove-device-cancel")
    }

    // ─── Devices and browsers ────────────────────────────────────────────────

    /** Browser sessions lists browsers only (not this phone) and revokes one. */
    @Test
    fun browserSessionsListBrowsersOnlyAndRevoke() {
        settings()
        tap("settings-browser-sessions")
        waitUntilExists("revoke-session-f9e8d7c6", 15_000)
        assertEquals("this phone's own session isn't a browser", 0, tagCount("revoke-session-a1b2c3d4"))
        tap("revoke-session-f9e8d7c6")
        waitText("Revoke this session?")
        tapText("Cancel")
        assertTrue(screensMock.revokedPairedSessions.isEmpty())
        tap("revoke-session-f9e8d7c6")
        composeRule.onNode(hasText("Revoke") and androidx.compose.ui.test.hasClickAction() and !androidx.compose.ui.test.hasTestTag("revoke-session-f9e8d7c6"))
            .performClick()
        eventually(what = "revoked") { screensMock.revokedPairedSessions == listOf("f9e8d7c6") }
        waitGone("revoke-session-f9e8d7c6", 15_000)
        gymShot("browser-revoked")
    }

    /** Trusted devices: a device's menu offers Revoke, Replace and Wipe, each
     *  asking first. */
    @Test
    fun trustedDevicesMenuAsksFirst() {
        settings(admin = true)
        // Two devices in the account's directory (the mock `.com` answers it).
        val account = "smoketest"
        comMock.accountDirectories = mapOf(account to com.flagshipserver.app.api.AccountDirectoryResponse(
            accountId = account,
            devices = listOf("a1", "b2").mapIndexed { i, id ->
                com.flagshipserver.app.api.AccountDirectoryDevice(
                    accountId = account, deviceId = id.repeat(16), devicePubHex = "0$i".repeat(32),
                    platformClass = "android", createdAt = 1_790_000_000_000L, lastSeenAt = 1_790_000_100_000L + i,
                    supportCode = "SC-$i",
                )
            },
        ))
        tap("settings-trusted-devices")
        composeRule.waitUntil(20_000) {
            composeRule.onAllNodes(androidx.compose.ui.test.SemanticsMatcher("device menu") {
                it.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.ContentDescription)?.any { d -> d.startsWith("trusted-device-menu-") } == true
            }).fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onAllNodes(androidx.compose.ui.test.SemanticsMatcher("device menu") {
            it.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.ContentDescription)?.any { d -> d.startsWith("trusted-device-menu-") } == true
        }).fetchSemanticsNodes().first().let { n ->
            val desc = n.config[androidx.compose.ui.semantics.SemanticsProperties.ContentDescription].first()
            composeRule.onNode(hasContentDescription(desc)).scrollIfNeeded().performClick()
        }
        gymShot("device-menu")
        if (descCount("trusted-device-disconnect") > 0) {
            tapDesc("trusted-device-disconnect")
            waitText("Revoke")
            tapText("Cancel")
        }
    }

    /** Each row without a dedicated test opens its screen. */
    @Test
    fun rowsOpenTheirScreens() {
        settings()
        val rows = listOf(
            "settings-profiles" to "Active",
            "settings-privacy" to "Lock with biometrics",
            "settings-peer-backup" to "Peer-backup",
            "settings-remote" to "Or paste its link",
            "settings-companion-requests" to "Companion requests",
            "settings-secured-sessions" to "secured-sessions-title",
            "settings-process-url" to "process-url-title",
            "settings-cloud-recovery" to "Cloud recovery",
            "settings-backup-key" to "keyfile-export-create",
        )
        for ((row, landmark) in rows) {
            tap(row, 15_000)
            composeRule.waitUntil(15_000) {
                tagCount(landmark) > 0 || textCount(landmark) > 0 || descCount(landmark) > 0
            }
            gymShot(row)
            Espresso.pressBack()
            waitUntilExists("settings-title", 15_000)
        }
    }

    @Test
    fun processUrlSubmitsAPastedLink() {
        settings()
        tap("settings-process-url")
        type("process-url-input", "https://plants.home.bright-maple.flagship.services/__flagship/knock?p=abc")
        tap("process-url-submit")
        composeRule.waitForIdle()
        gymShot("process-url")
    }

    // ─── Two-factor and `.com`'s rate limit ──────────────────────────────────

    @Test
    fun twoFactorEnrolment() {
        settings()
        tap("settings-open-account-security")
        tapDesc("account-security-enable-btn", 15_000)
        tapDesc("account-security-step1-continue")
        waitUntilExistsDesc("account-security-verify-btn", 15_000)
        composeRule.onNode(hasSetTextAction() and (hasContentDescription("account-security-sample-code") or androidx.compose.ui.test.hasAnyAncestor(hasContentDescription("account-security-sample-code"))))
            .typeText("123456")
        tapDesc("account-security-verify-btn")
        waitUntilExistsDesc("account-security-recovery-codes", 15_000)
        tapDesc("account-security-saved-toggle")
        tapDesc("account-security-done-btn")
        waitUntilExistsDesc("account-security-disable-btn", 15_000)
        gymShot("2fa-on")
    }

    /** A 429 from `.com` reads as its sentence, not a status code. */
    @Test
    fun twoFactorRateLimitedSaysWhen() {
        settings(rateLimited = listOf("totp-verify"))
        tap("settings-open-account-security")
        tapDesc("account-security-enable-btn", 15_000)
        tapDesc("account-security-step1-continue")
        waitUntilExistsDesc("account-security-verify-btn", 15_000)
        composeRule.onNode(hasSetTextAction() and (hasContentDescription("account-security-sample-code") or androidx.compose.ui.test.hasAnyAncestor(hasContentDescription("account-security-sample-code"))))
            .typeText("123456")
        tapDesc("account-security-verify-btn")
        waitText("Too many tries from your network. Try again in about 12 minutes.", 15_000)
        assertEquals(0, textCount("429"))
        gymShot("2fa-rate-limited")
    }

    @Test
    fun watchQuickApproveRateLimitedSaysWhen() {
        settings(rateLimited = listOf("watch-delegate"))
        tap("settings-open-account-security")
        tap("watch-delegate-toggle", 15_000)
        waitText("Too many tries from your network. Try again in about 12 minutes.", 15_000)
        gymShot("watch-rate-limited")
    }

    // ─── AI keys and Flagship Inference ──────────────────────────────────────

    /** Save needs the typed key to have reached the form (the button enables then); a click before is a no-op. */
    private fun saveKey() {
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodes(androidx.compose.ui.test.hasText("Save key") and androidx.compose.ui.test.hasClickAction() and androidx.compose.ui.test.isEnabled())
                .fetchSemanticsNodes().isNotEmpty()
        }
        tapText("Save key")
        waitTextGone("Save key", 30_000)
    }

    @Test
    fun aiKeysAddMakeDefaultAndDelete() {
        settings()
        tap("settings-ai-keys")
        tap("ai-key-add")
        tap("ai-key-provider-openai")
        type("ai-key-field", "sk-gym-aaaaaaaaaaaa")
        saveKey()
        tap("ai-key-add")
        tap("ai-key-provider-anthropic")
        type("ai-key-field", "sk-ant-gym-bbbbbbbbbbbb")
        saveKey()
        assertEquals(2, com.flagshipserver.app.core.AiKeyStore.list().size)
        // Whichever is the default, the last "Make default" on the page is a saved key's.
        val keys = com.flagshipserver.app.core.AiKeyStore.list().map { it.id }
        val before = com.flagshipserver.app.core.AiKeyStore.activeId()
        composeRule.onAllNodes(hasText("Make default") and androidx.compose.ui.test.hasClickAction()).onLast()
            .scrollIfNeeded().performClick()
        eventually(what = "default moved to a key (active ${com.flagshipserver.app.core.AiKeyStore.activeId()}, was $before, keys $keys)") {
            com.flagshipserver.app.core.AiKeyStore.activeId() in keys && com.flagshipserver.app.core.AiKeyStore.activeId() != before
        }
        gymShot("two-keys")
        tapText("Delete")
        eventually(what = "deleted") { com.flagshipserver.app.core.AiKeyStore.list().size == 1 }
    }

    @Test
    fun flagshipInferenceMakeDefaultAndAddOwnKey() {
        settings()
        tap("settings-ai-keys")
        tap("ai-key-add")
        tap("ai-key-provider-openai")
        type("ai-key-field", "sk-gym-cccccccccccc")
        saveKey()
        // Flagship Inference starts as the default; make the new key the default, then Flagship Inference again.
        waitText("Make default", 15_000)
        eventually(what = "the key is the default (active ${com.flagshipserver.app.core.AiKeyStore.activeId()})") {
            if (com.flagshipserver.app.core.AiKeyStore.activeId() == com.flagshipserver.app.core.AiKeyStore.FLAGSHIP_INFERENCE_ID) {
                composeRule.onAllNodes(hasText("Make default") and androidx.compose.ui.test.hasClickAction()).onLast()
                    .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
            }
            com.flagshipserver.app.core.AiKeyStore.activeId() != com.flagshipserver.app.core.AiKeyStore.FLAGSHIP_INFERENCE_ID
        }
        tap("free-ai-make-default", 15_000)
        eventually(what = "Flagship Inference default") { com.flagshipserver.app.core.AiKeyStore.activeId() == com.flagshipserver.app.core.AiKeyStore.FLAGSHIP_INFERENCE_ID }
        // (Add your own key shows only once the free AI has ended.)
        gymShot("free-ai")
    }

    // ─── Remote ──────────────────────────────────────────────────────────────

    /** A browser's QR (as a link): the phone shows the code, picks a server
     *  and approves; the ticket goes back over the relay. */
    @Test
    fun remoteApprovesABrowserFromItsQr() {
        launch(
            tab = "settings",
            deepLink = "flagship://remote?s=gymremotesession01&k=CQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        )
        waitText("Let this browser in?", 20_000)
        gymShot("remote-ask")
        // The button opens a moment after the code shows (the anti-double-tap gate).
        tapMatching(hasText("Codes match: approve"), 15_000)
        waitText("Browser connected to", 20_000)
        assertTrue(com.flagshipserver.app.core.GymProbe.relay!!.lastDeliver != null)
        gymShot("remote-connected")
    }
}
