// GYM Android mock tier — the October 2026 features, twins of iOS
// GymOctoberTests (handles shared where the surfaces name them alike;
// docs/ui-test-gym.md §8): an app's Internet access requests, access control,
// API keys, the Database browser, where an app runs, the update card, the
// Flagship Inference entry, the app-wide access dialogs and sharing a server
// (owner and co-manager). NO BACKEND: smoke mode seeds DemoFixtures and the
// mock clients (and, with `shares`, an in-memory share world); the smoke seam
// passes the biometric prompts, so signed orders reach the mock, which
// accepts any signature.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.espresso.Espresso
import com.flagshipserver.app.core.MockServerShares
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
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

    private fun count(tag: String, unmerged: Boolean = false) =
        composeRule.onAllNodesWithTag(tag, useUnmergedTree = unmerged).fetchSemanticsNodes().size

    private fun countDesc(desc: String) =
        composeRule.onAllNodesWithContentDescription(desc).fetchSemanticsNodes().size

    private fun countPrefix(prefix: String) = composeRule.onAllNodes(tagStartsWith(prefix)).fetchSemanticsNodes().size

    private fun textOf(tag: String): String =
        composeRule.onNodeWithTag(tag).fetchSemanticsNode().config
            .getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }.orEmpty()

    /** Services → the demo Plants app's page (opened by its unique summary line). */
    private fun openPlants(adminRoot: Boolean = false, deviceRank: String? = null) {
        launch(tab = "apps", adminRoot = adminRoot, deviceRank = deviceRank)
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

    // ─── Debug access ────────────────────────────────────────────────────────

    /** An admin device turns debug access on with a pasted SSH key, the page
     *  shows the banner, then turns it off and the banner goes. */
    @Test
    fun debugAccessOnBannerOff() {
        launch(tab = "home", adminRoot = true)
        waitUntilTextExists("Living-room mini-PC", timeoutMs = 20_000)
        composeRule.onNodeWithText("Living-room mini-PC").performScrollTo().performClick()
        composeRule.waitForIdle()
        waitUntilExists("sd-debug-access-open", timeoutMs = 20_000)
        composeRule.onNodeWithTag("sd-debug-access-open").performScrollTo().performClick()
        waitUntilExists("sd-debug-access-key")
        composeRule.onNodeWithTag("sd-debug-access-key").performScrollTo()
            .performTextInput("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3 gym@laptop")
        waitUntilTextExists("Anyone with this key can read everything on this server while it's on.")
        gymShot("debug-access-form")
        composeRule.onNodeWithTag("sd-debug-access-submit").performScrollTo().performClick()
        waitUntilExists("sd-debug-access-off", timeoutMs = 15_000)
        waitUntilTextExists("Debug access is on until ")
        gymShot("debug-access-on")
        composeRule.onNodeWithTag("sd-debug-access-off").performScrollTo().performClick()
        composeRule.onNodeWithTag("sd-debug-access-confirm-off").performClick()
        composeRule.waitUntil(15_000) { count("sd-debug-access-off") == 0 }
        assertEquals(0, countDesc("sd-debug-access-banner"))
        gymShot("debug-access-off")
    }

    /** A device without the admin root sees the state but can't change it. */
    @Test
    fun debugAccessReadOnlyOnANonAdminDevice() {
        openHomeServerPage()
        composeRule.waitUntil(20_000) {
            composeRule.onAllNodesWithContentDescription("sd-debug-access-admin-only").fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(0, count("sd-debug-access-open"))
        gymShot("debug-access-read-only")
    }

    // ─── Configure environment: one signed change per variable ──────────────

    /** Plants' Configure environment: a name the box can't take is refused in
     *  the dialog; saving PLANT_TOKEN keeps WEATHER_API_KEY; removing
     *  WEATHER_API_KEY leaves PLANT_TOKEN. Each is one signed
     *  service-env-change the mock box checks (app, op, value hash, nonce
     *  spent once), so a refusal would show on the screen. Twin of iOS
     *  test_serviceEnvSetsAndRemovesOneVariable. */
    @Test
    fun serviceEnvSetsAndRemovesOneVariable() {
        openPlants()
        waitUntilExists("service-detail-env-row", timeoutMs = 20_000)
        composeRule.onNodeWithTag("service-detail-env-row").performScrollTo().performClick()
        waitUntilExists("service-env-row-WEATHER_API_KEY", timeoutMs = 15_000)

        composeRule.onNodeWithTag("service-env-add-btn").performScrollTo().performClick()
        waitUntilExists("service-env-name-field")
        composeRule.onNodeWithTag("service-env-name-field").performTextInput("plant-token")
        composeRule.onNodeWithTag("service-env-value-field").performTextInput("tok-gym-1")
        composeRule.onNodeWithTag("service-env-save-btn").performClick()
        waitUntilExists("service-env-name-error")
        assertTrue(
            textOf("service-env-name-error").startsWith("Use letters, digits and _ only"),
        )

        composeRule.onNodeWithTag("service-env-name-field").performTextClearance()
        composeRule.onNodeWithTag("service-env-name-field").performTextInput("PLANT_TOKEN")
        composeRule.onNodeWithTag("service-env-save-btn").performClick()
        waitUntilExists("service-env-row-PLANT_TOKEN", timeoutMs = 15_000)
        assertEquals("Saving a second variable keeps the first", 1, count("service-env-row-WEATHER_API_KEY"))
        gymShot("service-env-saved")

        composeRule.onNodeWithTag("service-env-remove-WEATHER_API_KEY", useUnmergedTree = true).performScrollTo().performClick()
        composeRule.waitUntil(15_000) { count("service-env-row-WEATHER_API_KEY") == 0 && count("service-env-row-PLANT_TOKEN") == 1 }
        assertEquals("The other variable stays", 1, count("service-env-row-PLANT_TOKEN"))
        gymShot("service-env-removed")
    }

    // ─── Per-app disk limits ─────────────────────────────────────────────────

    /** Plants shows its files folder and database against their limits. */
    @Test
    fun appStorageShowsLimits() {
        openPlants()
        waitUntilExists("service-detail-storage", timeoutMs = 20_000)
        composeRule.onNodeWithTag("service-detail-storage").performScrollTo()
        assertEquals("2.0 GB of 5.0 GB", textOf("service-detail-storage-files"))
        assertTrue(textOf("service-detail-storage-database").startsWith("300 MB of "))
        assertEquals(0, count("service-detail-storage-full"))
        gymShot("app-storage-limits")
    }

    /** A full app says why new data is refused. */
    @Test
    fun aFullAppSaysNewDataIsRefused() {
        launch(tab = "apps")
        waitUntilTextExists("Wiki", timeoutMs = 20_000)
        composeRule.onAllNodesWithText("Wiki", substring = true).onFirst().performClick()
        waitUntilExists("service-detail-storage", timeoutMs = 20_000)
        composeRule.onNodeWithTag("service-detail-storage").performScrollTo()
        assertEquals(
            "Full: new data is refused until you free space or raise the limit.",
            textOf("service-detail-storage-full"),
        )
        gymShot("app-storage-full")
    }

    // ─── App access list on the service page ─────────────────────────────────

    /** Plants asked for a host at install; Allow signs the edited list and the
     *  request leaves the page. */
    @Test
    fun serviceAccessPendingAllow() {
        openPlants(adminRoot = true)
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
        assertSigned("app-access", "admin")
    }

    // ─── Access control: Open to all / Members only ──────────────────────────

    /** Only an admin device changes the mode. */
    @Test
    fun accessControlSwitchesToMembersOnly() {
        openPlants(adminRoot = true)
        waitUntilExists("service-detail-access-row", timeoutMs = 20_000)
        composeRule.onNodeWithTag("service-detail-access-row").performScrollTo().performClick()
        waitUntilExists("service-access-restrict-toggle", timeoutMs = 15_000)
        waitUntilTextExists("Anyone can open it", timeoutMs = 15_000)
        waitUntilTextExists("Members (")
        gymShot("access-control-open")
        composeRule.onNodeWithTag("service-access-mode-members").performClick()
        waitUntilExists("service-access-members-only-confirm")
        composeRule.onNodeWithTag("service-access-members-only-confirm").performClick()
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodesWithText("Only members and you can open it", substring = true)
                .fetchSemanticsNodes().isNotEmpty()
        }
        gymShot("access-control-members-only")
        assertSigned("access-mode", "admin")
    }

    private fun openAccessControl(adminRoot: Boolean = false, deviceRank: String? = null, waitFor: String = "service-access-add-person") {
        openPlants(adminRoot, deviceRank)
        waitUntilExists("service-detail-access-row", timeoutMs = 20_000)
        composeRule.onNodeWithTag("service-detail-access-row").performScrollTo().performClick()
        waitUntilExists("service-access-account-members-title", timeoutMs = 15_000)
        waitUntilExists(waitFor, timeoutMs = 15_000)
    }

    private val otherDeviceRank = "service-access-account-rank-device-${com.flagshipserver.app.api.MockScreensClient.OTHER_DEVICE_ID}"
    private val selfDeviceRank = "service-access-account-rank-device-${com.flagshipserver.app.api.MockScreensClient.SELF_DEVICE_ID}"

    /** An admin device: every account member has a rank menu with Refuse, each one signed order. */
    @Test
    fun accountMembersAdminRanksAndRefuses() {
        openAccessControl(adminRoot = true)
        composeRule.onNodeWithText("Kitchen iPad").assertExists()
        composeRule.onNodeWithText("Sam's family").assertExists()
        composeRule.onNodeWithText("This device · Admin").assertExists()
        composeRule.onNodeWithTag("service-access-account-members-title").performScrollTo()
        gymShot("access-account-members-admin")
        composeRule.onNodeWithTag(otherDeviceRank).performScrollTo().performClick()
        waitUntilExists("$otherDeviceRank-refuse")
        gymShot("access-account-rank-menu")
        composeRule.onNodeWithTag("$otherDeviceRank-refuse").performClick()
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodesWithContentDescription("Rank: Refused").fetchSemanticsNodes().isNotEmpty()
        }
        gymShot("access-account-refused")
        assertSigned("app-rank", "admin")
    }

    /** A non-admin device at Manager (the default): its rank shows read-only, it invites at Member. */
    @Test
    fun accountMembersNonAdminManagerInvitesAtMember() {
        openAccessControl()
        composeRule.onNodeWithTag(selfDeviceRank).assertIsNotEnabled()
        composeRule.onNodeWithTag(otherDeviceRank).assertIsNotEnabled()
        composeRule.onNodeWithTag("service-access-mode-admin-only").assertExists()
        assertEquals(0, count("service-access-cant-invite"))
        composeRule.onNodeWithTag("service-access-add-person").assertExists()
        gymShot("access-account-members-manager")
    }

    /** A non-admin device at Member: no "+ Add", one line saying why. */
    @Test
    fun accountMembersMemberRankSeesWhy() {
        openAccessControl(deviceRank = "member", waitFor = "service-access-cant-invite")
        composeRule.onNodeWithText("Only an admin can let you invite people to this app.").assertExists()
        assertEquals(0, count("service-access-add-person"))
        assertEquals(0, count("service-access-add-group"))
        gymShot("access-account-members-member")
    }

    /** The demo device holds no admin root: a new invite is Member, and says why. */
    @Test
    fun rankPickerLockedOnANonAdminDevice() {
        openAccessControl()
        composeRule.onNodeWithTag("service-access-add-person").performClick()
        waitUntilExists("service-access-rank-locked")
        composeRule.onNodeWithTag("service-access-rank-locked").performScrollTo()
            .assertTextContains("Only an admin device can give a higher rank", substring = true)
        composeRule.onNodeWithTag("service-access-new-role").assertIsNotEnabled()
        gymShot("access-rank-locked")
    }

    /** An invite made here lists who made it. */
    @Test
    fun membersListShowsInvitedBy() {
        openAccessControl()
        composeRule.onNodeWithTag("service-access-add-person").performClick()
        waitUntilExists("service-access-name-field")
        composeRule.onNodeWithTag("service-access-name-field").performTextInput("Gym friend")
        // The button enables once the typed name has reached the view model; an earlier click does nothing.
        composeRule.waitUntil(10_000) {
            runCatching { composeRule.onNodeWithTag("service-access-create-invite").assertIsEnabled() }.isSuccess
        }
        composeRule.onNodeWithTag("service-access-create-invite").performScrollTo().performClick()
        composeRule.waitUntil(30_000) {
            composeRule.onAllNodesWithText("Invited by", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onAllNodesWithText("Invited by", substring = true).onFirst().performScrollTo()
        gymShot("access-invited-by")
    }

    // ─── API keys + Database ─────────────────────────────────────────────────

    @Test
    fun apiKeyCreateShowsTheSecretOnce() {
        openPlants(adminRoot = true)
        waitUntilExists("service-detail-api-keys", timeoutMs = 20_000)
        composeRule.onNodeWithTag("service-detail-api-keys").performScrollTo()
        waitUntilTextExists("Garden sensor", timeoutMs = 15_000)
        composeRule.onNodeWithTag("service-detail-api-keys-create").performScrollTo().performClick()
        waitUntilExists("api-key-create-label")
        composeRule.onNodeWithTag("api-key-create-label").performTextInput("Gym sensor")
        composeRule.onNodeWithTag("api-key-create-confirm").performClick()
        waitUntilExists("api-key-created-value", timeoutMs = 15_000)
        gymShot("api-key-created")
        assertSigned("app-api-key", "admin")
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

    /** A device without the admin root sees the app's admin orders read-only,
     *  each with its sentence, and never sends one the box would refuse:
     *  Allow / Deny, API keys, Runs on ticks and Uninstall. */
    @Test
    fun adminOrdersAreReadOnlyOnANonAdminDevice() {
        openPlants()
        waitUntilExists("service-detail-access", timeoutMs = 20_000)
        waitUntilExists("service-detail-access-read-only", timeoutMs = 15_000)
        composeRule.onNodeWithTag("service-detail-access-read-only").performScrollTo()
            .assertTextContains("Only an admin device can change this app's internet access.")
        assertEquals("no Allow on a non-admin device", 0, count("service-detail-access-allow"))
        gymShot("access-read-only")

        waitUntilExists("service-detail-api-keys-read-only", timeoutMs = 15_000)
        composeRule.onNodeWithTag("service-detail-api-keys-read-only").performScrollTo()
            .assertTextContains("Only an admin device can create or revoke API keys.")
        assertEquals("no Create key on a non-admin device", 0, count("service-detail-api-keys-create"))

        composeRule.waitUntil(20_000) {
            composeRule.onAllNodes(tagStartsWith("runs-on-toggle-")).fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onAllNodes(tagStartsWith("runs-on-toggle-")).fetchSemanticsNodes().forEach { node ->
            val tag = node.config.getOrNull(SemanticsProperties.TestTag)!!
            composeRule.onNodeWithTag(tag).assertIsNotEnabled()
        }
        composeRule.onNodeWithTag("runs-on-admin-only").performScrollTo()
            .assertTextContains("Only an admin device can change where this app runs.")

        assertEquals(0, count("service-detail-uninstall-btn"))
        composeRule.onNodeWithTag("service-detail-uninstall-admin-only").performScrollTo().assertIsDisplayed()
        gymShot("admin-orders-read-only")
    }

    /** A write needs an admin device: a non-admin one is told so instead of Confirm. */
    @Test
    fun databaseWriteIsAdminOnly() {
        openPlants()
        waitUntilExists("service-detail-database", timeoutMs = 20_000)
        composeRule.onNodeWithTag("service-detail-database").performScrollTo().performClick()
        waitUntilExists("db-run-sql", timeoutMs = 15_000)
        composeRule.onNodeWithTag("db-run-sql").performScrollTo().performClick()
        waitUntilExists("db-sql-editor")
        composeRule.onNode(hasSetTextActionIn("db-sql-editor")).performTextInput("DELETE FROM plants")
        composeRule.onNodeWithTag("db-sql-run").performClick()
        waitUntilExists("db-write-admin-only", timeoutMs = 15_000)
        composeRule.onNodeWithTag("db-write-admin-only")
            .assertTextContains("Only an admin device can change this app's data.")
        assertEquals(0, count("db-confirm-write"))
        gymShot("db-write-admin-only")
    }

    private fun hasSetTextActionIn(tag: String) =
        androidx.compose.ui.test.hasSetTextAction() and (hasTestTag(tag) or hasAnyAncestor(hasTestTag(tag)))

    /** The same page on an admin device offers each of them. */
    @Test
    fun adminOrdersAreOfferedOnAnAdminDevice() {
        openPlants(adminRoot = true)
        waitUntilExists("service-detail-api-keys-create", timeoutMs = 20_000)
        assertEquals(0, count("service-detail-api-keys-read-only"))
        waitUntilExists("runs-on-help", timeoutMs = 20_000)
        assertEquals(0, count("runs-on-admin-only"))
        composeRule.onNodeWithTag("service-detail-uninstall-btn").performScrollTo().assertIsDisplayed()
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
        // The app rows load after the page frame (the button exists first): wait for them.
        composeRule.waitUntil(20_000) { composeRule.onAllNodes(tagStartsWith("server-app-")).fetchSemanticsNodes().isNotEmpty() }
        gymShot("server-apps")
    }

    // ─── Server order: Make leader stays gray until the box confirms ─────────

    @Test
    fun makeLeaderWaitsForTheServerToConfirm() {
        launch(tab = "home", username = "bright-maple", adminRoot = true)
        waitUntilTextExists("Office tower, work failover", timeoutMs = 20_000)
        composeRule.onNodeWithText("Office tower, work failover").performScrollTo().performClick()
        waitUntilExists("sd-make-leader", timeoutMs = 20_000)
        composeRule.onNodeWithTag("sd-make-leader").performScrollTo()
        gymShot("server-order-card")
        composeRule.onNodeWithTag("sd-make-leader").performClick()
        waitUntilExists("sd-leader-pending", timeoutMs = 15_000)
        composeRule.onNodeWithTag("sd-leader-status").assertTextContains("This server leads")
        gymShot("server-order-pending")
        assertSigned("server-order", "admin")

        // Home shows Office as the leader, in gray, until it confirms.
        Espresso.pressBack()
        waitUntilTextExists("Office tower, work failover", timeoutMs = 15_000)
        composeRule.waitUntil(10_000) { count("leader-badge-pending", unmerged = true) == 1 }
        assertEquals("Only the gray badge shows while Office hasn't confirmed", 0, count("leader-badge", unmerged = true))
        assertTrue(
            "The gray badge says it's waiting",
            composeRule.onAllNodesWithContentDescription("Leader, waiting for the server to confirm", useUnmergedTree = true)
                .fetchSemanticsNodes().isNotEmpty(),
        )
        gymShot("server-order-home-gray")
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

    // ─── App access requests: the app-wide dialogs ───────────────────────────

    /** Plants has two hosts waiting. The dialog asks about each in turn; Allow
     *  and Deny sign the edited list and say what happened, and once both are
     *  answered nothing covers Home. */
    @Test
    fun appAccessAlertAllowThenDeny() {
        launch(tab = "home", username = "bright-maple", accessAlert = true, adminRoot = true)
        waitUntilExists("access-alert-title", timeoutMs = 20_000)
        val ask = "Plants wants to reach "
        val first = textOf("access-alert-title")
        assertTrue("Got: $first", first.startsWith(ask))
        val firstHost = first.removePrefix(ask)
        gymShot("access-alert-ask")

        composeRule.onNodeWithTag("access-alert-allow").performClick()
        waitUntilExists("access-alert-done", timeoutMs = 15_000)
        waitUntilTextExists("Plants can now reach $firstHost")
        gymShot("access-alert-allowed")
        composeRule.onNodeWithTag("access-alert-close").performClick()

        waitUntilExists("access-alert-title", timeoutMs = 15_000)
        val secondHost = textOf("access-alert-title").removePrefix(ask)
        assertNotEquals(firstHost, secondHost)
        composeRule.onNodeWithTag("access-alert-deny").performClick()
        waitUntilExists("access-alert-done", timeoutMs = 15_000)
        waitUntilTextExists("Plants won't reach $secondHost")
        composeRule.onNodeWithTag("access-alert-close").performClick()

        composeRule.waitUntil(10_000) { count("access-alert-title") == 0 && count("access-alert-done") == 0 }
        composeRule.onNodeWithTag("home-add-server").performScrollTo().assertIsDisplayed()
        gymShot("access-alert-answered")
        assertEquals(listOf("app-access:admin", "app-access:admin"), signedChecks())
    }

    /** "Not now" closes the dialog and leaves the request on the box. */
    @Test
    fun appAccessAlertNotNowCloses() {
        launch(tab = "home", username = "bright-maple", accessAlert = true, adminRoot = true)
        waitUntilExists("access-alert-title", timeoutMs = 20_000)
        composeRule.onNodeWithTag("access-alert-not-now").performClick()
        composeRule.waitForIdle()
        // The next waiting host follows; not-now it too.
        if (count("access-alert-title") > 0) composeRule.onNodeWithTag("access-alert-not-now").performClick()
        composeRule.waitUntil(10_000) { count("access-alert-title") == 0 }
        composeRule.onNodeWithTag("home-add-server").performScrollTo().assertIsDisplayed()
        gymShot("access-alert-closed")
    }

    // ─── Share this server ───────────────────────────────────────────────────

    /** The owner's "Shared with" card on Home's page: Alex accepted (compare
     *  the code, then confirm), Sam is active, and sharing again walks the
     *  sheet to a real link. */
    @Test
    fun shareServerOwnerSeesSharesAndConfirmsCode() {
        launch(tab = "home", username = "bright-maple", shares = true, adminRoot = true)
        waitUntilTextExists("Living-room mini-PC", timeoutMs = 20_000)
        composeRule.onNodeWithText("Living-room mini-PC").performScrollTo().performClick()
        waitUntilExists("share-server-card", timeoutMs = 30_000)
        composeRule.waitUntil(30_000) { countPrefix("share-sas-") == 1 }
        val sasNode = composeRule.onAllNodes(tagStartsWith("share-sas-")).onFirst()
        sasNode.performScrollTo()
        val sas = sasNode.fetchSemanticsNode().config
            .getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }.orEmpty()
        assertTrue("Alex's code reads as six digits; got $sas", sas.matches(Regex("\\d{3} \\d{3}")))
        assertEquals("Alex (accepted) and Sam (active)", 2, countPrefix("share-row-"))
        gymShot("share-owner")

        composeRule.onNodeWithTag("share-confirm").performScrollTo().performClick()
        composeRule.waitUntil(15_000) { countPrefix("share-sas-") == 0 }
        assertEquals("Alex is active once confirmed", 2, countPrefix("share-row-"))

        composeRule.onNodeWithTag("share-server-open").performScrollTo().performClick()
        waitUntilExists("share-sheet")
        composeRule.onNodeWithTag("share-label").performTextInput("Robin")
        composeRule.onNodeWithTag("share-next").performClick()
        // The active rows offer the same choice; take the sheet's.
        val sheetManage = hasTestTag("share-level-manage") and hasAnyAncestor(hasTestTag("share-sheet"))
        composeRule.waitUntil(10_000) { composeRule.onAllNodes(sheetManage).fetchSemanticsNodes().isNotEmpty() }
        composeRule.onNode(sheetManage).performClick()
        composeRule.onNodeWithTag("share-next").performClick()
        waitUntilExists("share-create")
        gymShot("share-sheet")
        composeRule.onNodeWithTag("share-create").performClick()
        waitUntilExists("share-link", timeoutMs = 15_000)
        assertTrue("A share link", textOf("share-link").contains("/share#s="))
        gymShot("share-link")
        assertSigned("share-grant", "admin")
    }

    /** Only an admin device of the account accepts a co-manage share
     *  (docs/share-a-server.md §5.1): on this one, Mina's Studio link shows the
     *  sentence and no Accept. */
    @Test
    fun shareLinkOnANonAdminDeviceShowsTheSentence() {
        launch(tab = "home", username = "bright-maple", shares = true, deepLink = MockServerShares.STUDIO_LINK)
        waitUntilExists("add-server-admin-only", timeoutMs = 30_000)
        composeRule.onNodeWithText("Only an admin device of your account can accept a co-manage invitation.").assertIsDisplayed()
        assertEquals("No Accept on a non-admin device", 0, count("share-accept-button"))
        gymShot("share-accept-non-admin")
    }

    /** An admin device accepts Mina's Studio link: the mock `.com` takes the
     *  acceptance only with #12 signed by this account's admin root and its
     *  attestation, and the code to read to the owner shows. */
    @Test
    fun shareLinkOnAnAdminDeviceSignsTheAcceptance() {
        launch(tab = "home", username = "bright-maple", shares = true, adminRoot = true, deepLink = MockServerShares.STUDIO_LINK)
        waitUntilExists("share-accept-button", timeoutMs = 30_000)
        gymShot("share-accept-offer")
        composeRule.onNodeWithTag("share-accept-button").performScrollTo().performClick()
        waitUntilExists("share-accept-sas", timeoutMs = 20_000)
        val sas = textOf("share-accept-sas")
        assertTrue("A six-digit code; got $sas", sas.replace(" ", "").matches(Regex("\\d{6}")))
        gymShot("share-accept-code")
    }

    /** Servers shared with this phone: Home lists them, and a co-manager can
     *  approve the shared server's start-up and leave it, but never delete or
     *  revoke it. */
    @Test
    fun sharedServerCoManagerView() {
        launch(tab = "home", username = "bright-maple", shares = true)
        waitUntilExists("home-shared-with-me", timeoutMs = 30_000)
        composeRule.onNodeWithTag("home-shared-with-me").performScrollTo()
        composeRule.waitUntil(15_000) { countPrefix("home-shared-") == 4 }
        waitUntilTextExists("Waiting for the owner")
        gymShot("shared-with-me")

        composeRule.onNodeWithText("Garage").performScrollTo().performClick()
        waitUntilExists("shared-approve-startup", timeoutMs = 20_000)
        composeRule.onNodeWithTag("shared-leave").performScrollTo().assertIsDisplayed()
        assertEquals(
            "A co-manager can never delete the server", 0,
            composeRule.onAllNodesWithContentDescription("sd-delete-server").fetchSemanticsNodes().size,
        )
        assertEquals(
            "…nor revoke it", 0,
            composeRule.onAllNodesWithContentDescription("sd-revoke-server").fetchSemanticsNodes().size,
        )
        gymShot("shared-server-member")

        composeRule.onNodeWithTag("shared-approve-startup").performScrollTo().performClick()
        composeRule.waitUntil(15_000) { count("shared-approve-startup") == 0 }
        gymShot("shared-server-unlocked")
    }

    // ─── Co-manager invites (docs/service-access-gating.md "Co-manager invites") ──

    /** Home → a shared server → one of its apps. */
    private fun openSharedApp(server: String, serviceId: String) {
        launch(tab = "home", username = "bright-maple", shares = true)
        waitUntilExists("home-shared-with-me", timeoutMs = 30_000)
        waitUntilTextExists(server, timeoutMs = 15_000)
        composeRule.onNodeWithText(server).performScrollTo().performClick()
        waitUntilExists("shared-app-row-$serviceId", timeoutMs = 20_000)
        composeRule.onNodeWithTag("shared-app-row-$serviceId").performScrollTo().performClick()
        waitUntilExists("shared-app-card", timeoutMs = 20_000)
    }

    /** At Can manage, Plants offers Invite people: add a person at Member,
     *  the link names the shared server, Your invites lists them, Withdraw
     *  asks first and empties the list. */
    @Test
    fun coManagerInvitesAPersonAndWithdraws() {
        openSharedApp("Garage", "bright-maple--plants")
        composeRule.onNodeWithTag("co-invite-open").performScrollTo().assertTextContains("Invite people").performClick()
        // The list loads from the shared server (slow on a busy machine): wait for its answer, and say what a refusal was.
        composeRule.waitUntil(30_000) {
            count("co-invite-line") > 0 || count("co-invite-error") > 0
        }
        assertEquals("the invite panel opened without an error: " + (if (count("co-invite-error") > 0) textOf("co-invite-error") else ""), 1, count("co-invite-line"))
        assertEquals("People you invite join as Member. You can withdraw your own invites.", textOf("co-invite-line"))
        assertEquals(1, count("co-invite-none"))
        composeRule.onNodeWithTag("co-invite-add-person").performScrollTo().performClick()
        waitUntilExists("co-invite-name")
        composeRule.onNodeWithTag("co-invite-name").performTextInput("Alex")
        composeRule.onNodeWithTag("co-invite-create").performScrollTo().performClick()
        // Creating signs and posts through the shared server: wait for the link or a refusal, and name the refusal.
        composeRule.waitUntil(30_000) { count("co-invite-link") > 0 || count("co-invite-error") > 0 }
        assertEquals("the invite was created: " + (if (count("co-invite-error") > 0) textOf("co-invite-error") else ""), 1, count("co-invite-link"))
        val link = textOf("co-invite-link")
        assertTrue(link, link.startsWith("https://garage.jordan-reyes.flagship.services/invite#"))
        assertTrue(link, link.endsWith("&s=bright-maple--plants"))
        waitUntilTextExists("Alex · Not opened yet")
        gymShot("co-invite-created")
        composeRule.onAllNodes(tagStartsWith("co-invite-withdraw-")).onFirst().performScrollTo().performClick()
        waitUntilTextExists("Withdraw this invite?")
        composeRule.onNodeWithTag("co-invite-withdraw-confirm").performClick()
        waitUntilExists("co-invite-none", timeoutMs = 15_000)
    }

    /** Wiki: an admin made the co-manager a Member there, so the panel shows
     *  the box's sentence, their old invite without Withdraw, and no add. */
    @Test
    fun coManagerDemotedSeesWhyAndNoWithdraw() {
        openSharedApp("Garage", "bright-maple--wiki")
        composeRule.onNodeWithTag("co-invite-open").performScrollTo().performClick()
        waitUntilExists("co-invite-why", timeoutMs = 15_000)
        assertEquals("An admin made you a Member of this app, so you can't invite people to it.", textOf("co-invite-why"))
        waitUntilTextExists("Jo · 1 person joined")
        assertEquals(0, count("co-invite-add-person"))
        assertEquals(0, count("co-invite-add-group"))
        assertEquals(0, countPrefix("co-invite-withdraw-"))
        gymShot("co-invite-demoted")
    }

    /** Can view: the Apps card says why there's no Invite people, and an app has none. */
    @Test
    fun coManagerViewOnlyCantInvite() {
        launch(tab = "home", username = "bright-maple", shares = true)
        waitUntilExists("home-shared-with-me", timeoutMs = 30_000)
        waitUntilTextExists("Cabin", timeoutMs = 15_000)
        composeRule.onNodeWithText("Cabin").performScrollTo().performClick()
        waitUntilExists("co-invite-view-only", timeoutMs = 20_000)
        assertEquals("You can view this server but not manage it, so you can't invite people to its apps.", textOf("co-invite-view-only"))
        gymShot("co-invite-view-only")
        composeRule.onNodeWithTag("shared-app-row-bright-maple--plants").performScrollTo().performClick()
        waitUntilExists("shared-app-card", timeoutMs = 20_000)
        assertEquals(0, count("co-invite-open"))
    }
}
