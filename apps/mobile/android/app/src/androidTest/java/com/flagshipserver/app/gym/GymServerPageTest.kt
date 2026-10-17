// GYM Android button sweep — a server's page, reached from Home: the update
// sheet (latest, other releases, Advanced, Check again), revoke (reason +
// hold to confirm) and un-revoke, delete with the typed name, power, the
// dead-man lock, the front page, the journal, a waiting box's approval and
// Migrate. Every sensitive order is checked against the mock `.com` / box
// for its effect and its signer (the admin root; MockSignatures). NO BACKEND.

package com.flagshipserver.app.gym

import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.down
import androidx.compose.ui.test.up
import androidx.test.espresso.Espresso
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymServerPageTest : GymBase() {

    private val home = "Living-room mini-PC"
    private val office = "Office tower, work failover"

    private fun openServer(name: String = home, admin: Boolean = true, podsVariant: String? = null) {
        launch(tab = "home", adminRoot = admin, username = "bright-maple", podsVariant = podsVariant)
        openServerFromHome(name)
    }

    private val boxDirect get() = com.flagshipserver.app.core.GymProbe.boxDirect!!

    // ─── A device without the admin root ─────────────────────────────────────

    /** Every order on the page signs under the admin root, which `.com` and
     *  the box require: another device of the account sees the page with each
     *  control off and one line saying why; the share card says it too. */
    @Test
    fun nonAdminDeviceSeesThePageReadOnly() {
        launch(tab = "home", username = "bright-maple", shares = true)
        openServerFromHome(home)
        waitUntilExists("sd-server-admin-only", 20_000)
        assertEquals(
            "Only an admin device can change this server. This device can see it.",
            textOfTag("sd-server-admin-only"),
        )
        for (desc in listOf(
            "sd-update-server", "sd-power-off", "sd-power-restart", "sd-deadman-toggle", "sd-backup-server",
            "sd-migrate-server", "sd-transfer-server", "sd-revoke-server", "sd-delete-server",
        )) {
            waitUntilExistsDesc(desc, 20_000)
            composeRule.onNode(hasContentDescription(desc)).scrollIfNeeded().assertIsNotEnabled()
        }
        waitUntilExists("share-admin-only", 30_000)
        assertEquals("Only an admin device can share this server.", textOfTag("share-admin-only"))
        composeRule.onNodeWithTag("share-server-open").scrollIfNeeded().assertIsNotEnabled()
        assertEquals("no order was signed (only the share world's own seeding)", emptyList<String>(), signedChecks().filterNot { it.startsWith("share-") })
        gymShot("non-admin-server-page")
    }

    // ─── Update ──────────────────────────────────────────────────────────────

    /** Update to latest signs the order with the admin root, deposits it on
     *  `.com`, and the card shows it as sent. */
    @Test
    fun updateToLatestOrdersTheNewRelease() {
        openServer()
        tapDesc("sd-update-server", 20_000)
        waitUntilExistsDesc("update-latest-btn", 15_000)
        gymShot("update-sheet")
        tapDesc("update-latest-btn")
        assertSigned("server-update", "admin")
        eventually(what = "the deposit") { mailboxMock.updateDeposits.size == 1 }
        assertEquals("4b1e0c9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c", mailboxMock.updateDeposits.single().second.order.targetCommit)
        waitUntilExistsDesc("sd-update-pending")
        gymShot("update-sent")
        tap("sheet-close")
        waitUntilExistsDesc("sd-update-pending")
    }

    /** Advanced: the warning, an older release to go back to, and a typed
     *  commit with Order update. */
    @Test
    fun updateAdvancedGoesBackToAnOlderRelease() {
        openServer()
        tapDesc("sd-update-server", 20_000)
        waitUntilExistsDesc("update-latest-btn", 15_000)
        tapDesc("update-advanced")
        waitText("Older releases don't have the fixes")
        gymShot("update-advanced")
        tapText("Go back")
        assertSigned("server-update", "admin")
        eventually(what = "the deposit") { mailboxMock.updateDeposits.size == 1 }
        assertEquals("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b", mailboxMock.updateDeposits.single().second.order.targetCommit)
    }

    @Test
    fun updateAdvancedOrdersATypedCommit() {
        openServer()
        tapDesc("sd-update-server", 20_000)
        waitUntilExistsDesc("update-latest-btn", 15_000)
        tapDesc("update-advanced")
        type("update-target-field", "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b")
        tapDesc("update-order-btn")
        assertSigned("server-update", "admin")
        eventually(what = "the deposit") { mailboxMock.updateDeposits.size == 1 }
    }

    // ─── Revoke, un-revoke, delete ───────────────────────────────────────────

    /** Revoke needs a reason and a 1.5 s hold; un-revoke brings it back. Both
     *  orders go to `.com` signed with the admin root. */
    @Test
    fun revokeHoldToConfirmThenUnrevoke() {
        openServer(office)
        tapDesc("sd-revoke-server", 20_000)
        waitUntilExistsDesc("revoke-reason-stolen")
        tapDesc("revoke-reason-stolen")
        gymShot("revoke-sheet")
        // A short tap does nothing.
        composeRule.onNode(hasContentDescription("revoke-confirm-hold")).performClick()
        composeRule.waitForIdle()
        assertTrue(comMock.revokedServers.isEmpty())
        // Hold until the order goes out.
        val hold = composeRule.onNode(hasContentDescription("revoke-confirm-hold"))
        hold.performTouchInput { down(center) }
        waitText("Hold to confirm…", 3_000)
        // The hold is a real-time 1.5 s timer.
        Thread.sleep(1_800)
        composeRule.mainClock.advanceTimeBy(500)
        eventually(8_000, "the revoke") { comMock.revokedServers.isNotEmpty() }
        // The sheet closes when the order goes out, taking the held finger with it.
        runCatching { hold.performTouchInput { up() } }
        assertSigned("revoke", "admin")
        assertEquals("stolen", comMock.revokedServers.single().request.reason)
        waitUntilExists("sd-revoked-card", 15_000)
        gymShot("revoked")
        tapDesc("sd-unrevoke-server")
        assertSigned("unrevoke", "admin")
        waitGone("sd-revoked-card", 15_000)
        gymShot("unrevoked")
    }

    /** Cancel on the revoke sheet leaves the server alone. */
    @Test
    fun revokeCancelLeavesTheServer() {
        openServer(office)
        tapDesc("sd-revoke-server", 20_000)
        waitUntilExistsDesc("revoke-reason-lost")
        tapText("Cancel")
        eventually(what = "sheet closed") { descCount("revoke-confirm-hold") == 0 }
        assertTrue(comMock.revokedServers.isEmpty())
    }

    /** Delete from the page: typed name, admin-signed release, back to Home
     *  without the server. */
    @Test
    fun deleteFromThePage() {
        openServer(office)
        tapDesc("sd-delete-server", 20_000)
        waitUntilExists("delete-server-dialog")
        type("delete-server-confirm-field", "office")
        tap("delete-server-confirm")
        assertSigned("release-name", "admin")
        eventually(what = "Office gone from Home") { textCount(office) == 0 }
        assertEquals(listOf("office.bright-maple.flagship.services"), comMock.releasedServerNames.map { it.request.serverDomain })
        gymShot("deleted")
    }

    // ─── Power ───────────────────────────────────────────────────────────────

    /** Each power button asks first; Cancel sends nothing, the confirm sends
     *  an admin-signed order straight to the box. */
    @Test
    fun powerAsksThenSendsTheSignedOrder() {
        openServer()
        tapDesc("sd-power-restart", 20_000)
        waitText("restart?")
        tapText("Cancel")
        waitTextGone("will go offline.")
        assertTrue(boxDirect.calls.none { it.path == "/api/power" })
        tapDesc("sd-power-off")
        waitText("will go offline.")
        gymShot("power-confirm")
        composeRule.onNode(hasText("Lock and turn off") and androidx.compose.ui.test.hasClickAction() and !hasContentDescription("sd-power-off"))
            .performClick()
        assertSigned("power", "admin")
        eventually(what = "the order") { boxDirect.calls.any { it.path == "/api/power" && it.body.contains("\"off\"") } }
        waitText("This server is powering off")
        gymShot("powering-off")
    }

    // ─── Dead-man lock ───────────────────────────────────────────────────────

    /** Turning the lock on signs the policy; a window and the lapse action
     *  re-sign it; Keep unlocked affirms and shows the countdown. */
    @Test
    fun deadManLockPolicyAndAffirm() {
        openServer()
        waitUntilExistsDesc("sd-deadman-toggle", 20_000)
        val toggle = composeRule.onNodeWithContentDescription("sd-deadman-toggle").scrollIfNeeded()
        if (descCount("sd-deadman-affirm") == 0) toggle.performClick()
        waitUntilExistsDesc("sd-deadman-affirm", 15_000)
        val windows = composeRule.onAllNodes(androidx.compose.ui.test.SemanticsMatcher("deadman window") {
            it.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.ContentDescription)?.any { d -> d.startsWith("deadman-window-") } == true
        }).fetchSemanticsNodes()
        assertTrue(windows.size >= 2)
        val before = boxDirect.calls.count { it.path == "/api/deadman/policy" }
        composeRule.onNodeWithContentDescription("deadman-lockout-restart").scrollIfNeeded().performClick()
        eventually(what = "re-signed") { boxDirect.calls.count { it.path == "/api/deadman/policy" } > before }
        assertTrue(boxDirect.calls.last { it.path == "/api/deadman/policy" }.body.contains("\"restart\""))
        assertSigned("deadman-policy", "admin")
        tapDesc("sd-deadman-affirm")
        assertSigned("deadman-affirm", "admin")
        waitText("Locks in")
        gymShot("deadman-on")
        tapText("Tighten now (5 min)")
        eventually(what = "tightened") { boxDirect.calls.last { it.path == "/api/deadman/policy" }.body.contains("300000") }
    }

    // ─── Front page and journal ──────────────────────────────────────────────

    @Test
    fun frontPagePicksAnApp() {
        openServer()
        waitUntilExists("sd-front-page-option-plants", 20_000)
        composeRule.onNodeWithTag("sd-front-page-option-plants").performScrollTo().performClick()
        tapDesc("sd-front-page-save")
        assertSigned("front-page", "admin")
        waitText("Front page set to plants")
        gymShot("front-page")
    }

    @Test
    fun journalFetchesTheChosenUnit() {
        openServer()
        tapDesc("sd-journal-unit-flagship-data-services", 20_000)
        tapDesc("sd-journal-fetch")
        waitText("gym: flagship-data-services is healthy")
        assertTrue(boxDirect.calls.any { it.path == "/api/journal" && it.body.contains("flagship-data-services") })
        gymShot("journal")
    }

    // ─── A box waiting for its phone ─────────────────────────────────────────

    /** Cabin waits for its phone: the page offers Approve and Deny; Deny
     *  closes the card without sending anything. */
    @Test
    fun waitingBoxOffersApproveAndDeny() {
        launch(tab = "home", adminRoot = true, podsVariant = "awaiting-unlock")
        openServerFromHome("Cabin mini-PC, just rebooted")
        waitUntilExistsDesc("sd-approve-unlock", 20_000)
        waitUntilExistsDesc("sd-deny-unlock")
        gymShot("waiting-box")
        tapDesc("sd-deny-unlock")
        eventually(what = "card closed") { descCount("sd-approve-unlock") == 0 }
        gymShot("denied")
    }

    // ─── Backup / Migrate ────────────────────────────────────────────────────

    /** Migrate: Start signs the migration order and deposits it on `.com`. */
    @Test
    fun migrateStartsTheHandOver() {
        openServer()
        // Migrate moves the data through peer backup: someone must hold the pieces.
        screensMock.peerBackupStatusFixture = kotlinx.coroutines.runBlocking { screensMock.peerBackupStatus() }.let {
            it.copy(
                participating = true,
                peersBackingYouUp = listOf(com.flagshipserver.app.api.PeerBackupPeerHostingYou("server-1", 3, 1, true)),
            )
        }
        // It also needs the box's own key from the account directory.
        mailboxMock.directory = listOf(
            com.flagshipserver.app.api.PodDirectoryEntry("home.bright-maple.flagship.services", "51".repeat(32)),
        )
        tapDesc("sd-migrate-server", 20_000)
        waitUntilExistsDesc("migrate-start", 15_000)
        gymShot("migrate")
        tapDesc("migrate-start")
        eventually(10_000, "the migration order") { mailboxMock.migrationStarts.isNotEmpty() }
        gymShot("migrate-started")
    }
}
