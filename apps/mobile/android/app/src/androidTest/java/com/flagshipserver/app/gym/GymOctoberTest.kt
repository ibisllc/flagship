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
import androidx.compose.ui.test.performTextInput
import androidx.test.espresso.Espresso
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

    /** Only an admin device changes the mode. */
    @Test
    fun accessControlSwitchesToMembersOnly() {
        openPlants(adminRoot = true)
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
        composeRule.onNodeWithText("Only an admin device can give a higher rank").assertIsDisplayed()
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
        composeRule.onNodeWithTag("service-access-create-invite").performScrollTo().performClick()
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodesWithText("Invited by", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onAllNodesWithText("Invited by", substring = true).onFirst().performScrollTo()
        gymShot("access-invited-by")
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
        launch(tab = "home", username = "bright-maple", accessAlert = true)
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
    }

    /** "Not now" closes the dialog and leaves the request on the box. */
    @Test
    fun appAccessAlertNotNowCloses() {
        launch(tab = "home", username = "bright-maple", accessAlert = true)
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
        launch(tab = "home", username = "bright-maple", shares = true)
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
    }

    /** Servers shared with this phone: Home lists them, and a co-manager can
     *  approve the shared server's start-up and leave it, but never delete or
     *  revoke it. */
    @Test
    fun sharedServerCoManagerView() {
        launch(tab = "home", username = "bright-maple", shares = true)
        waitUntilExists("home-shared-with-me", timeoutMs = 30_000)
        composeRule.onNodeWithTag("home-shared-with-me").performScrollTo()
        composeRule.waitUntil(15_000) { countPrefix("home-shared-") == 3 }
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
}
