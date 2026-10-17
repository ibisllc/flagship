// GYM Android button sweep — sharing a server (flagship.smokeShares: an
// in-memory `.com`, boot worker and boxes). Owner side: a code that doesn't
// match, the level and the start-up / app-data switches, Remove and Keep, the
// sheet's options, its Copy link and Share. Co-manager side: notify me to
// start it, update it to an endorsed release, open a shared app, leave (Stay,
// then Leave). Each order is checked for its signer: the owner's admin root
// for grants and revokes, the share key for everything a co-manager signs.

package com.flagshipserver.app.gym

import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymShareTest : GymBase() {

    private val world get() = com.flagshipserver.app.core.MockServerShares.lastWorld!!

    private fun openOwnerCard() {
        launch(tab = "home", username = "bright-maple", shares = true, adminRoot = true)
        openServerFromHome("Living-room mini-PC")
        waitUntilExists("share-server-card", 30_000)
        composeRule.waitUntil(30_000) { composeRule.onAllNodes(tagPrefix("share-row-")).fetchSemanticsNodes().size >= 2 }
    }

    private fun texts(n: SemanticsNode): List<String> =
        (n.config.getOrNull(SemanticsProperties.Text)?.map { it.text } ?: emptyList()) + n.children.flatMap(::texts)

    /** The share row naming [label] (its tag carries the share id). */
    private fun rowTag(label: String): String {
        var tag = ""
        composeRule.waitUntil(15_000) {
            tag = composeRule.onAllNodes(tagPrefix("share-row-"), useUnmergedTree = true).fetchSemanticsNodes()
                .firstOrNull { n -> texts(n).any { it.startsWith(label) } }
                ?.config?.getOrNull(SemanticsProperties.TestTag).orEmpty()
            tag.isNotEmpty()
        }
        return tag
    }

    private fun inRow(row: String, tag: String) = hasTestTag(tag) and hasAnyAncestor(hasTestTag(row))

    // ─── Owner ───────────────────────────────────────────────────────────────

    /** "It doesn't" on a code that doesn't match revokes that share. */
    @Test
    fun ownerCodeDoesNotMatchRevokes() {
        openOwnerCard()
        val alex = rowTag("Alex accepted")
        composeRule.onNode(hasText("It doesn't") and hasAnyAncestor(hasTestTag(alex))).scrollIfNeeded().performClick()
        // Stopping a share asks first.
        waitText("Stop sharing with Alex?", 10_000)
        tap("share-remove-confirm")
        composeRule.waitUntil(15_000) { tagCount(alex) == 0 }
        gymShot("code-mismatch")
    }

    /** Changing Sam's level and switches re-signs Sam's grant with the
     *  owner's admin root each time. */
    @Test
    fun ownerChangesLevelAndSwitches() {
        openOwnerCard()
        val sam = rowTag("Sam")
        val id = sam.removePrefix("share-row-")
        composeRule.onNode(inRow(sam, "share-level-view")).scrollIfNeeded().performClick()
        assertSigned("share-grant", "admin")
        composeRule.waitUntil(15_000) {
            composeRule.onAllNodes(hasText("Can view", substring = true) and hasAnyAncestor(hasTestTag(sam)), useUnmergedTree = true)
                .fetchSemanticsNodes().isNotEmpty()
        }
        val grants = signedChecks().count { it == "share-grant:admin" }
        composeRule.onNodeWithTag("share-unlock-$id").scrollIfNeeded().performClick()
        eventually(what = "unlock re-signed") { signedChecks().count { it == "share-grant:admin" } > grants }
        composeRule.onNodeWithTag("share-unlock-$id").assertIsOn()
        val grants2 = signedChecks().count { it == "share-grant:admin" }
        composeRule.onNodeWithTag("share-data-$id").scrollIfNeeded().performClick()
        eventually(what = "data re-signed") { signedChecks().count { it == "share-grant:admin" } > grants2 }
        composeRule.onNodeWithTag("share-data-$id").assertIsOn()
        gymShot("sam-changed")
    }

    /** Remove asks first: Keep keeps Sam, Stop sharing revokes with the admin root. */
    @Test
    fun ownerRemovesAShare() {
        openOwnerCard()
        val sam = rowTag("Sam")
        val id = sam.removePrefix("share-row-")
        tap("share-remove-$id")
        waitText("Stop sharing with Sam?")
        tapText("Keep")
        waitTextGone("Stop sharing with Sam?")
        assertEquals(1, tagCount(sam))
        tap("share-remove-$id")
        tap("share-remove-confirm")
        assertSigned("share-revoke", "admin")
        composeRule.waitUntil(15_000) { tagCount(sam) == 0 }
        gymShot("sam-removed")
    }

    /** The sheet's options, then the link: Copy puts it on the clipboard,
     *  Share hands it to the share sheet, Done closes. A pending link shows
     *  on the card with its own Copy link and Cancel. */
    @Test
    fun ownerSheetOptionsCopyShareAndCancel() {
        openOwnerCard()
        tap("share-server-open")
        type("share-label", "Robin")
        tap("share-next")
        // Back returns to the name, Next again.
        tapText("Back")
        waitUntilExists("share-label")
        tap("share-next")
        tap("share-next")
        composeRule.onNodeWithTag("share-opt-unlock").performClick()
        composeRule.onNodeWithTag("share-opt-data").performClick()
        composeRule.onNodeWithTag("share-opt-unlock").assertIsOn()
        composeRule.onNodeWithTag("share-opt-data").assertIsOn()
        tap("share-create")
        waitUntilExists("share-link", 15_000)
        val link = textOfTag("share-link")
        tapText("Copy link")
        eventually(what = "clipboard") { clipboardText() == link }
        tapText("Share")
        eventually(what = "share sheet") { sharedTexts().contains(link) }
        gymShot("share-link")
        tapText("Done")
        waitGone("share-sheet")
        val robin = rowTag("Waiting for Robin")
        composeRule.onNode(hasText("Copy link") and hasAnyAncestor(hasTestTag(robin))).scrollIfNeeded().performClick()
        composeRule.onNode(hasText("Cancel") and hasAnyAncestor(hasTestTag(robin))).scrollIfNeeded().performClick()
        composeRule.waitUntil(15_000) { tagCount(robin) == 0 }
        assertSigned("share-revoke", "admin")
    }

    // ─── Co-manager ──────────────────────────────────────────────────────────

    private fun openGarageReady() {
        launch(tab = "home", username = "bright-maple", shares = true)
        waitUntilExists("home-shared-with-me", 30_000)
        composeRule.onNode(hasText("Garage") and androidx.compose.ui.test.hasClickAction()).scrollIfNeeded().performClick()
        // Garage is starting: approve it first, then its page fills in.
        tap("shared-approve-startup", 20_000)
        waitUntilExists("shared-apps", 30_000)
    }

    /** "Notify me when it needs to start" registers this phone's push for the
     *  share on `.com`, signed with the share key; off drops it. */
    @Test
    fun coManagerNotifyToStart() {
        launch(tab = "home", username = "bright-maple", shares = true)
        waitUntilExists("home-shared-with-me", 30_000)
        composeRule.onNode(hasText("Garage") and androidx.compose.ui.test.hasClickAction()).scrollIfNeeded().performClick()
        tap("shared-notices-switch", 20_000)
        assertSigned("share-push", "share")
        eventually(what = "push registered") { world.pushes.isNotEmpty() }
        composeRule.onNodeWithTag("shared-notices-switch").assertIsOn()
        gymShot("notices-on")
        composeRule.onNodeWithTag("shared-notices-switch").scrollIfNeeded().performClick()
        eventually(what = "push dropped") { world.pushes.isEmpty() }
        composeRule.onNodeWithTag("shared-notices-switch").assertIsOff()
    }

    /** At "Can manage" the co-manager moves the server to the endorsed
     *  release: Not now sends nothing, Update sends the share-key order. */
    @Test
    fun coManagerUpdatesTheServer() {
        openGarageReady()
        tap("shared-update-button", 20_000)
        tapText("Not now")
        assertTrue(world.updates.isEmpty())
        tap("shared-update-button")
        tap("shared-update-confirm")
        assertSigned("share-update", "share")
        eventually(what = "the update order") { world.updates == listOf("4b1e0c9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c") }
        gymShot("co-manager-update")
    }

    /** A shared app opens on its own page with Open <app>. */
    @Test
    fun coManagerOpensASharedApp() {
        openGarageReady()
        composeRule.waitUntil(20_000) { composeRule.onAllNodes(tagPrefix("shared-app-row-")).fetchSemanticsNodes().isNotEmpty() }
        composeRule.onAllNodes(tagPrefix("shared-app-row-")).fetchSemanticsNodes().first().let { n ->
            composeRule.onNodeWithTag(n.config[SemanticsProperties.TestTag]).scrollIfNeeded().performClick()
        }
        waitUntilExists("shared-app-open", 20_000)
        tap("shared-app-open")
        eventually(what = "the browser") { startedIntents.any { it.action == android.content.Intent.ACTION_VIEW } }
        gymShot("shared-app")
    }

    /** Leave asks first: Stay keeps it, Leave signs with the share key and the
     *  server leaves Home's shared list. */
    @Test
    fun coManagerLeavesAfterStay() {
        openGarageReady()
        tap("shared-leave")
        waitText("Leave Garage?")
        tapText("Stay")
        waitTextGone("Leave Garage?")
        tap("shared-leave")
        tap("shared-leave-confirm")
        assertSigned("share-leave", "share")
        eventually(15_000, "Garage gone") { textCount("Garage") == 0 || tagCount("shared-server") == 0 }
        gymShot("left")
    }
}
