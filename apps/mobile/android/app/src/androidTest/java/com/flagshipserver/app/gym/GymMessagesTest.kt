// GYM Android: voi.ci pages and Messages (docs/voici-and-messages.md §11), the Android twin of iOS GymMessages*.
// The mock `.com` (GymVoici / MockVoiciClient) runs the real checks: an admin device publishes its page after the
// rules and the linkability warning; a visitor's message arrives as a request, is answered and blocked; a device
// without the admin root keeps its change grayed until an admin publishes it; and "Sign in with Flagship" for Ana's
// page signs a delegation the browser accepts. NO BACKEND.

package com.flagshipserver.app.gym

import com.flagshipserver.app.core.GymVoici
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.VoiciMessages
import com.flagshipserver.app.core.voici.VoiciPage
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GymMessagesTest : GymBase() {
    private val visitor = ByteArray(32) { 0x4C }

    private fun account(): String = GymVoici.client.accounts.keys.first { it != GymVoici.OTHER }

    /** The Public switch at the top of Messages: the rules, then the one-time public warning, then the page. */
    private fun publishFirstPage() {
        waitUntilExists("page-public-switch")
        gymShot("messages-header-off")
        tap("page-public-switch")
        tap("voici-rules-agree")
        waitUntilExists("page-make-public")
        gymShot("page-public-warning")
        tap("page-make-public")
        eventually(15_000, "the page is published") { GymVoici.client.storedIndex(account()) != null }
    }

    @Test fun anAdminPublishesItsPageThenAnswersAndBlocksAVisitor() {
        launch(tab = "messages", adminRoot = true)
        waitUntilExists("messages-title", 20_000)
        gymShot("messages-empty")
        publishFirstPage()
        gymShot("messages-header-on")
        // In the editor every change is a draft until the one Publish bar.
        tap("messages-edit-page")
        tap("page-accept-messages")
        waitUntilExists("page-publish-bar")
        gymShot("page-editor-bar")
        tap("page-publish")
        eventually(15_000, "accepting") { VoiciPage.parseVoiciPageIndex(GymVoici.client.storedIndex(account()))?.body?.acceptsMessages == 1 }
        tap("nav-back")

        runBlocking { GymVoici.client.visitorWrites(account(), visitor, "Hi! Your photos on https://example.com/gallery are lovely.") }
        composeRule.onNode(androidx.compose.ui.test.hasTestTag("messages-title")).assertExists()
        tap("messages-segment-requests")
        eventually(15_000, "the request arrives") {
            runBlocking { com.flagshipserver.app.core.voici.VoiciCenter.shared!!.refreshInbox() }
            tagCount("messages-empty") == 0
        }
        gymShot("messages-request")
        tapMatching(tagPrefix("messages-row-"))
        waitUntilExists("thread-request-banner")
        type("thread-compose", "Thank you!")
        tap("thread-send")
        waitUntilExists("bubble-mine")
        assertEquals("Sent", textOfTag("bubble-status"))
        eventually(10_000, "the reply reached the mailbox") { GymVoici.client.sent.any { VoiciJs.str(it["kind"]) == "voici-reply" } }
        gymShot("thread-replied")

        tap("thread-menu")
        tap("thread-block")
        tap("thread-block-confirm")
        eventually(10_000, "blocked at .com") { GymVoici.client.blocks[account()].orEmpty().isNotEmpty() }
    }

    @Test fun turningThePageOffRemovesItAndOnBringsItBack() {
        launch(tab = "messages", adminRoot = true)
        waitUntilExists("messages-title", 20_000)
        publishFirstPage()
        tap("page-public-switch")
        tap("page-remove-confirm")
        eventually(15_000, "removed at .com") { account() in GymVoici.client.removed }
        tap("page-public-switch")
        eventually(15_000, "back, with no second warning") { account() !in GymVoici.client.removed && GymVoici.client.storedIndex(account()) != null }
    }

    @Test fun aDeviceWithoutTheAdminRootKeepsItsChangeGrayed() {
        launch(tab = "messages", adminRoot = false)
        waitUntilExists("messages-title", 20_000)
        waitUntilExists("page-admin-only")
        tap("messages-edit-page")
        waitUntilExists("page-warning")
        assertEquals("only an admin device has a Publish button", 0, tagCount("page-publish"))
        tap("page-new-post")
        type("post-text", "Written on the tablet")
        tap("post-save")
        waitUntilExists("page-waiting-admin")
        eventually(15_000, "handed to the drafts lane") { GymVoici.client.drafts[account()].orEmpty().isNotEmpty() }
        gymShot("page-editor-waiting")
    }

    @Test fun signInWithFlagshipForAnasPage() {
        launch(tab = "home", deepLink = GymVoici.signInLink())
        waitUntilExists("voici-signin-review", 20_000)
        assertTrue(textOfTag("voici-signin-question").contains("Ana"))
        assertTrue(textOfTag("voici-signin-code").contains("482 913"))
        gymShot("voici-signin-review")
        tap("voici-signin-approve")
        tapMatching(androidx.compose.ui.test.hasTestTag("voici-rules-agree"))
        waitUntilExists("voici-signin-done", 15_000)
        val req = GymVoici.lastRequest
        assertNotNull(req)
        val answer = VoiciJs.parseJson(GymVoici.delivered!!.decodeToString())
        val checked = VoiciMessages.checkVoiciSignInAnswer(answer, req!!, listOf(GymVoici.client.caPub), System.currentTimeMillis())
        assertTrue(checked.code, checked.ok)
        gymShot("voici-signin-done")
        tap("voici-signin-done-close")

        // Ana answers; the app (on open, no push) offers "You have a reply on voi.ci/ana-page".
        GymVoici.anaReplies()
        tap("tab-messages")
        eventually(15_000, "the reply notice") {
            runBlocking { com.flagshipserver.app.core.voici.VoiciCenter.shared!!.checkReplies() }
            tagCount("messages-reply-notice") > 0
        }
        assertTrue(textOfTag("messages-reply-notice").contains("voi.ci/${GymVoici.OTHER}"))
        gymShot("messages-reply-notice")
    }
}
