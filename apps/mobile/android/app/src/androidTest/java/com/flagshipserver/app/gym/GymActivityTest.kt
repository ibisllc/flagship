// GYM Android button sweep — Activity: the box's activity log merged with the
// account's events (the owner's own writes left out, a co-manager named),
// Refresh, the server filter, Open approvals and Open audit log (Load more).
// NO BACKEND: the mock box serves its log, the mock `.com` the account events.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.test.espresso.Espresso
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymActivityTest : GymBase() {

    private fun open() {
        launch(tab = "activity", username = "bright-maple")
        waitUntilExists("activity-title", 20_000)
    }

    private fun openSection(name: String) {
        tap("activity-section-$name", 20_000)
        waitUntilExists("activity-section-$name-body", 10_000)
    }

    /** Each title opens its list in place, one at a time; the box's log and the
     *  account's events are separate sections, a co-manager is named and the
     *  owner's own writes are left out; every row carries date and time. */
    @Test
    fun sectionsOpenOneAtATimeWithDatesAndTimes() {
        open()
        openSection("server")
        waitText("Server updated", 20_000)
        waitText("Backup ready")
        waitText("A shared person signed in by Sam")
        waitText("App installed")
        assertEquals("the owner's own writes stay out", 0, textCount("/api/screens/services"))
        assertEquals("the account's events wait in their own section", 0, textCount("A device joined the account"))
        val time = textOfTag("activity-row-time")
        assertTrue("date and time to the minute, got $time", Regex("^[A-Z][a-z]{2} \\d{1,2}, (\\d{4}, )?\\d{1,2}:\\d{2} [AP]M$").matches(time))
        gymShot("activity-server-open")
        openSection("account")
        waitText("A device joined the account")
        waitGone("activity-section-server-body")
        assertEquals("one open at a time", 0, textCount("Server updated"))
        gymShot("activity-account-open")
        tap("activity-section-account")
        waitGone("activity-section-account-body")
        tapText("Refresh")
        waitUntilExists("activity-section-server", 15_000)
    }

    /** A long log scrolls inside the section and pages in place: Load more
     *  until "That's everything." */
    @Test
    fun longLogsPageInPlace() {
        launch(tab = "activity", username = "bright-maple")
        screensMock.boxActivityFixture = (90 downTo 1).map {
            com.flagshipserver.app.api.BoxActivityEntry(seq = it, ts = 1_790_000_000_000L + it * 60_000L, action = "x", kind = "server.backup.created")
        }
        waitUntilExists("activity-title", 20_000)
        tapText("Refresh")
        openSection("server")
        // 90 rows are three full pages; the page after them comes back short.
        var rows = tagCount("activity-row-time")
        while (tagCount("activity-everything") == 0) {
            // The list scrolls inside the page: press the button by its action, wherever it sits.
            waitUntilExists("activity-load-more-server", 20_000)
            composeRule.onNodeWithTag("activity-load-more-server")
                .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
            val before = rows
            composeRule.waitUntil(20_000) { tagCount("activity-row-time") > before || tagCount("activity-everything") > 0 }
            rows = tagCount("activity-row-time")
        }
        waitUntilExists("activity-everything", 20_000)
        assertEquals(90, tagCount("activity-row-time"))
        gymShot("activity-everything")
    }

    /** "All servers" and one server: the server section names the one picked,
     *  account-wide rows stay either way. */
    @Test
    fun serverFilterKeepsAccountRows() {
        open()
        tap("pod-switcher")
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodes(tagPrefix("pod-switcher-item-demo-office"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onAllNodes(tagPrefix("pod-switcher-item-demo-office"), useUnmergedTree = true).onFirst().performClick()
        waitText("Server · Office", 15_000)
        openSection("account")
        waitText("A device joined the account", 15_000)
        gymShot("activity-office")
    }

    @Test
    fun openApprovals() {
        launch(tab = "activity", username = "bright-maple", podsVariant = "awaiting-unlock")
        waitUntilExists("activity-title", 20_000)
        openSection("approvals")
        // The list is in the section itself: no button to a separate page.
        waitUntilExists("activity-approvals-list", 15_000)
        assertTrue("No Open approvals button", textCount("Open approvals") == 0)
        assertTrue("No separate Approve server page", textCount("Approve server") == 0)
        // Settled: the requests, "Nothing waiting for you", or a plain failure with Try again.
        composeRule.waitUntil(20_000) {
            textCount("Nothing waiting for you") > 0 || textCount("Try again") > 0 ||
                composeRule.onAllNodesWithTag("secret-request-card").fetchSemanticsNodes().isNotEmpty()
        }
        gymShot("approvals")
    }

    /** An approval notification's link lands on Activity with Server approvals open. */
    @Test
    fun approvalLinkOpensTheSectionOnActivity() {
        launch(tab = "home", username = "bright-maple", podsVariant = "awaiting-unlock",
            deepLink = "https://flagshipserver.com/app/secret-requests")
        waitUntilExists("activity-title", 30_000)
        waitUntilExists("activity-section-approvals-body", 15_000)
        waitUntilExists("activity-approvals-list", 15_000)
        assertTrue("No separate Approve server page", textCount("Approve server") == 0)
        gymShot("approvals-link")
    }

    /** Approving a boot on a device that holds the admin root stores the auto-unlock
     *  lease (signed by the IRK, which is all the boot worker accepts), so the next
     *  boot unlocks itself; the card goes at once and no raw error shows. */
    @Test
    fun approvingStoresALeaseSoTheNextBootUnlocksItself() {
        launch(tab = "activity", username = "bright-maple", adminRoot = true)
        waitUntilExists("activity-title", 20_000)
        val domain = "kitchen.bright-maple.flagship.services"
        val issuedAt = System.currentTimeMillis()
        val irk = kotlinx.coroutines.runBlocking { com.flagshipserver.app.keystore.KeystoreIrkAccess().resolve("gym") }
        val stk = com.google.crypto.tink.subtle.Ed25519Sign.KeyPair.newKeyPair()
        val stkHex = com.flagshipserver.app.core.HexUtil.encode(stk.publicKey)
        val nonce = "cd".repeat(32)
        val sig = com.flagshipserver.app.core.HexUtil.encode(
            com.google.crypto.tink.subtle.Ed25519Sign(stk.privateKey).sign(
                com.flagshipserver.app.core.SecretRequest.canonicalBytes(
                    domain, stkHex, com.flagshipserver.app.core.SecretPurpose.UNLOCK_KEY, nonce, issuedAt,
                ),
            ),
        )
        mailboxMock.directory = listOf(com.flagshipserver.app.api.PodDirectoryEntry(serverDomain = domain, identityPubKey = stkHex))
        mailboxMock.sealedLuksKeyHex = com.flagshipserver.app.core.HexUtil.encode(
            com.flagshipserver.app.core.SecretSeal.sealForEd25519Recipient(ByteArray(64) { it.toByte() }, com.flagshipserver.app.core.HexUtil.decode(irk.pubHex)!!),
        )
        mailboxMock.pending = listOf(
            com.flagshipserver.app.api.PendingSecretRequest(
                serverDomain = domain, requestNonceHex = nonce, stkPub = stkHex, purpose = "unlock-key",
                issuedAt = issuedAt, requestSignature = sig, postedAt = issuedAt, expiresAt = issuedAt + 600_000,
            ),
        )
        tapText("Refresh", 15_000)
        openSection("approvals")
        waitUntilExists("secret-request-card", 20_000)
        gymShot("approvals-card")
        assertTrue("No lease yet: a restart would ask the phone", !mailboxMock.secondBoot(domain))
        tap("secret-request-approve", 15_000)
        eventually(20_000, "the boot worker took the lease") { mailboxMock.secondBoot(domain) }
        // The card is gone and nothing raw showed.
        composeRule.waitUntil(15_000) { composeRule.onAllNodesWithTag("secret-request-card").fetchSemanticsNodes().isEmpty() }
        assertTrue(textCount("HTTP 4") == 0 && textCount("already answered") == 0 && textCount("invalid lease signature") == 0)
        gymShot("approvals-after")
    }
}
