// GYM Android: the Social tab (docs/social-tab.md, docs/voici-and-messages.md §11), the Android twin of iOS GymMessages*.
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
import androidx.compose.ui.test.performTextReplacement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GymMessagesTest : GymBase() {
    private val visitor = ByteArray(32) { 0x4C }

    private fun account(): String = GymVoici.client.accounts.keys.first { it != GymVoici.OTHER }

    /** The Public switch in the title row: the rules, then the one-time public warning, then the page. */
    private fun publishFirstPage() {
        waitUntilExists("page-public-switch")
        gymShot("messages-header-off")
        tap("page-public-switch")
        tap("voici-rules-agree")
        waitUntilExists("page-make-public")
        waitUntilExists("page-first-publish-defaults")
        gymShot("page-public-warning")
        tap("page-make-public")
        eventually(15_000, "the page is published") { GymVoici.client.storedIndex(account()) != null }
    }

    @Test fun anAdminPublishesItsPageThenAnswersAndBlocksAVisitor() {
        launch(tab = "messages", adminRoot = true)
        waitUntilExists("social-title", 20_000)
        gymShot("social-profile-off")
        assertEquals("nothing unpublished, no bar", 0, tagCount("page-publish-bar"))
        publishFirstPage()
        gymShot("social-profile-on")
        assertEquals("the first publish turns messages on", 1, VoiciPage.parseVoiciPageIndex(GymVoici.client.storedIndex(account()))?.body?.acceptsMessages)
        // Every change is a draft until the one Publish bar, which shows only while something is unpublished. Off and
        // on again is no change, so the bar goes.
        tap("page-options")
        tap("page-accept-messages")
        tap("page-options-done")
        waitUntilExists("page-publish-bar")
        tap("page-options")
        tap("page-accept-messages")
        tap("page-options-done")
        eventually(10_000, "off and on again leaves nothing to publish") { tagCount("page-publish-bar") == 0 }
        tap("page-options")
        tap("page-accept-messages")
        tap("page-options-done")
        waitUntilExists("page-publish-bar")
        gymShot("social-publish-bar")
        tap("page-publish")
        eventually(15_000, "not accepting") { VoiciPage.parseVoiciPageIndex(GymVoici.client.storedIndex(account()))?.body?.acceptsMessages == 0 }
        eventually(15_000, "the bar goes once published") { tagCount("page-publish-bar") == 0 }
        tap("page-options")
        tap("page-accept-messages")
        tap("page-options-done")
        tap("page-publish")
        eventually(15_000, "accepting again") { VoiciPage.parseVoiciPageIndex(GymVoici.client.storedIndex(account()))?.body?.acceptsMessages == 1 }
        eventually(15_000, "the bar goes once published") { tagCount("page-publish-bar") == 0 }

        runBlocking { GymVoici.client.visitorWrites(account(), visitor, "Hi! Your photos on https://example.com/gallery are lovely.") }
        tap("social-tab-requests")
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

    /**
     * docs/voici-calls.md §8: the first publish turns calls on for signed-in callers (owner decision 2026-11-16; a v2
     * index), Page options shows it, and the thread can allow a caller.
     */
    @Test fun anAdminTurnsCallsOnAndAllowsAVisitorToCall() {
        launch(tab = "messages", adminRoot = true)
        waitUntilExists("social-title", 20_000)
        publishFirstPage()
        eventually(15_000, "calls on at .com") {
            VoiciPage.parseVoiciPageIndex(GymVoici.client.storedIndex(account()))?.body?.let { it.acceptsCalls == 1 && it.callsFrom == "signed-in" } == true
        }
        tap("page-options")
        waitUntilExists("page-calls-from")
        waitUntilExists("page-calls-from-signed-in")
        waitUntilExists("calls-dnd")
        gymShot("calls-settings")
        tap("page-options-done")

        runBlocking { GymVoici.client.visitorWrites(account(), visitor, "Can I call you?") }
        tap("social-tab-requests")
        eventually(15_000, "the request arrives") {
            runBlocking { com.flagshipserver.app.core.voici.VoiciCenter.shared!!.refreshInbox() }
            tagCount("messages-empty") == 0
        }
        tapMatching(tagPrefix("messages-row-"))
        tap("thread-menu")
        tap("thread-allow-calls")
        eventually(10_000, "the signed allow reached .com") { GymVoici.client.callAllows.any { VoiciJs.str(it["op"]) == "allow" } }
    }

    @Test fun theNameIsEditedThroughItsPencilAndPublishedFromTheBar() {
        launch(tab = "messages", adminRoot = true)
        waitUntilExists("social-title", 20_000)
        publishFirstPage()
        val before = VoiciPage.parseVoiciPageIndex(GymVoici.client.storedIndex(account()))!!.body.seq
        tap("page-edit-name")
        waitUntilExists("page-display-name")
        composeRule.onNode(androidx.compose.ui.test.hasTestTag("page-display-name")).performTextReplacement("River Otter")
        composeRule.waitForIdle()
        tap("page-edit-done")
        waitUntilExists("page-publish-bar")
        assertTrue(textOfTag("page-name-text").contains("River Otter"))
        tap("page-publish")
        eventually(15_000, "the name is published") { (VoiciPage.parseVoiciPageIndex(GymVoici.client.storedIndex(account()))?.body?.seq ?: 0) > before }
        eventually(15_000, "the bar goes") { tagCount("page-publish-bar") == 0 }
    }

    @Test fun turningThePageOffRemovesItAndOnBringsItBack() {
        launch(tab = "messages", adminRoot = true)
        waitUntilExists("social-title", 20_000)
        publishFirstPage()
        tap("page-public-switch")
        tap("page-remove-confirm")
        eventually(15_000, "removed at .com") { account() in GymVoici.client.removed }
        tap("page-public-switch")
        eventually(15_000, "back, with no second warning") { account() !in GymVoici.client.removed && GymVoici.client.storedIndex(account()) != null }
    }

    @Test fun aDeviceWithoutTheAdminRootKeepsItsChangeGrayed() {
        launch(tab = "messages", adminRoot = false)
        waitUntilExists("social-title", 20_000)
        waitUntilExists("page-admin-only")
        assertEquals("only an admin device has a Publish button", 0, tagCount("page-publish"))
        tap("page-new-post-open")
        type("post-text", "Written on the tablet")
        tap("post-save")
        waitUntilExists("page-waiting-admin")
        eventually(15_000, "handed to the drafts lane") { GymVoici.client.drafts[account()].orEmpty().isNotEmpty() }
        assertEquals("only an admin device has a Publish button", 0, tagCount("page-publish"))
        gymShot("social-waiting-admin")
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
        tap("social-tab-inbox")
        eventually(15_000, "the reply notice") {
            runBlocking { com.flagshipserver.app.core.voici.VoiciCenter.shared!!.checkReplies() }
            tagCount("messages-reply-notice") > 0
        }
        assertTrue(textOfTag("messages-reply-notice").contains("voi.ci/${GymVoici.OTHER}"))
        gymShot("messages-reply-notice")
    }

    /**
     * docs/voici-calls.md "Calling from the app": after signing in to Ana's page, the reply notice and Social → Calls
     * call her. This build has no media engine, so the call is handed to a voi.ci tab over /qr-pipe (a scripted pipe
     * here), and the call history keeps it on this device.
     */
    @Test fun callingAnasPageFromTheAppHandsTheCallToTheBrowser() {
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation
            .grantRuntimePermission(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext.packageName, android.Manifest.permission.RECORD_AUDIO)
        launch(tab = "home", deepLink = GymVoici.signInLink())
        waitUntilExists("voici-signin-review", 20_000)
        tap("voici-signin-approve")
        tapMatching(androidx.compose.ui.test.hasTestTag("voici-rules-agree"))
        waitUntilExists("voici-signin-done", 15_000)
        tap("voici-signin-done-close")
        GymVoici.anaTakesCalls()
        GymVoici.anaReplies()
        var handed: Pair<String, com.flagshipserver.app.core.voici.VoiciCallHandoffSealed>? = null
        var opened: String? = null
        val livePipe = com.flagshipserver.app.calls.VoiciOutgoingCalls.pipeFactory
        com.flagshipserver.app.calls.VoiciOutgoingCalls.pipeFactory = {
            object : com.flagshipserver.app.calls.VoiciCallHandoffPipe {
                override suspend fun deliver(sid: String, sealed: com.flagshipserver.app.core.voici.VoiciCallHandoffSealed, openBrowser: () -> Unit) {
                    openBrowser()
                    handed = sid to sealed
                }
            }
        }
        com.flagshipserver.app.calls.VoiciOutgoingCalls.openBrowserOverride = { opened = it }
        try {
            tap("tab-messages")
            tap("social-tab-inbox")
            eventually(15_000, "the reply notice") {
                runBlocking { com.flagshipserver.app.core.voici.VoiciCenter.shared!!.checkReplies() }
                tagCount("reply-notice-call-audio") > 0
            }
            tap("reply-notice-call-audio")
            // The call-back pop-up: allowing it attaches the conversation's ring-back channel at .com.
            tap("reply-notice-call-allow-back")
            eventually(15_000, "the channel is attached") { GymVoici.client.ringBackOrders.isNotEmpty() }
            eventually(20_000, "handed to the browser") { handed != null }
            assertTrue(opened!!.startsWith("https://voi.ci/${GymVoici.OTHER}#call=${handed!!.first}."))
            waitUntilExists("outgoing-call-status")
            gymShot("calls-outgoing-browser")
            tap("outgoing-call-close")
            tap("social-call-button")
            waitUntilExists("calls-target", 15_000)
            waitUntilExists("calls-row", 15_000)
            assertTrue(textOfTag("calls-row").contains("voi.ci/${GymVoici.OTHER}"))
            gymShot("calls-history")
        } finally {
            com.flagshipserver.app.calls.VoiciOutgoingCalls.pipeFactory = livePipe
            com.flagshipserver.app.calls.VoiciOutgoingCalls.openBrowserOverride = null
        }
    }
}
