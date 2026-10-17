// GYM Android button sweep — Home: Add/Import a server and each of its
// choices, the server rows' touch-and-hold menu (Make leader, Send the backup,
// Delete), the server order (Move up/down, the drag handle), search and the
// status chips, the pod switcher, the trust and operations slivers. Each
// press is checked for its effect: where it lands, what the mock `.com`
// received and which key signed it (MockSignatures: an admin-pinned account,
// so an admin order the IRK signed would fail here). NO BACKEND.

package com.flagshipserver.app.gym

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.swipe
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.down
import androidx.compose.ui.test.moveBy
import androidx.compose.ui.test.up
import androidx.test.espresso.Espresso
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymHomeTest : GymBase() {

    private val office = "Office tower, work failover"
    private val home = "Living-room mini-PC"
    private val music = "Garage rack, music studio"

    private fun row(text: String) = hasText(text) and hasClickAction()

    private fun longPressRow(text: String) {
        waitText(text, 20_000)
        composeRule.onNode(row(text)).scrollIfNeeded().performTouchInput { longClick() }
        composeRule.waitForIdle()
    }

    /** The order Home shows, top to bottom, by the rows' summary lines. */
    private fun shownOrder(): List<String> =
        composeRule.onAllNodes(tagPrefix("home-server-row-")).fetchSemanticsNodes().map { node ->
            val texts = mutableListOf<String>()
            fun walk(n: androidx.compose.ui.semantics.SemanticsNode) {
                n.config.getOrNull(SemanticsProperties.Text)?.forEach { texts += it.text }
                n.children.forEach(::walk)
            }
            walk(node)
            listOf(home, office, music).firstOrNull { it in texts } ?: texts.joinToString("|")
        }

    // ─── Add/Import a server ─────────────────────────────────────────────────

    /** Each choice of the admin device's Add/Import menu lands on its flow,
     *  and Cancel closes the menu. */
    @Test
    fun addImportMenuEachChoiceLandsOnItsFlow() {
        launch(tab = "home", adminRoot = true, shares = true)
        tap("home-add-server")
        waitUntilExists("home-co-manage")
        assertEquals(1, tagCount("home-import-backup"))
        gymShot("add-import-menu")
        Espresso.pressBack()
        waitGone("home-co-manage")

        tap("home-add-server")
        tap("home-co-manage")
        waitUntilExists("share-link-open")
        waitText("Open a share link")
        gymShot("co-manage")
        Espresso.pressBack()

        tap("home-add-server")
        tap("home-import-backup")
        waitUntilExists("import-backup-choose")
        waitText("Import a backup")
        gymShot("import-backup")
    }

    /** "Co-manage a running server": a pasted link opens the shared server's
     *  offer, Accept sends this phone's share-key acceptance, and the code to
     *  read to the owner shows. */
    @Test
    fun coManageAcceptsAPastedShareLink() {
        launch(tab = "home", adminRoot = true, username = "bright-maple", shares = true)
        waitUntilExists("home-shared-with-me", 30_000)
        val link = kotlinx.coroutines.runBlocking { com.flagshipserver.app.core.MockServerShares.lastWorld!!.mintLinkForPhone() }
        tap("home-add-server")
        tap("home-co-manage")
        type("share-link-input", link)
        tap("share-link-open")
        waitUntilExists("share-accept-button", 20_000)
        waitText("Studio")
        gymShot("share-offer")
        tap("share-accept-button")
        waitUntilExists("share-accept-sas", 20_000)
        assertTrue(textOfTag("share-accept-sas").matches(Regex("\\d{3} \\d{3}")))
        gymShot("share-accepted")
    }

    // ─── The row menu ────────────────────────────────────────────────────────

    /** Touch and hold → Make leader moves Office to the top and signs the
     *  order with the admin root; the badge stays gray until Office confirms. */
    @Test
    fun rowMenuMakeLeaderSignsTheOrder() {
        launch(tab = "home", adminRoot = true, username = "bright-maple")
        longPressRow(office)
        waitUntilExists("pod-card-make-leader")
        gymShot("row-menu")
        tap("pod-card-make-leader")
        assertSigned("server-order", "admin")
        eventually(what = "Office first") { shownOrder().firstOrNull() == office }
        composeRule.waitUntil(10_000) { tagCount("leader-badge-pending", unmerged = true) == 1 }
        assertEquals(1, mailboxMock.serverOrders.size)
        gymShot("leader-moved")
    }

    /** Touch and hold → Delete server: the name must be typed, then the name
     *  is released with an admin-signed order and the row leaves Home. */
    @Test
    fun rowMenuDeleteNeedsTheTypedName() {
        launch(tab = "home", adminRoot = true, username = "bright-maple")
        longPressRow(music)
        tap("pod-card-delete")
        waitUntilExists("delete-server-dialog")
        composeRule.onNodeWithTag("delete-server-confirm").assertIsNotEnabled()
        type("delete-server-confirm-field", "music")
        gymShot("delete-typed")
        tap("delete-server-confirm")
        assertSigned("release-name", "admin")
        eventually(what = "Music gone") { textCount(music) == 0 }
        assertEquals(listOf("music.bright-maple.flagship.services"), comMock.releasedServerNames.map { it.request.serverDomain })
        gymShot("deleted")
    }

    /** Cancel keeps the server. */
    @Test
    fun deleteDialogCancelKeepsTheServer() {
        launch(tab = "home", adminRoot = true, username = "bright-maple")
        longPressRow(music)
        tap("pod-card-delete")
        waitUntilExists("delete-server-dialog")
        tapText("Cancel")
        waitGone("delete-server-dialog")
        assertTrue(textCount(music) > 0)
        assertTrue(comMock.releasedServerNames.isEmpty())
    }

    /** A device without the admin root lists the servers but can't reorder
     *  them, make one leader or delete one (`.com` would refuse its IRK). */
    @Test
    fun nonAdminRowMenuOnlyOpens() {
        launch(tab = "home", username = "bright-maple")
        longPressRow(office)
        waitText("Open")
        assertEquals(0, tagCount("pod-card-make-leader"))
        assertEquals(0, tagCount("pod-card-delete"))
        assertEquals(0, composeRule.onAllNodes(tagPrefix("home-server-handle-")).fetchSemanticsNodes().size)
        gymShot("non-admin-menu")
        tapText("Open")
        // Office's page: the order is read-only here too.
        waitUntilExists("sd-leader-admin-only", 20_000)
        assertEquals(0, tagCount("sd-make-leader"))
        assertEquals(1, tagCount("sd-server-admin-only"))
        gymShot("non-admin-server-page")
    }

    /** A server made to restore a backup waits for it: its menu sends it. */
    @Test
    fun awaitingBackupRowSendsTheBackup() {
        launch(tab = "home", adminRoot = true, username = "bright-maple", podsVariant = "awaiting-backup")
        waitText("Waiting for its backup", 20_000)
        longPressRow(home)
        tap("pod-card-send-backup")
        waitUntilExists("import-backup-choose")
        waitText("is waiting for its backup")
        gymShot("send-backup")
    }

    // ─── Server order ────────────────────────────────────────────────────────

    /** The row's accessibility action "Move down" reorders and signs once. */
    @Test
    fun moveDownActionReordersAndSigns() {
        launch(tab = "home", adminRoot = true, username = "bright-maple")
        waitText(home, 20_000)
        composeRule.waitUntil(15_000) { composeRule.onAllNodes(tagPrefix("home-server-handle-")).fetchSemanticsNodes().size >= 2 }
        val before = shownOrder()
        val first = before.first()
        val node = composeRule.onNode(row(first)).fetchSemanticsNode()
        val action = node.config[SemanticsActions.CustomActions].first { it.label == "Move down" }
        composeRule.runOnIdle { action.action() }
        assertSigned("server-order", "admin")
        eventually(what = "the first server moved down") { shownOrder().indexOf(first) == 1 }
        gymShot("moved-down")
        // And back up.
        val up = composeRule.onNode(row(first)).fetchSemanticsNode().config[SemanticsActions.CustomActions].first { it.label == "Move up" }
        composeRule.runOnIdle { up.action() }
        eventually(what = "back on top") { shownOrder().first() == first }
        assertEquals(2, mailboxMock.serverOrders.size)
    }

    /** Dragging a row by its handle below the next one saves the new order. */
    @Test
    fun dragHandleReorders() {
        launch(tab = "home", adminRoot = true, username = "bright-maple")
        waitText(home, 20_000)
        composeRule.waitUntil(15_000) { composeRule.onAllNodes(tagPrefix("home-server-handle-")).fetchSemanticsNodes().size >= 2 }
        val before = shownOrder()
        composeRule.onAllNodes(tagPrefix("home-server-handle-")).onFirst().performScrollTo()
        // Bring the handle clear of the tab bar so the drag stays on the list.
        composeRule.onAllNodes(androidx.compose.ui.test.hasScrollAction()).onFirst()
            .performTouchInput { swipeUp(startY = this.height * 0.7f, endY = this.height * 0.4f) }
        composeRule.waitForIdle()
        val handle = composeRule.onAllNodes(tagPrefix("home-server-handle-")).onFirst()
        // The rows settle as each server's state arrives (their height animates): drag only once the handle holds still.
        var last = handle.fetchSemanticsNode().boundsInRoot
        var stable = 0
        composeRule.waitUntil(20_000) {
            composeRule.waitForIdle()
            val now = handle.fetchSemanticsNode().boundsInRoot
            stable = if (now == last) stable + 1 else 0
            last = now
            stable >= 3
        }
        val height = handle.fetchSemanticsNode().size.height.toFloat()
        handle.performTouchInput {
            down(center)
            repeat(12) { moveBy(androidx.compose.ui.geometry.Offset(0f, height * 1.4f / 12)) }
            up()
        }
        assertSigned("server-order", "admin")
        eventually(what = "the dragged server second") { shownOrder().indexOf(before.first()) == 1 }
        gymShot("dragged")
    }

    // ─── Search and status chips ─────────────────────────────────────────────

    @Test
    fun searchAndStatusChipsFilterTheList() {
        launch(tab = "home")
        waitText(home, 20_000)
        composeRule.onNode(androidx.compose.ui.test.hasSetTextAction()).performTextInput("zzz")
        waitText("No servers match")
        gymShot("no-match")
        composeRule.onNode(androidx.compose.ui.test.hasSetTextAction()).performTextClearance()
        Espresso.closeSoftKeyboard()
        waitText(office)
        chip("Offline").performClick()
        eventually(what = "only Music") { textCount(music) > 0 && textCount(office) == 0 }
        gymShot("offline-chip")
        chip("All").performClick()
        waitText(office)
    }

    /** A status chip (the rows also carry their status, so leave them out). */
    private fun chip(label: String) = composeRule.onAllNodes(
        hasText(label, substring = true) and hasClickAction() and !hasText(home, substring = true) and
            !hasText(office, substring = true) and !hasText(music, substring = true),
    ).onFirst()

    // ─── Pod switcher ────────────────────────────────────────────────────────

    /** Picking another server in the switcher makes it the current one. */
    @Test
    fun podSwitcherPicksAnotherServer() {
        launch(tab = "apps")
        tap("pod-switcher", 15_000)
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodes(tagPrefix("pod-switcher-item-demo-office"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onAllNodes(tagPrefix("pod-switcher-item-demo-office"), useUnmergedTree = true).onFirst().performClick()
        composeRule.waitForIdle()
        eventually(what = "Office current") {
            composeRule.onAllNodes(
                androidx.compose.ui.test.hasTestTag("pod-switcher") and
                    androidx.compose.ui.test.hasAnyDescendant(hasText("Office")),
                useUnmergedTree = true,
            ).fetchSemanticsNodes().isNotEmpty()
        }
        gymShot("switched")
    }

    // ─── Slivers ─────────────────────────────────────────────────────────────

    /** The red trust sliver asks before continuing: Not now keeps it, Continue
     *  anyway signs the cert exception and marks it continuing. */
    @Test
    fun trustSliverAsksBeforeContinuing() {
        launch(tab = "home", trustUntrusted = true)
        tap("global-trust-bar")
        waitText("Continue anyway?")
        gymShot("trust-ask")
        tapText("Not now")
        waitTextGone("Continue anyway?")
        tap("global-trust-bar")
        tapText("Continue anyway")
        waitTextGone("Continue anyway?")
        eventually(what = "no error toast") { textCount("Couldn't continue") == 0 }
        gymShot("trust-continued")
    }

    /** The operations sliver opens the running build's chat. */
    @Test
    fun operationsSliverOpensTheChat() {
        launch(tab = "home", ops = true)
        tap("global-operations-bar")
        waitUntilExists("vibecode-envvar-send-btn", 20_000)
        gymShot("chat-from-sliver")
    }
}

