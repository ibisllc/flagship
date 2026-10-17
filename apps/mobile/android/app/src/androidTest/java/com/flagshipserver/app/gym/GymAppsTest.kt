// GYM Android button sweep — the Services tab and an app's page (Plants on
// the mock box): search, environment variables, Uninstall, Runs on (tick and
// untick), the v1 internet approval, Edit with AI or an IDE, the adaptation
// report, Copy, the access list (Deny, Ignore, the editor, a suggested list),
// Access control (back to Open to all, a group invite, its link, a rank, a
// revoke), API keys (scope, Copy, Done, Revoke), the Database (paging, CSV,
// SQL, a signed write) and Back up now. Each admin order is checked for its
// signer: the admin root (MockSignatures). NO BACKEND.

package com.flagshipserver.app.gym

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.test.espresso.Espresso
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymAppsTest : GymBase() {

    private val plants = "bright-maple--plants"

    private fun openPlants(admin: Boolean = true, before: () -> Unit = {}) {
        launch(tab = "apps", adminRoot = admin)
        before()
        openPlantsFromServices()
    }

    private fun firstTagWith(prefix: String): String {
        composeRule.waitUntil(20_000) { composeRule.onAllNodes(tagPrefix(prefix)).fetchSemanticsNodes().isNotEmpty() }
        return composeRule.onAllNodes(tagPrefix(prefix)).fetchSemanticsNodes().first().config[SemanticsProperties.TestTag]
    }

    // ─── Services list ───────────────────────────────────────────────────────

    @Test
    fun servicesSearchFindsAnApp() {
        launch(tab = "apps")
        waitText("Houseplant watering tracker", 20_000)
        composeRule.onAllNodes(hasSetTextAction()).onFirst().performTextInput("zzzz")
        eventually(what = "no Plants") { textCount("Houseplant watering tracker") == 0 }
        gymShot("services-no-match")
    }

    // ─── Environment ─────────────────────────────────────────────────────────

    @Test
    fun envVariableAddAndRemove() {
        openPlants()
        tap("service-detail-env-row", 20_000)
        tap("service-env-add-btn")
        type("service-env-name-field", "GYM_COLOR")
        type("service-env-value-field", "green")
        tap("service-env-save-btn")
        waitUntilExists("service-env-row-GYM_COLOR", 15_000)
        gymShot("env-added")
        tap("service-env-remove-GYM_COLOR")
        waitGone("service-env-row-GYM_COLOR", 15_000)
    }

    // ─── Uninstall ───────────────────────────────────────────────────────────

    /** Cancel sends nothing; Uninstall sends the admin-signed order and leaves the page. */
    @Test
    fun uninstallAsksThenSignsWithTheAdminRoot() {
        openPlants()
        tap("service-detail-uninstall-btn", 20_000)
        waitText("Uninstall service?")
        tapText("Cancel")
        waitTextGone("Uninstall service?")
        assertTrue(screensMock.uninstalls.isEmpty())
        tap("service-detail-uninstall-btn")
        composeRule.onNode(hasText("Uninstall") and androidx.compose.ui.test.hasClickAction() and !hasTestTag("service-detail-uninstall-btn"))
            .performClick()
        assertSigned("uninstall", "admin")
        eventually(what = "the order") { screensMock.uninstalls.single().first == plants }
        waitText("Houseplant watering tracker", 15_000)
        gymShot("uninstalled")
    }

    // ─── Runs on ─────────────────────────────────────────────────────────────

    /** Unticking a server asks, then removes that copy with an admin-signed
     *  uninstall. (The one mock answers every box with the app, so the tick
     *  that copies it is covered by AppPlacementViewModelTest, not here.) */
    @Test
    fun runsOnUntickAsksThenRemoves() {
        openPlants()
        fun ticked() = composeRule.onAllNodes(tagPrefix("runs-on-toggle-")).fetchSemanticsNodes().filter { n ->
            n.config.getOrNull(SemanticsProperties.ToggleableState) == androidx.compose.ui.state.ToggleableState.On &&
                n.config.getOrNull(SemanticsProperties.Disabled) == null
        }.map { it.config[SemanticsProperties.TestTag] }
        composeRule.waitUntil(20_000) { ticked().isNotEmpty() }
        gymShot("runs-on")
        val on = ticked().first()
        tap(on)
        waitUntilExists("runs-on-remove-confirm")
        tapText("Cancel")
        assertTrue(screensMock.uninstalls.isEmpty())
        tap(on)
        tap("runs-on-remove-confirm")
        assertSigned("uninstall", "admin")
        eventually(what = "the uninstall") { screensMock.uninstalls.isNotEmpty() }
    }

    // ─── v1 internet approval (a box without access lists) ──────────────────

    @Test
    fun egressAllowThenStop() {
        openPlants(before = {
            screensMock.accessFixture.remove(plants)
        })
        tap("service-detail-egress-allow", 20_000)
        assertSigned("app-egress", "admin")
        waitUntilExists("service-detail-egress-approved", 15_000)
        assertEquals(listOf("api.open-meteo.com"), screensMock.egressCalls.last().second.grant.hosts)
        gymShot("egress-approved")
        tap("service-detail-egress-stop")
        eventually(what = "stopped") { screensMock.egressCalls.size == 2 && screensMock.egressCalls.last().second.grant.hosts.isEmpty() }
    }

    // ─── Edit and report ─────────────────────────────────────────────────────

    @Test
    fun editWithAiOrAnIde() {
        openPlants()
        tap("service-detail-edit", 20_000)
        tap("edit-service-ai")
        waitUntilExists("edit-describe-start", 15_000)
        gymShot("edit-ai")
        Espresso.pressBack()
        tap("edit-service-ide")
        waitUntilExists("build-mcp-create", 15_000)
        gymShot("edit-ide")
    }

    /** An app built from a shared adaptation can report it. */
    @Test
    fun reportAnAdaptation() {
        openPlants(before = { screensMock.adaptedFromFixture = mapOf(plants to "github.com/gym/plants") })
        tap("service-detail-report-adapter", 20_000)
        type("adapter-report-text", "The sensor page is blank.")
        tap("adapter-report-send")
        eventually(what = "the report") { screensMock.adapterReports.singleOrNull()?.first == plants }
        gymShot("adapter-reported")
        tapText("Done")
    }

    @Test
    fun copyTheAppsAddress() {
        openPlants()
        tapMatching(androidx.compose.ui.test.hasContentDescription("Copy https", substring = true))
        eventually(what = "clipboard") { clipboardText().startsWith("https://") }
    }

    // ─── Access list ─────────────────────────────────────────────────────────

    @Test
    fun accessDenyAndIgnoreOnThePage() {
        openPlants(before = {
            screensMock.accessFixture[plants] = screensMock.accessFixture[plants]!!.copy(
                pending = screensMock.accessFixture[plants]!!.pending + com.flagshipserver.app.api.AppAccessPending(
                    "tile.openstreetmap.org", com.flagshipserver.app.api.AppAccessPending.SOURCE_ATTEMPT, 2, 1, 2,
                ),
            )
        })
        waitUntilExists("service-detail-access-deny", 20_000)
        tap("service-detail-access-deny")
        assertSigned("app-access", "admin")
        eventually(what = "deny rule") { screensMock.accessCalls.last().second.list.contains("deny ") }
        tap("service-detail-access-ignore")
        eventually(what = "ignored") { screensMock.accessDismissals.isNotEmpty() }
        composeRule.waitUntil(10_000) { tagCount("service-detail-access-ignore") == 0 }
        gymShot("access-answered")
    }

    /** The list editor saves an admin-signed list. */
    @Test
    fun accessListEditorSaves() {
        openPlants()
        tap("service-detail-access-view", 20_000)
        waitUntilExists("access-list-save", 15_000)
        composeRule.onAllNodes(hasSetTextAction()).onFirst().performTextInput("allow api.gym.example\n")
        tap("access-list-save")
        assertSigned("app-access", "admin")
        eventually(what = "saved list") { screensMock.accessCalls.lastOrNull()?.second?.list?.contains("api.gym.example") == true }
        gymShot("access-list-saved")
    }

    /** A suggested list: Review opens it, Dismiss drops it. */
    @Test
    fun accessDraftReviewAndDismiss() {
        val seed = {
            screensMock.accessFixture[plants] = screensMock.accessFixture[plants]!!.copy(
                draft = com.flagshipserver.app.api.AppAccessDraft(list = "allow api.open-meteo.com\n", hosts = listOf(com.flagshipserver.app.api.AppAccessSuggestion("api.open-meteo.com", "weather")), createdAt = 1),
            )
        }
        openPlants(before = seed)
        tap("service-detail-access-draft-review", 20_000)
        waitUntilExists("access-list-save", 15_000)
        gymShot("draft-review")
        Espresso.pressBack()
        tap("service-detail-access-draft-dismiss", 15_000)
        eventually(what = "dismissed") { screensMock.accessDraftDismissals == listOf(plants) }
    }

    // ─── Access control ──────────────────────────────────────────────────────

    private fun openAccessControl(admin: Boolean = true, rank: String? = null) {
        launch(tab = "apps", adminRoot = admin, deviceRank = rank)
        openPlantsFromServices()
        tap("service-detail-access-row", 20_000)
        waitUntilExists("service-access-account-members-title", 15_000)
    }

    /** Members only, then back to Open to all: two admin-signed mode orders. */
    @Test
    fun accessModeBackToOpen() {
        openAccessControl()
        tap("service-access-mode-members")
        tap("service-access-members-only-confirm")
        waitText("Only members and you can open it", 15_000)
        tap("service-access-mode-open")
        waitText("Anyone can open it", 15_000)
        assertEquals(listOf("bright-maple--plants" to "restricted", "bright-maple--plants" to "open").map { it.second },
            com.flagshipserver.app.core.GymProbe.access!!.modeOrders.map { it.second })
        assertEquals(2, signedChecks().count { it == "access-mode:admin" })
        gymShot("open-again")
    }

    /** A group invite (approve each person), its link: Copy and Share…. */
    @Test
    fun groupInviteLinkCopyAndShare() {
        openAccessControl()
        tap("service-access-add-group")
        type("service-access-name-field", "Chess club")
        tap("service-access-create-invite")
        waitUntilExists("service-access-share-url", 15_000)
        val link = textOfTag("service-access-share-url")
        tap("service-access-copy-btn")
        eventually(what = "clipboard") { clipboardText() == link }
        tap("service-access-share-sheet")
        eventually(what = "share sheet") { sharedTexts().any { it.contains(link) } }
        gymShot("group-link")
    }

    /** An admin gives an invite a higher rank (signed), then revokes it. */
    @Test
    fun inviteRankThenRevoke() {
        openAccessControl()
        tap("service-access-add-person")
        type("service-access-name-field", "Gym friend")
        tap("service-access-approve-toggle")
        tap("service-access-create-invite")
        val role = firstTagWith("service-access-role-")
        val inviteId = role.removePrefix("service-access-role-")
        composeRule.onNodeWithTag(role).scrollIfNeeded().performClick()
        tap("$role-manager")
        assertSigned("app-rank", "admin")
        eventually(what = "the rank order") { screensMock.setAppRankCalls.any { it.second.order.target == "invite:$inviteId" && it.second.order.rank == "manager" } }
        tap("service-access-remove-$inviteId")
        tap("service-access-remove-confirm")
        composeRule.waitUntil(15_000) { tagCount("service-access-remove-$inviteId") == 0 }
        gymShot("invite-revoked")
    }

    /** A Master-rank device and a refused one see why they can or can't invite. */
    @Test
    fun masterAndRefusedDevicesSeeTheirRank() {
        openAccessControl(admin = false, rank = "master")
        waitUntilExists("service-access-add-person")
        composeRule.onAllNodes(hasText("Master", substring = true)).fetchSemanticsNodes().isNotEmpty().let(::assertTrue)
        gymShot("master")
        openAccessControl(admin = false, rank = "refused")
        waitUntilExists("service-access-cant-invite")
        assertEquals(0, tagCount("service-access-add-person"))
        gymShot("refused")
    }

    // ─── API keys ────────────────────────────────────────────────────────────

    /** Create with the write scope, Copy the secret, Done; revoke the old key. */
    @Test
    fun apiKeyScopeCopyDoneAndRevoke() {
        openPlants()
        tap("service-detail-api-keys-create", 20_000)
        type("api-key-create-label", "Gym writer")
        tap("api-key-create-scope-write")
        tap("api-key-create-confirm")
        waitUntilExists("api-key-created-value", 15_000)
        assertEquals("write", screensMock.apiKeyCreates.single().second.grant.scope)
        val secret = textOfTag("api-key-created-value")
        tap("api-key-created-copy")
        eventually(what = "clipboard") { clipboardText() == secret }
        tap("api-key-created-done")
        waitGone("api-key-created-dialog")
        waitText("Garden sensor")
        tapMatching(hasTestTag("service-detail-api-key-revoke") and hasAnyAncestor(hasTestTag("service-detail-api-key-5d2c8e0f9a7b1346")))
        tap("api-key-revoke-confirm")
        eventually(what = "revoked") { screensMock.apiKeyRevokes.singleOrNull()?.second == "5d2c8e0f9a7b1346" }
        waitTextGone("Garden sensor")
        gymShot("api-keys")
    }

    // ─── Database ────────────────────────────────────────────────────────────

    /** Page through 230 rows, export the CSV, run a SELECT, and a write that
     *  needs (and gets) the admin-signed confirmation. */
    @Test
    fun databasePagingCsvSqlAndSignedWrite() {
        openPlants()
        tap("service-detail-database", 20_000)
        composeRule.waitUntil(15_000) { tagCount("db-table-row") > 0 }
        composeRule.onAllNodesWithTag("db-table-row").onFirst().performClick()
        waitUntilExists("db-range", 15_000)
        /** The range line sits at the top of a lazy list: scroll it into view first. */
        fun range(): String? = runCatching {
            composeRule.onAllNodes(androidx.compose.ui.test.hasScrollToNodeAction()).onFirst()
                .performScrollToNode(hasTestTag("db-range"))
            textOfTag("db-range")
        }.getOrNull()
        composeRule.waitUntil(15_000) { range()?.startsWith("Rows") == true }
        val first = range()
        tap("db-next")
        eventually(what = "the next page") { range().let { it != null && it != first } }
        tap("db-prev")
        eventually(what = "back to $first, now ${range()}") { range() == first }
        tap("db-export-csv")
        eventually(what = "the CSV handed to the share sheet") { sharedStreams().any { it.toString().endsWith(".csv") } }
        gymShot("db-grid")
        Espresso.pressBack()
        tap("db-run-sql", 15_000)
        type("db-sql-editor", "SELECT * FROM plants")
        tap("db-sql-run")
        waitUntilExists("db-sql-summary", 15_000)
        composeRule.onNode(hasSetTextAction() and (hasTestTag("db-sql-editor") or hasAnyAncestor(hasTestTag("db-sql-editor"))))
            .performTextReplacement("UPDATE plants SET watered = true")
        tap("db-sql-run")
        tap("db-confirm-write", 15_000)
        assertSigned("app-db-write", "admin")
        waitUntilExists("db-sql-summary", 15_000)
        gymShot("db-write")
    }

    // ─── Back up now ─────────────────────────────────────────────────────────

    @Test
    fun appBackUpNowAndSave() {
        openPlants()
        tap("service-detail-backup-data", 20_000)
        composeRule.onNodeWithTag("service-detail-backup-data").assertIsOn()
        tap("service-detail-backup-now")
        tap("service-detail-backup-save", 20_000)
        eventually(what = "the backup handed to the share sheet") { sharedStreams().isNotEmpty() }
        gymShot("app-backup")
    }
}
