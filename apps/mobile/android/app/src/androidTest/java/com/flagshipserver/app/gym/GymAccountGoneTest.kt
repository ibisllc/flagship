// GYM Android: the "This account was removed" screen (docs/account-gone.md) and
// the admin-key confirmations (owner, 2026-10-18): the rescue must stay possible
// while the device holds its keys, so removing them asks first. The mock `.com`
// has no OkHttp in the way, so a scenario flips the state the interceptor sets
// (AccountGone.markGone); the interceptor itself is covered by AccountGoneTest.
// NO BACKEND.

package com.flagshipserver.app.gym

import com.flagshipserver.app.core.AccountGone
import com.flagshipserver.app.core.AdminKeyWarning
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithTag
import org.junit.Assert.assertTrue
import org.junit.Test

class GymAccountGoneTest : GymBase() {

    private fun accountGone(name: String = "smoketest") {
        composeRule.runOnUiThread { AccountGone.ownNames = { listOf(name) }; AccountGone.markGone(name) }
    }

    @Test
    fun theScreenTakesOverAndTheAppBehindItGoesQuiet() {
        launch(tab = "home", adminRoot = true)
        waitUntilExists("home-title", 20_000)
        tap("home-add-server")
        waitUntilExists("home-restore-backup")
        accountGone()
        waitUntilExists("account-gone", 15_000)
        composeRule.waitUntil(10_000) { tagCount("home-add-sheet") == 0 }
        assertEquals("the app behind it is inaccessible", 0, tagCount("home-title"))
        assertEquals("This account was removed", textOfTag("account-gone-title"))
        assertEquals("This account no longer exists on Flagship. This can happen after a reset.", textOfTag("account-gone-body"))
        assertEquals("Account: smoketest", textOfTag("account-gone-name"))
        // Save my servers' data leads (disabled until the rescue exists), then Create, then the quiet Remove.
        assertEquals("Save my servers' data", textOfTag("account-gone-save"))
        composeRule.onNodeWithTag("account-gone-save").assertIsNotEnabled()
        assertEquals("Coming soon", textOfTag("account-gone-coming-soon"))
        assertEquals("Create a new account", textOfTag("account-gone-create"))
        assertEquals("Remove it from this device", textOfTag("account-gone-remove"))
        // The error toasts stay quiet while the screen is up.
        val toasts = com.flagshipserver.app.core.ToastCenter()
        toasts.error("Couldn't load")
        assertTrue(toasts.queue.value.isEmpty())
        gymShot("account-gone")
    }

    @Test
    fun anotherAccountsNotFoundChangesNothing() {
        launch(tab = "home")
        waitUntilExists("home-title", 20_000)
        composeRule.runOnUiThread { AccountGone.ownNames = { listOf("smoketest") } }
        val flipped = AccountGone.note("/api/users/someone-else/pods", 404) { AccountGone.responseBody() }
        assertFalse(flipped)
        assertFalse(AccountGone.note("/api/users/smoketest/pods", 404) { """{"error":"nope"}""" })
        assertFalse(AccountGone.note("/api/users/smoketest/pods", 401) { AccountGone.responseBody() })
        composeRule.waitForIdle()
        assertEquals(0, tagCount("account-gone"))
        assertEquals(1, tagCount("home-title"))
        gymShot("not-mine")
        assertTrue(AccountGone.note("/api/users/smoketest/pods", 404) { AccountGone.responseBody() })
        waitUntilExists("account-gone")
    }

    @Test
    fun removingFromADeviceWithNoKeysSignsOutAtOnce() {
        launch(tab = "home", podsVariant = "none")
        waitUntilExists("home-title", 20_000)
        accountGone()
        waitUntilExists("account-gone-remove", 15_000)
        tap("account-gone-remove")
        waitUntilExists("welcome-create", 20_000)
        assertEquals(0, tagCount("account-gone"))
        assertFalse(AccountGone.isGone)
        gymShot("removed-no-keys")
    }

    @Test
    fun removingFromAnAdminDeviceWarnsInPlaceOfTheButtonsAndSaveMyDataFirstOpensTheKeyBackup() {
        launch(tab = "home", adminRoot = true)
        waitUntilExists("home-title", 20_000)
        accountGone()
        waitUntilExists("account-gone-remove", 15_000)
        tap("account-gone-remove")
        waitUntilExists("account-gone-warning-text")
        assertEquals("Remove this account from this device?", textOfTag("account-gone-warning-title"))
        assertEquals(AdminKeyWarning.REMOVE_MESSAGE, textOfTag("account-gone-warning-text"))
        assertEquals("Save my data first", textOfTag("account-gone-save-first"))
        assertEquals("Remove anyway", textOfTag("account-gone-remove-anyway"))
        assertEquals("the warning stands in place of the buttons", 0, tagCount("account-gone-remove"))
        gymShot("remove-asks-first")
        // Back does not dismiss it into a removal: only Remove anyway removes.
        assertTrue(AccountGone.isGone)
        tap("account-gone-save-first")
        waitUntilExistsDesc("keyfile-export", 15_000)
        assertTrue("still signed in, nothing removed", AccountGone.isGone)
        androidx.test.espresso.Espresso.pressBack()
        waitUntilExists("account-gone-remove")
        tap("account-gone-remove")
        waitUntilExists("account-gone-remove-anyway")
        tap("account-gone-remove-anyway")
        waitUntilExists("welcome-create", 20_000)
        assertEquals(0, tagCount("account-gone"))
    }

    @Test
    fun creatingANewAccountOnAnAdminDeviceWarnsThenOpensTheCreateStep() {
        launch(tab = "home", adminRoot = true)
        waitUntilExists("home-title", 20_000)
        accountGone()
        waitUntilExists("account-gone-create", 15_000)
        tap("account-gone-create")
        waitUntilExists("account-gone-warning-text")
        assertEquals(AdminKeyWarning.REMOVE_MESSAGE, textOfTag("account-gone-warning-text"))
        tap("account-gone-remove-anyway")
        waitText("Your handle", 20_000)
        assertEquals(0, tagCount("account-gone"))
        gymShot("create-after-gone")
    }

    @Test
    fun signOutOnAnAdminDeviceWarnsAboutTheAdminKey() {
        launch(tab = "settings", adminRoot = true)
        waitUntilExists("settings-title", 20_000)
        val ctx = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        com.flagshipserver.app.core.KeyBackupStore.forget(ctx, "smoketest")
        // No key file written: save first, or sign out anyway.
        tap("settings-sign-out-btn")
        waitUntilExists("settings-sign-out-admin-warning")
        assertEquals(AdminKeyWarning.SIGN_OUT_NOT_BACKED_UP, textOfTag("settings-sign-out-admin-warning"))
        assertEquals("Save my data first", textOfTag("settings-sign-out-save-first"))
        assertEquals("Sign out anyway", textOfTag("settings-sign-out-confirm"))
        gymShot("sign-out-admin-warning")
        // Save my data first opens the account-key backup and removes nothing.
        tap("settings-sign-out-save-first")
        waitUntilExistsDesc("keyfile-export", 15_000)
        androidx.test.espresso.Espresso.pressBack()
        waitUntilExists("settings-title")
        // Once a key file was written the message says what to keep.
        com.flagshipserver.app.core.KeyBackupStore.markWritten(ctx, "smoketest")
        try {
            tap("settings-sign-out-btn")
            waitUntilExists("settings-sign-out-admin-warning")
            assertEquals(AdminKeyWarning.SIGN_OUT_BACKED_UP, textOfTag("settings-sign-out-admin-warning"))
            tapText("Cancel")
            waitTextGone("Sign out?")
        } finally {
            com.flagshipserver.app.core.KeyBackupStore.forget(ctx, "smoketest")
        }
    }

    @Test
    fun removeThisDeviceOnAnAdminDeviceWarnsFirst() {
        launch(tab = "settings", adminRoot = true)
        waitUntilExists("settings-title", 20_000)
        tap("settings-remove-device-btn")
        waitText(AdminKeyWarning.REMOVE_TITLE)
        waitText(AdminKeyWarning.REMOVE_MESSAGE)
        assertEquals("Remove anyway", textOfTag("settings-remove-confirm", unmerged = true))
        assertEquals("Save my data first", textOfTag("settings-remove-save-first"))
        gymShot("remove-device-admin-warning")
        tap("settings-remove-save-first")
        waitUntilExistsDesc("keyfile-export", 15_000)
    }

    @Test
    fun signOutOnADeviceThatIsNotAnAdminHasNoAdminWarning() {
        launch(tab = "settings")
        waitUntilExists("settings-title", 20_000)
        tap("settings-sign-out-btn")
        waitText("Sign out?")
        assertEquals(0, tagCount("settings-sign-out-admin-warning", unmerged = true))
        gymShot("sign-out-no-admin-warning")
        tapText("Cancel")
    }
}
